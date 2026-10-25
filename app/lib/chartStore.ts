import type {
  ChartKind,
  ChartPayload,
  ChartSource,
  ChartTrack,
  ChartWeek,
} from "./chartTypes";

/**
 * The browser's copy of the last good chart for each country the user has
 * visited.
 *
 * The point is instant return visits: a reload used to discard everything the
 * hook had in memory, so the same country cost another cold upstream wait. This
 * is the tier that survives the reload; the in-process server cache and the
 * CDN's Cache-Control remain the tiers beneath it.
 *
 * One storage entry per country *and kind*, because the payload carries both
 * lists and each list is independently usable. A chart is written as a pair;
 * a pair that is missing a half is treated as corrupt, since one request always
 * produced both.
 *
 * Everything here is defensive on purpose. localStorage is user-writable, shared
 * with other versions of the app, and throws in private mode or when the quota is
 * full. A corrupt entry is deleted and refetched — it is never rendered, and it
 * never throws into a render.
 */

const PREFIX = "wts.chart.v1";
const KINDS: readonly ChartKind[] = ["songs", "videos"];
/** A persisted copy is served without a network revalidation, so it may only be
 *  shown as a recent chart. Eight hours matches the server's fresh tier. */
const TTL_MS = 8 * 60 * 60 * 1000;
/** Enough for the countries a session can realistically visit, small enough that
 *  20 tracks × 2 kinds × 24 countries stays far below a typical 5MB quota. */
const MAX_COUNTRIES = 24;

interface StoredKind {
  v: 1;
  country: string;
  kind: ChartKind;
  week: ChartWeek | null;
  source: ChartSource;
  fetchedAt: string;
  /** When this browser wrote the entry, not when the upstream was fetched. The
   *  TTL measures the copy's age; `fetchedAt` is what the provenance line shows. */
  savedAt: number;
  tracks: ChartTrack[];
}

function keyFor(country: string, kind: ChartKind): string {
  return `${PREFIX}:${country}:${kind}`;
}

function storage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

function remove(store: Storage | null, key: string): void {
  if (!store) return;
  try {
    store.removeItem(key);
  } catch {
    /* ignore */
  }
}

function removeCountry(store: Storage | null, country: string): void {
  for (const kind of KINDS) remove(store, keyFor(country, kind));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const TRENDS = new Set(["up", "down", "same", "new"]);

function isWeek(value: unknown): value is ChartWeek | null {
  if (value === null) return true;
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.start === "string" &&
    typeof value.end === "string"
  );
}

function isTrack(value: unknown): value is ChartTrack {
  if (!isRecord(value)) return false;
  return (
    typeof value.rank === "number" &&
    Number.isFinite(value.rank) &&
    typeof value.videoId === "string" &&
    value.videoId.length > 0 &&
    typeof value.title === "string" &&
    typeof value.artists === "string" &&
    typeof value.weeklyViews === "number" &&
    Number.isFinite(value.weeklyViews) &&
    typeof value.thumbnail === "string" &&
    (value.previousRank === null || typeof value.previousRank === "number") &&
    (value.weeksOnChart === null || typeof value.weeksOnChart === "number") &&
    typeof value.trend === "string" &&
    TRENDS.has(value.trend)
  );
}

function isStoredKind(value: unknown, country: string, kind: ChartKind): value is StoredKind {
  if (!isRecord(value)) return false;
  return (
    value.v === 1 &&
    value.country === country &&
    value.kind === kind &&
    (value.source === "live" || value.source === "stale") &&
    typeof value.fetchedAt === "string" &&
    !Number.isNaN(Date.parse(value.fetchedAt)) &&
    typeof value.savedAt === "number" &&
    Number.isFinite(value.savedAt) &&
    isWeek(value.week) &&
    Array.isArray(value.tracks) &&
    value.tracks.length <= 100 &&
    value.tracks.every(isTrack)
  );
}

