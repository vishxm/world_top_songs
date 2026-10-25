// Fast, deterministic check for the browser's persisted chart cache.
//
// `app/lib/chartStore.ts` deals with untrusted input (localStorage is
// user-writable and shared between app versions) and time (entries expire). Both
// are awkward to prove through the UI: corrupting a real store and waiting eight
// hours is not a test. Here the store is a plain in-memory Map and the clock is a
// variable, so every branch runs in milliseconds.
//
// The browser gate still proves the wiring: that a reload actually reads this
// store and writes it back. This gate is only about the store's own contract.
//
// Usage: node scripts/chart-store-check.mjs

const results = [];

function check(name, pass, detail = "") {
  results.push({ name, pass, detail });
}

/** Minimal localStorage: the store only uses length/key/getItem/setItem/removeItem. */
class MemoryStorage {
  #map = new Map();

  get length() {
    return this.#map.size;
  }

  key(index) {
    return [...this.#map.keys()][index] ?? null;
  }

  getItem(key) {
    return this.#map.has(key) ? this.#map.get(key) : null;
  }

  setItem(key, value) {
    this.#map.set(String(key), String(value));
  }

  removeItem(key) {
    this.#map.delete(key);
  }

  clear() {
    this.#map.clear();
  }

  keys() {
    return [...this.#map.keys()];
  }
}

const storage = new MemoryStorage();
let clock = Date.parse("2026-10-24T12:00:00.000Z");
const realNow = Date.now;
Date.now = () => clock;

globalThis.window = { localStorage: storage };
const { readCharts, writeCharts } = await import("../app/lib/chartStore.ts");

const PREFIX = "wts.chart.v1";
const TTL_MS = 8 * 60 * 60 * 1000;

const track = (rank) => ({
  rank,
  videoId: `vid${rank}`,
  title: `Track ${rank}`,
  artists: "Some Artist",
  weeklyViews: 10_000 - rank,
  thumbnail: "https://example.test/thumb.jpg",
  previousRank: rank === 1 ? null : rank + 1,
  weeksOnChart: rank,
  trend: rank === 1 ? "new" : "up",
});

const payload = (country = "US") => ({
  charted: true,
  country,
  week: { id: "2026-W43", start: "2026-10-18", end: "2026-10-24" },
  source: "live",
  fetchedAt: new Date(clock - 60_000).toISOString(),
  songs: [track(1), track(2)],
  videos: [track(1), track(2), track(3)],
});

const reset = () => {
  storage.clear();
  clock = Date.parse("2026-10-24T12:00:00.000Z");
};

// ---------------------------------------------------------------- round trip
reset();
const us = payload("US");
writeCharts(us);
const restored = readCharts("US");
check(
  "a written chart reads back intact after a reload",
  JSON.stringify(restored) === JSON.stringify(us),
  restored ? `${restored.songs.length} songs, ${restored.videos.length} videos` : "null"
);
check(
  "the store is keyed by country and kind",
  storage.keys().length === 2 &&
    storage.keys().every((key) => /^wts\.chart\.v1:US:(songs|videos)$/.test(key)),
  storage.keys().join(", ")
);
check("another country is a miss, not a neighbour's chart", readCharts("GB") === null, "");

// --------------------------------------------------------------- corruption
reset();
writeCharts(payload("US"));
storage.setItem(`${PREFIX}:US:songs`, "{not json");
check("unparseable storage is treated as a miss", readCharts("US") === null, "");
check(
  "a corrupt half is deleted along with its pair",
  !storage.keys().some((key) => key.startsWith(`${PREFIX}:US:`)),
  storage.keys().join(", ") || "empty"
);

reset();
writeCharts(payload("US"));
storage.setItem(
  `${PREFIX}:US:videos`,
  JSON.stringify({
    ...JSON.parse(storage.getItem(`${PREFIX}:US:videos`)),
    tracks: [{ rank: "one" }],
  })
);
check("a well-formed entry with the wrong shape is rejected", readCharts("US") === null, "");
check(
  "a rejected entry does not linger",
  storage.keys().length === 0,
  storage.keys().join(", ") || "empty"
);

reset();
writeCharts(payload("US"));
const [songsKey, videosKey] = storage.keys();
storage.removeItem(videosKey);
check("half a payload is unusable", readCharts("US") === null, "");
check(
  "the surviving half is cleaned up",
  storage.getItem(songsKey) === null,
  storage.keys().join(", ") || "empty"
);

// --------------------------------------------------------------------- TTL
reset();
writeCharts(payload("US"));
clock += TTL_MS - 1000;
check("an entry inside the TTL still reads", readCharts("US") !== null, "at TTL - 1s");
clock += 2000;
check("an entry past the TTL is a miss", readCharts("US") === null, "at TTL + 1s");
check(
  "an expired entry is deleted",
  storage.keys().length === 0,
  storage.keys().join(", ") || "empty"
);

reset();
writeCharts(payload("US"));
storage.setItem(
  `${PREFIX}:US:songs`,
  JSON.stringify({ ...JSON.parse(storage.getItem(`${PREFIX}:US:songs`)), savedAt: clock + 60 * 60 * 1000 })
);
check("an entry written by a future clock is rejected", readCharts("US") === null, "");

// ------------------------------------------------------------------ pruning
reset();
for (let i = 0; i < 30; i++) {
  clock += 1000;
  const iso = String.fromCharCode(65 + Math.floor(i / 26)) + String.fromCharCode(65 + (i % 26));
  writeCharts(payload(iso));
}
// Country keys are two characters by construction here, so count distinct ones.
const countries = new Set(storage.keys().map((key) => key.split(":")[1]));
check(
  "the store keeps a bounded number of countries",
  countries.size <= 24 && countries.size > 0,
  `${countries.size} countries, ${storage.keys().length} entries`
);
check(
  "the newest country survives and the oldest is evicted",
  storage.getItem(`${PREFIX}:AA:songs`) === null &&
    storage.getItem(`${PREFIX}:BD:songs`) !== null,
  `${[...countries].slice(0, 4).join(", ")} …`
);

// -------------------------------------------------------------- not a chart
reset();
writeCharts({ charted: false, country: "AD", reason: "no chart" });
check("an uncharted payload writes nothing", storage.keys().length === 0, "");

// ------------------------------------------------------------ storage errors
reset();
const realStorage = globalThis.window.localStorage;
const throwing = {
  get length() {
    throw new Error("denied");
  },
  key() {
    throw new Error("denied");
  },
  getItem() {
    throw new Error("denied");
  },
  setItem() {
    throw new Error("denied");
  },
  removeItem() {
    throw new Error("denied");
  },
};
globalThis.window.localStorage = throwing;
let threw = false;
try {
  writeCharts(payload("US"));
  readCharts("US");
} catch {
  threw = true;
}
check("a storage that throws cannot break the app", !threw, "");
globalThis.window.localStorage = realStorage;

// --------------------------------------------------------------- full quota
reset();
const realSetItem = storage.setItem.bind(storage);
let remaining = 1;
storage.setItem = (key, value) => {
  if (remaining-- <= 0) throw new Error("quota exceeded");
  realSetItem(key, value);
};
let quotaThrew = false;
try {
  writeCharts(payload("US"));
} catch {
  quotaThrew = true;
}
storage.setItem = realSetItem;
check("a full quota is handled without throwing", !quotaThrew, storage.keys().join(", ") || "empty");
check("an incomplete write is not left behind", readCharts("US") === null, "");

// ------------------------------------------------------------------- report
Date.now = realNow;
const failed = results.filter((result) => !result.pass);
for (const result of results) {
  console.log(`${result.pass ? "ok" : "FAIL"}  ${result.name}${result.detail ? ` — ${result.detail}` : ""}`);
}
console.log(`\n${results.length - failed.length}/${results.length} chart-store checks passed`);
if (failed.length > 0) process.exitCode = 1;