/** Parse without trusting the result. Returns null for anything unreadable. */
function parse(store: Storage | null, key: string): unknown {
  if (!store) return null;
  try {
    const raw = store.getItem(key);
    return raw === null ? null : (JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

function readKind(country: string, kind: ChartKind): StoredKind | null {
  const store = storage();
  const key = keyFor(country, kind);
  const value = parse(store, key);
  if (!value) {
    // Only delete when there was something there; a miss is not corruption.
    if (store) {
      try {
        if (store.getItem(key) !== null) remove(store, key);
      } catch {
        /* ignore */
      }
    }
    return null;
  }
  if (!isStoredKind(value, country, kind)) {
    remove(store, key);
    return null;
  }
  const age = Date.now() - value.savedAt;
  // A savedAt in the future can only be a clock change or tampering. Allow a
  // minute of skew so a normal clock adjustment does not wipe the cache.
  if (age < -60_000 || age > TTL_MS) {
    remove(store, key);
    return null;
  }
  return value;
}

/**
 * The persisted payload for a country, or null when it is absent, expired, or
 * incomplete. A chart is only usable when both kinds survived: one request wrote
 * them together, so half a pair means something went wrong.
 */
export function readCharts(country: string): ChartPayload | null {
  const store = storage();
  if (!store) return null;
  const songs = readKind(country, "songs");
  const videos = readKind(country, "videos");
  if (!songs || !videos) {
    if (songs || videos) removeCountry(store, country);
    return null;
  }
  if (songs.fetchedAt !== videos.fetchedAt) {
    removeCountry(store, country);
    return null;
  }
  return {
    charted: true,
    country,
    week: songs.week,
    source: songs.source,
    fetchedAt: songs.fetchedAt,
    songs: songs.tracks,
    videos: videos.tracks,
  };
}

/** Drop the least recently written countries until the store fits its budget. */
function prune(store: Storage): void {
  let keys: string[];
  try {
    keys = [];
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (key?.startsWith(`${PREFIX}:`)) keys.push(key);
    }
  } catch {
    return;
  }

  const countries = new Map<string, { keys: string[]; savedAt: number }>();
  for (const key of keys) {
    const [prefix, country, kind] = key.split(":");
    if (prefix !== PREFIX || !country || (kind !== "songs" && kind !== "videos")) {
      remove(store, key);
      continue;
    }
    const entry = countries.get(country) ?? { keys: [], savedAt: 0 };
    entry.keys.push(key);
    const value = parse(store, key);
    if (isRecord(value) && typeof value.savedAt === "number" && Number.isFinite(value.savedAt)) {
      entry.savedAt = Math.max(entry.savedAt, value.savedAt);
    }
    countries.set(country, entry);
  }

  if (countries.size <= MAX_COUNTRIES) return;
  const oldest = [...countries.entries()].sort((a, b) => a[1].savedAt - b[1].savedAt);
  for (let i = 0; i < oldest.length - MAX_COUNTRIES; i++) {
    for (const key of oldest[i][1].keys) remove(store, key);
  }
}

function writeRecord(store: Storage, record: StoredKind): boolean {
  try {
    store.setItem(keyFor(record.country, record.kind), JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

/**
 * Persist a live or last-good chart. Uncharted payloads are not stored: they
 * carry no list, the coverage list already answers instantly, and a notice is
 * cheaper to regenerate than a record to keep.
 */
export function writeCharts(payload: ChartPayload): void {
  if (!payload.charted) return;
  const store = storage();
  if (!store) return;

  const savedAt = Date.now();
  const base = {
    v: 1 as const,
    country: payload.country,
    week: payload.week,
    source: payload.source,
    fetchedAt: payload.fetchedAt,
    savedAt,
  };
  const records: StoredKind[] = [
    { ...base, kind: "songs", tracks: payload.songs },
    { ...base, kind: "videos", tracks: payload.videos },
  ];

  // A full quota can fail on the second write. Drop this country's half-written
  // pair and trim the store back to its budget, then try once more; if it still
  // fails, drop our half-written pair and leave the cache alone.
  if (!records.every((record) => writeRecord(store, record))) {
    removeCountry(store, payload.country);
    prune(store);
    if (!records.every((record) => writeRecord(store, record))) {
      removeCountry(store, payload.country);
      return;
    }
  }
  prune(store);
}
