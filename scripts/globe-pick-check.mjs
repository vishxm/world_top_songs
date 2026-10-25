// End-to-end gate for the things that can only be checked in a real browser.
//
// SCOPE — AND WHY IT IS SMALL
//
// This used to sweep hundreds of pixels one at a time, and took over 25 minutes.
// Nearly all of that was harness cost: every sample needed a synthetic pointer move
// plus a settled frame before the DOM could be read back, and headless WebGL is
// CPU-bound. The picking *rule* those pixels were testing now lives in
// `app/lib/pick.ts` and is covered exhaustively — and about a hundred times faster
// — by `scripts/globe-pick-geometry.mjs`, which needs no browser at all. Check the
// geometry there; reserve the browser for wiring that only exists at runtime:
//
//   1. hover actually reaches the header readout, and agrees with the live scene
//   2. ocean stays silent end-to-end (the far-side regression, through the UI),
//      including the screen-reader announcement
//   3. a selection repaints the caps when the pointer is off the canvas
//   4. the region rail dims other regions, a real mouse click applies the filter,
//      and the selection stays findable while its region is dimmed
//   5. the draw-call budget holds
//   6. the player's progress bar renders (a Tailwind v4 regression, see NowPlaying)
//   7. Media Session handlers are installed, so the MacBook transport keys land
//   8. one calm theme, with no theme switcher or theme handoff
//   9. back and forward restore the URL-selected country
//  10. bad country codes recover with an explanation, and unknown routes land on
//      the branded recovery screen
//  11. the country picker opens from every shortcut, matches names and ISO codes,
//      marks charted countries, and updates the URL
//  12. Surprise me only ever lands on a charted country
//  13. a selection parks the idle rotation, and the first real interaction ends it
//  14. the rail is not covered by the chart panel on a narrow laptop, and a
//      dimmed country is still selectable
//  15. the chart API contract over HTTP: one request returns 20 ranked songs
//      AND 20 videos, cache headers, stale-on-failure, a visible error with no
//      last good copy, an explicit no-chart payload, and no seed/borrowed data
//  16. the chart panel renders that payload with a quiet provenance line
//  17. a chart failure is visible, and retry actually refetches and recovers
//  18. the Songs/Videos tabs are a switch over the one payload — no second
//      request — and the active tab is in the URL and survives a reload
//  19. an uncharted country shows the explicit notice and no chart at all, and
//      its action opens the picker filtered to charted countries
//  20. first load starts and renders a chart while the map assets are still held
//  21. a reload renders the chart from browser storage with no chart request,
//      and fast enough to be the same frame the user sees
//  22. corrupt browser storage is discarded and refetched without breaking
//  23. hovering a charted country prefetches its chart, the click that follows
//      renders with no loading state and no request, an uncharted country
//      prefetches nothing, leaving aborts, and a drag never prefetches
//  24. on a phone the chart is a bottom sheet that folds to a peek bar, the peek
//      answers for loading / charted / no-chart, every selection path unfolds
//      it, an empty tap folds it, folding hands focus to the peek and reopening
//      hands it back, and a wide layout has no fold at all
//  25. layout coherence: the server's phone first paint is already the settled
//      sheet (measured with JavaScript disabled), the sheet, rail and camera all
//      read one `--sheet-h`, folding re-frames the globe by half the height it
//      gives back, the tablet breakpoint is a sheet rather than a rail with the
//      wrong reserve, and the player docks inside the sheet without covering the
//      list or the rail — including when only the player is left
//  26. focus and world view: selecting from a closer camera never moves outward
//      (the microstates), Escape and a wide empty tap return to the world
//      altitude while keeping `?c=`, pressing the selected country recentres it,
//      and a resize after Escape does not re-focus the country
//
// Run it against a dev server. Usage: node scripts/globe-pick-check.mjs [url]
import { chromium } from "playwright";
import { CHART_ISOS } from "../app/lib/countries.ts";
import { fmtWeek } from "../app/lib/format.ts";
import { NO_CHART_REASON } from "../app/lib/chartTypes.ts";
import { focusAltitude, worldAltitude } from "../app/lib/focus.ts";

const URL_ = process.argv[2] ?? "http://localhost:5173/?c=US";
const BASE = new URL(URL_).origin;
/** Pixels per axis step. Small on purpose — see SCOPE above. */
const STEP = 97;
/** How many land pixels must name a country. A smoke test, not a benchmark. */
const MIN_LAND = 12;
const MIN_OCEAN = 12;
/** Draw calls must stay in the hundreds, not the thousands. */
const MAX_CALLS = 1200;

const stage = (name) =>
  process.stderr.write(`  [${new Date().toISOString().slice(11, 19)}] ${name}\n`);

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const browser = await chromium.launch();

/**
 * Collect page errors, including the URL behind a bare "Failed to load
 * resource" message. Chromium reports a blocked subresource with no message
 * text, so without `location().url` a failed app module and a failed ad pixel
 * are indistinguishable — and the only safe way to filter the second is to
 * name the first.
 *
 * Chromium's own permissions-policy warning and the embedded YouTube player's
 * ad requests are environment noise, not app errors. Ad requests fail in
 * headless Chromium regardless of the page being tested.
 */
const watchErrors = (target, ignore = []) => {
  const errors = [];
  target.on("pageerror", (e) => errors.push(String(e).slice(0, 240)));
  target.on("console", (m) => {
    if (m.type() !== "error") return;
    const text = m.text();
    const url = m.location()?.url ?? "";
    if (/Permissions policy violation/.test(text)) return;
    if (/googleads\.g\.doubleclick\.net/.test(text)) return;
    // Chromium reports a blocked subresource with the host only in `location`,
    // not in the message text — so filtering the text alone let ad requests
    // fail the gate.
    if (/googleads\.g\.doubleclick\.net/.test(url)) return;
    if (ignore.some((pattern) => pattern.test(text))) return;
    errors.push(`${text.slice(0, 160)}${url ? ` @ ${url.slice(0, 200)}` : ""}`);
  });
  return errors;
};

const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const pageErrors = watchErrors(page);

// Record which Media Session actions the app subscribes to.
//
// Chrome exposes no way to read the installed handlers back, and headless
// Chromium does not turn synthesised key events into media-key actions at all — so
// neither "was a handler registered" nor "does the key arrive" can be observed the
// obvious way. Wrapping `setActionHandler` before any app code runs answers the
// first question exactly, and the transport buttons already cover whether the
// callbacks those handlers invoke actually work.
await page.addInitScript(() => {
  window.__msActions = [];
  const install = () => {
    const ms = navigator.mediaSession;
    if (!ms || ms.__wrapped) return;
    const original = ms.setActionHandler.bind(ms);
    ms.setActionHandler = (action, handler) => {
      window.__msActions.push(action);
      return original(action, handler);
    };
    ms.__wrapped = true;
  };
  install();
  // navigator.mediaSession can appear after the document starts in some builds.
  document.addEventListener("readystatechange", install, { once: true });
});

stage("opening " + URL_);
await page.goto(URL_, { waitUntil: "networkidle" });
await page.waitForFunction(() => !!window.__globe, null, { timeout: 30_000 });
// The loading copy hands over exactly when the caps exist, so this is also the
// point at which picking is live. Wait for the handover rather than guessing a
// duration, then let the one-shot crossfade finish.
await page.waitForFunction(
  () => {
    const el = document.querySelector("#stage-loading");
    return el?.getAttribute("aria-hidden") === "true" && getComputedStyle(el).opacity === "0";
  },
  null,
  { timeout: 30_000 }
);
stage("globe ready");

// ---------------------------------------------------------------------------
// 0b. The chart API contract, over real HTTP.
//
//     This is the payload the panel consumes, so it is asserted where it is
//     produced — including the two failure paths that only ever reach the UI as
//     "Stale" or "Couldn't load this chart". The route honours the failure header
//     only outside production (`upstreamFailureRequested`), which lets the stale
//     and no-last-good paths be exercised without pretending the upstream is
//     healthy or waiting for it to break.
//
//     One request must carry BOTH kinds. The tabs are a client-side switch over
//     this payload, so a `type` query that changed the body would reintroduce the
//     round trip the ticket exists to remove.
// ---------------------------------------------------------------------------
stage("checking the chart API contract");
const getChart = async (query, headers = {}) => {
  const res = await fetch(`${BASE}/api/charts?${query}`, { headers });
  return {
    status: res.status,
    cache: res.headers.get("cache-control") ?? "",
    body: await res.json().catch(() => null),
  };
};

const hasTrackAnatomy = (t) =>
  typeof t.videoId === "string" &&
  /^[\w-]{11}$/.test(t.videoId) &&
  !!t.title &&
  !!t.artists &&
  /^https:\/\//.test(t.thumbnail ?? "") &&
  ["up", "down", "same", "new"].includes(t.trend);

const isRankedTwenty = (tracks) =>
  Array.isArray(tracks) &&
  tracks.length === 20 &&
  tracks.every((t, i) => t.rank === i + 1 && hasTrackAnatomy(t));

const usChart = await getChart("country=US");
const usSongs = usChart.body?.songs;
const usVideos = usChart.body?.videos;
check(
  "HTTP: one request returns 20 ranked songs and 20 videos",
  usChart.status === 200 &&
    usChart.body?.charted === true &&
    usChart.body?.country === "US" &&
    usChart.body?.source === "live" &&
    typeof usChart.body?.fetchedAt === "string" &&
    !Number.isNaN(Date.parse(usChart.body.fetchedAt)) &&
    /^\d{4}-\d{2}-\d{2}$/.test(usChart.body?.week?.start ?? "") &&
    isRankedTwenty(usSongs) &&
    isRankedTwenty(usVideos) &&
    !("tracks" in usChart.body) &&
    !("kind" in usChart.body),
  `${usChart.status} ${usChart.body?.source} ${usSongs?.length} songs + ${usVideos?.length} videos, week ${usChart.body?.week?.start}`
);
check(
  "HTTP: the chart response is cacheable and never seeded or borrowed",
  /public/.test(usChart.cache) &&
    /max-age=\d+/.test(usChart.cache) &&
    /s-maxage=\d+/.test(usChart.cache) &&
    /stale-while-revalidate=\d+/.test(usChart.cache) &&
    usChart.body?.source !== "seed" &&
    !("fallback" in (usChart.body ?? {})) &&
    !("provider" in (usChart.body ?? {})),
  usChart.cache || "no Cache-Control"
);

const stale = await getChart("country=US&refresh=1", {
  "x-wts-upstream-failure": "1",
});
check(
  "HTTP: upstream failure serves the last good copy marked stale",
  stale.status === 200 &&
    stale.body?.source === "stale" &&
    stale.body?.fetchedAt === usChart.body?.fetchedAt &&
    isRankedTwenty(stale.body?.songs) &&
    isRankedTwenty(stale.body?.videos) &&
    /no-store/.test(stale.cache),
  `${stale.status} ${stale.body?.source}, fetchedAt ${stale.body?.fetchedAt}, cache "${stale.cache}"`
);

const refreshed = await getChart("country=US&refresh=1");
check(
  "HTTP: retry refetches and recovers to live",
  refreshed.status === 200 &&
    refreshed.body?.source === "live" &&
    Date.parse(refreshed.body?.fetchedAt ?? "") >= Date.parse(usChart.body?.fetchedAt ?? ""),
  `${refreshed.status} ${refreshed.body?.source}, ${refreshed.body?.fetchedAt}`
);

const noLastGood = await getChart("country=ZW&refresh=1", {
  "x-wts-upstream-failure": "1",
  "x-wts-clear-cache": "1",
});
check(
  "HTTP: upstream failure with no last good copy is a clear error",
  noLastGood.status === 502 &&
    typeof noLastGood.body?.error === "string" &&
    noLastGood.body.error.length > 10 &&
    /no-store/.test(noLastGood.cache),
  `${noLastGood.status} ${noLastGood.body?.error ?? ""}`
);

const uncharted = await getChart("country=AD");
check(
  "HTTP: an uncharted country returns an explicit no-chart payload",
  uncharted.status === 200 &&
    uncharted.body?.charted === false &&
    uncharted.body?.country === "AD" &&
    uncharted.body?.reason === NO_CHART_REASON &&
    // The payload is exactly these three keys: no songs, no videos, no week,
    // and no fallback/seed/provider field that could smuggle in another chart.
    JSON.stringify(Object.keys(uncharted.body ?? {}).sort()) ===
      JSON.stringify(["charted", "country", "reason"]) &&
    /public/.test(uncharted.cache) &&
    /stale-while-revalidate/.test(uncharted.cache),
  `${uncharted.status} charted=${uncharted.body?.charted}: ${uncharted.body?.reason}`
);

// ---------------------------------------------------------------------------
// 0a. The stage itself: the canvas fills its box at the right pixel ratio, the
//     sphere is matte and unlit, and the loading state has handed over.
// ---------------------------------------------------------------------------
const stageProbe = await page.evaluate(() => {
  const canvas = document.querySelector('section[aria-label="World globe"] canvas');
  const section = canvas?.closest("section");
  const box = section?.getBoundingClientRect();
  const rect = canvas?.getBoundingClientRect();
  const globe = { unlit: false, textured: false };
  let atmosphereVisible = 0;
  let rings = 0;
  window.__globe.scene().traverse((o) => {
    if (o.__globeObjType === "atmosphere" && o.visible) atmosphereVisible++;
    if (o.__globeObjType === "ring") rings++;
    if (o.__globeObjType === "globe") {
      for (const child of o.children) {
        if (!child.isMesh) continue;
        globe.unlit = child.material?.type === "MeshBasicMaterial";
        globe.textured = !!child.material?.map;
      }
    }
  });
  const loader = document.querySelector("#stage-loading");
  return {
    canvas: rect && { w: +rect.width.toFixed(1), h: +rect.height.toFixed(1) },
    stage: box && { w: +box.width.toFixed(1), h: +box.height.toFixed(1) },
    buffer: canvas && { w: canvas.width, h: canvas.height },
    dpr: Math.min(2, window.devicePixelRatio || 1),
    atmosphereVisible,
    rings,
    globe,
    loader: loader
      ? { hidden: loader.getAttribute("aria-hidden"), opacity: +getComputedStyle(loader).opacity }
      : null,
  };
});
check(
  "the canvas fills the stage box",
  !!stageProbe.canvas &&
    !!stageProbe.stage &&
    Math.abs(stageProbe.canvas.w - stageProbe.stage.w) <= 1 &&
    Math.abs(stageProbe.canvas.h - stageProbe.stage.h) <= 1,
  `canvas ${stageProbe.canvas?.w}x${stageProbe.canvas?.h}, stage ${stageProbe.stage?.w}x${stageProbe.stage?.h}`
);
check(
  "the canvas is sized in device pixels",
  !!stageProbe.buffer &&
    !!stageProbe.canvas &&
    Math.abs(stageProbe.buffer.w - stageProbe.canvas.w * stageProbe.dpr) <= 1 &&
    Math.abs(stageProbe.buffer.h - stageProbe.canvas.h * stageProbe.dpr) <= 1,
  `buffer ${stageProbe.buffer?.w}x${stageProbe.buffer?.h} at dpr ${stageProbe.dpr}`
);
check(
  "the sphere is matte and unlit, with no atmosphere or rings",
  stageProbe.globe.unlit &&
    !stageProbe.globe.textured &&
    stageProbe.atmosphereVisible === 0 &&
    stageProbe.rings === 0,
  `material ${stageProbe.globe.unlit ? "unlit" : "lit"}${stageProbe.globe.textured ? " textured" : ""}, ${stageProbe.atmosphereVisible} atmosphere, ${stageProbe.rings} rings`
);
check(
  "the loading state hands over to the scene",
  stageProbe.loader?.hidden === "true" && stageProbe.loader.opacity === 0,
  `aria-hidden=${stageProbe.loader?.hidden} opacity=${stageProbe.loader?.opacity}`
);

/**
 * The oracle, installed in the page.
 *
 * It deliberately drives the same pure rule the app uses (`app/lib/pick.ts`) —
 * that rule is exhaustively covered, with an independent point-in-polygon
 * oracle, by `scripts/globe-pick-geometry.mjs`. What only a browser can prove is
 * the wiring: that hover/click resolve against the FULL-LAND hit layer rather
 * than the pruned caps. A hit on `window.__globeHit` is therefore the only way
 * this gate can tell "ocean" from "a part the cap layer pruned".
 */
async function installOracle(target) {
  await target.evaluate(async () => {
    const THREE = await import("/node_modules/three/build/three.module.js");
    window.__THREE = THREE;
    const pick = await import("/app/lib/pick.ts");
    window.__pick = pick;
    const datumOf = (o) => {
      while (o) {
        const d = o.__data && o.__data.data;
        if (d && d.iso) return d;
        o = o.parent;
      }
      return null;
    };
    /**
     * `null` = ocean (the ray meets the planet but no country), `undefined` =
     * open sky (it meets neither). That distinction is what keeps the ocean
     * sample from silently including the void beyond the limb.
     */
    window.__oracle = (x, y, W, H) => {
      const layer = window.__globeHit;
      if (!layer) return undefined;
      const g = window.__globe;
      const rc = new THREE.Raycaster();
      rc.setFromCamera(new THREE.Vector2((x / W) * 2 - 1, -(y / H) * 2 + 1), g.camera());
      const hits = rc.intersectObjects(layer.children, false);
      const occluder = window.__pick.surfaceDistance(rc.ray);
      const hit = window.__pick.nearestUnoccluded(
        hits,
        occluder,
        window.__pick.PICK_EPSILON,
        (h) => h.object.userData.span ?? Infinity
      );
      if (hit) return hit.object.userData.iso;
      return Number.isFinite(occluder) ? null : undefined;
    };
    /**
     * Where a lat/lng lands on screen, using three-globe's own polar convention.
     * Only the gate uses this: a named island has no cap (that is the point), so
     * its click target can only be derived from the globe, not from the DOM.
     */
    window.__screenOf = (lat, lng, altitude = window.__pick.HIT_ALTITUDE) => {
      const g = window.__globe;
      const camera = g?.camera?.();
      const canvas = document.querySelector('section[aria-label="World globe"] canvas');
      if (!camera || !canvas) return null;
      const phi = ((90 - lat) * Math.PI) / 180;
      const theta = ((90 - lng) * Math.PI) / 180;
      const r = window.__pick.GLOBE_RADIUS * (1 + altitude);
      const v = new THREE.Vector3(
        r * Math.sin(phi) * Math.cos(theta),
        r * Math.cos(phi),
        r * Math.sin(phi) * Math.sin(theta)
      );
      v.project(camera);
      if (v.z > 1) return null;
      const box = canvas.getBoundingClientRect();
      return [
        Math.round(box.left + (v.x * 0.5 + 0.5) * box.width),
        Math.round(box.top + (-v.y * 0.5 + 0.5) * box.height),
      ];
    };
    // Exposed for the cap-material probes below, which must resolve the datum the
    // same way rather than assuming `__data` sits on the tagged object.
    window.__datumOf = datumOf;
    /**
     * The selection outline: identified by the palette's outline colour.
     *
     * Reports the geometry's bounding box, not its object identity, because the
     * assertion is that the outline traces the *new* country. Identity would
     * pass a rebuild that drew the old shape again, and would fail a correct
     * implementation that reuses the line object with fresh vertices.
     */
    window.__outlineState = () => {
      const wanted = getComputedStyle(document.documentElement)
        .getPropertyValue("--globe-cap-outline")
        .trim()
        .replace("#", "")
        .toLowerCase();
      let found = null;
      window.__globe.scene().traverse((o) => {
        if (found || !o.isLineSegments) return;
        const m = o.material;
        if (!m?.color || m.color.getHexString() !== wanted) return;
        const pos = o.geometry?.attributes?.position;
        let bbox = null;
        if (pos?.count) {
          const min = [Infinity, Infinity, Infinity];
          const max = [-Infinity, -Infinity, -Infinity];
          for (let i = 0; i < pos.count; i++) {
            for (let axis = 0; axis < 3; axis++) {
              const v = pos.getComponent(i, axis);
              if (v < min[axis]) min[axis] = v;
              if (v > max[axis]) max[axis] = v;
            }
          }
          bbox = [...min, ...max].map((v) => +v.toFixed(2)).join(",");
        }
        found = { points: pos?.count ?? 0, bbox };
      });
      return found;
    };
    /** Fill, lift and region of one country's cap — the hover/selection signal. */
    window.__capState = (iso) => {
      let out = null;
      window.__globe.scene().traverse((o) => {
        if (o.__globeObjType !== "polygon") return;
        const d = datumOf(o);
        if (!d || d.iso !== iso) return;
        const cap = o.children[0];
        const m = Array.isArray(cap.material) ? cap.material[1] : null;
        out = {
          opacity: m ? +m.opacity.toFixed(3) : null,
          hex: m ? m.color.getHexString() : null,
          lift: +cap.scale.x.toFixed(4),
          region: d.region ?? null,
          name: d.name ?? null,
        };
      });
      return out;
    };
  });
}

await installOracle(page);

const readHover = () =>
  page.evaluate(() => {
    const p = document.querySelector("header p");
    const m = p && /^([A-Z]{2})/.exec(p.textContent ?? "");
    // The hover announcement is its own live region, not the visible readout.
    const live = p?.querySelector("[aria-live]");
    const iso = m ? m[1] : "";
    return {
      iso,
      announcement: live?.textContent?.trim() ?? null,
      // The scene's own datum is the name the announcement should use, so the
      // gate does not depend on a second copy of the country list.
      name: iso && window.__capState ? (window.__capState(iso)?.name ?? null) : null,
    };
  });

// ---------------------------------------------------------------------------
// 0. A deep link must light its country on load, with no interaction at all.
//    Checked FIRST, before anything moves the pointer.
// ---------------------------------------------------------------------------
stage("checking cold-load deep link");
const deepLink = await page.evaluate(async () => {
  // three-globe finishes building the 266 caps asynchronously, so give it the same
  // runway a human would before judging it.
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let caps = 0;
  for (let i = 0; i < 40; i++) {
    caps = 0;
    window.__globe.scene().traverse((o) => {
      if (o.__globeObjType === "polygon") caps++;
    });
    if (caps > 0) break;
    await sleep(100);
  }
  await sleep(1200);
  const iso = new URLSearchParams(location.search).get("c");
  let state = null;
  window.__globe.scene().traverse((o) => {
    if (state || o.__globeObjType !== "polygon") return;
    const d = window.__datumOf(o);
    if (!d || d.iso !== iso) return;
    const cap = o.children[0];
    const m = Array.isArray(cap.material) ? cap.material[1] : null;
    state = { hex: m ? m.color.getHexString() : null, opacity: m ? +m.opacity.toFixed(3) : null };
  });
  return { iso, caps, state };
});
check(
  "deep link lights its country without interaction",
  deepLink.caps > 0 && !!deepLink.state && deepLink.state.opacity !== null && deepLink.state.opacity > 0.5,
  `${deepLink.iso}: ${deepLink.state?.hex}@${deepLink.state?.opacity} after ${deepLink.caps} caps (no pointer moved)`
);

// ---------------------------------------------------------------------------
// 1 + 2. Land pixels must name their country; ocean must stay silent.
// ---------------------------------------------------------------------------
stage("sampling pixels");
const samples = await page.evaluate(
  ([step]) => {
    const W = window.innerWidth;
    const H = window.innerHeight;
    const land = [];
    const ocean = [];
    for (let y = 120; y < H - 120; y += step) {
      for (let x = 120; x < W - 120; x += step) {
        const iso = window.__oracle(x, y, W, H);
        // `undefined` means the ray hit something that is neither a country cap nor
        // the globe (open sky). Those are excluded: the caps are lifted, so a
        // sliver of a near-limb country is legitimately visible against the sky.
        if (iso === null) ocean.push([x, y]);
        else if (iso) land.push([x, y, iso]);
      }
    }
    return { land, ocean };
  },
  [STEP]
);

stage(`sweeping ${samples.land.length} land, ${samples.ocean.length} ocean`);
const missed = [];
const mismatched = [];
const unannounced = [];
const untinted = [];
let lastTintedIso = null;
for (const [x, y] of samples.land) {
  await page.mouse.move(x, y);
  await page.waitForTimeout(70);
  const { iso: hovered, announcement, name } = await readHover();
  if (!hovered) {
    // Re-measure: if the scene has no cap here now, the sample list was stale.
    const still = await page.evaluate(([px, py]) => window.__oracle(px, py, innerWidth, innerHeight), [x, y]);
    if (still) missed.push(`${x},${y}(wants ${still})`);
    continue;
  }
  if (hovered !== samples.land.find((s) => s[0] === x && s[1] === y)[2]) {
    mismatched.push(`${x},${y}=${hovered}`);
  }
  // Hover has to be announced to a screen reader, and it has to be the country
  // under the pointer — not the visual chrome ("MX · Mexico select") and not the
  // country that was hovered a moment ago.
  if (!name || announcement !== name) {
    unannounced.push(`${hovered}=${JSON.stringify(announcement)} (wants ${JSON.stringify(name)})`);
  }
  // And it has to be a visible tint on the globe, not just a header readout.
  // Skipped for the selected country: selection colour outranks hover by design.
  if (hovered !== deepLink.iso) {
    const cap = await page.evaluate((want) => window.__capState(want), hovered);
    if (!cap || cap.opacity === null || cap.opacity < 0.4) {
      untinted.push(`${hovered}@${cap?.opacity}`);
    } else {
      lastTintedIso = hovered;
    }
  }
}

const ghost = [];
const spokenOnOcean = [];
for (const [x, y] of samples.ocean) {
  await page.mouse.move(x, y);
  await page.waitForTimeout(60);
  const { iso: hovered, announcement } = await readHover();
  if (hovered) ghost.push(`${x},${y}=${hovered}`);
  // "Ocean hover is silent." The live region must empty without speaking;
  // re-announcing the standing hint is the bug this guards against.
  if (announcement) spokenOnOcean.push(`${x},${y}=${JSON.stringify(announcement)}`);
}

const clearedTint = lastTintedIso
  ? await page.evaluate((want) => window.__capState(want), lastTintedIso)
  : null;

check(
  "land pixels name their country",
  samples.land.length >= MIN_LAND && missed.length === 0 && mismatched.length === 0,
  `${samples.land.length} sampled, ${missed.length} missed ${missed.slice(0, 4).join(" ")}, ${mismatched.length} wrong ${mismatched.slice(0, 4).join(" ")}`
);
check(
  "hover paints a quiet tint on the hovered country",
  samples.land.length > 0 && untinted.length === 0,
  `${samples.land.length} sampled, ${untinted.length} untinted ${untinted.slice(0, 4).join(" ")}`
);
check(
  "hover announces the country to assistive tech",
  samples.land.length > 0 && unannounced.length === 0,
  `${samples.land.length} sampled, ${unannounced.length} wrong ${unannounced.slice(0, 4).join(" ")}`
);
check(
  "ocean stays silent (no far-side picks)",
  samples.ocean.length >= MIN_OCEAN && ghost.length === 0,
  `${samples.ocean.length} sampled, ${ghost.length} far-side ${ghost.slice(0, 4).join(" ")}`
);
check(
  "ocean hover clears the tint and announces nothing",
  samples.ocean.length > 0 &&
    spokenOnOcean.length === 0 &&
    !!clearedTint &&
    clearedTint.opacity !== null &&
    clearedTint.opacity < 0.2,
  `${samples.ocean.length} sampled, ${spokenOnOcean.length} spoken, ` +
    `last hovered ${lastTintedIso} now @${clearedTint?.opacity}`
);

// ---------------------------------------------------------------------------
// 3. A selection must repaint the caps on its own.
// ---------------------------------------------------------------------------
stage("checking selection repaint");
const capState = (iso) => page.evaluate((want) => window.__capState(want), iso);

// Park the pointer off the globe so nothing repaints by accident. This is the case
// that used to break: the repaint hung off the hover, so selecting from the ⌘K
// palette, the region rail, Surprise me or the back button — all of which leave the
// pointer off the canvas — left the previous country lit and the new one unlit.
//
// Driven through the real picker. A synthetic `pushState` + `popstate` is not
// enough: React Router owns its own history index and ignores that sequence, so the
// app never changes selection and the check passes for the wrong reason.
await page.mouse.move(1400, 450);
const startIso = await page.evaluate(() => new URLSearchParams(location.search).get("c"));
await page.evaluate(() => document.querySelector('header button[aria-haspopup="dialog"]').click());
await page.waitForSelector('[role="listbox"][aria-label="Countries"] [role="option"]', {
  timeout: 10_000,
});
await page.evaluate(() => document.querySelector('[role="listbox"] [role="option"]').click());
await page.waitForTimeout(1800);
const selAfterPick = await page.evaluate(() => new URLSearchParams(location.search).get("c"));
const newCap = await capState(selAfterPick);
const oldCap = await capState(startIso);

// Assert the FILL, not the lift. `lift` cannot fail this check: three-globe applies
// `polygonAltitude` as the mesh scale itself, so the selected country reads 1.03
// whether or not the repaint ever ran — which is exactly how a genuinely broken
// repaint (caps not built yet when the effect fired, so a deep link loaded unlit)
// sailed through a gate that "verified" it for a whole session. Only the colour and
// opacity are written by `applyHoverVisuals`, so only they can prove it ran.
const repaint =
  !!startIso &&
  !!selAfterPick &&
  selAfterPick !== startIso &&
  !!newCap &&
  !!oldCap &&
  newCap.opacity !== null &&
  oldCap.opacity !== null &&
  newCap.opacity > 0.5 &&
  oldCap.opacity < 0.5;
check(
  "selection repaints the cap fill with the pointer off-canvas",
  repaint,
  `${startIso} -> ${selAfterPick}, new ${newCap?.hex}@${newCap?.opacity} lift ${newCap?.lift}, old ${oldCap?.hex}@${oldCap?.opacity} lift ${oldCap?.lift}`
);

// ---------------------------------------------------------------------------
// 4. The region rail. A chip is a real button: it must be hittable, the filter
//    must dim without hiding, and the selection must stay findable while its
//    own region is dimmed.
// ---------------------------------------------------------------------------
stage("checking region filter");
const selectedRegion = (await capState(selAfterPick))?.region;
const regionSetup = await page.evaluate(
  ({ selectionIso, selectionRegion }) => {
    const byRegion = new Map();
    window.__globe.scene().traverse((o) => {
      if (o.__globeObjType !== "polygon") return;
      const d = window.__datumOf(o);
      if (!d || !d.region || !d.iso) return;
      const list = byRegion.get(d.region) ?? [];
      if (!list.includes(d.iso)) list.push(d.iso);
      byRegion.set(d.region, list);
    });
    // Filter a region other than the selection's, so the selection itself has
    // to survive being dimmed.
    const filterRegion = Array.from(byRegion.keys()).find(
      (r) => r !== selectionRegion && (byRegion.get(r) ?? []).some((iso) => iso !== selectionIso)
    );
    const outIso = (byRegion.get(selectionRegion) ?? []).find((iso) => iso !== selectionIso);
    if (!filterRegion || !outIso) return { err: "not enough regions in the scene" };
    const inIso = byRegion.get(filterRegion).find((iso) => iso !== selectionIso);
    if (!inIso) return { err: `no second country in ${filterRegion}` };

    const chip = Array.from(document.querySelectorAll('nav[aria-label="Filter by region"] button')).find((b) =>
      (b.textContent || "").trim().startsWith(filterRegion)
    );
    if (!chip) return { err: `no chip for ${filterRegion}` };
    const box = chip.getBoundingClientRect();
    const x = Math.round(box.x + box.width / 2);
    const y = Math.round(box.y + box.height / 2);
    // A chip can be visible and still unclickable — the chart panel is a later
    // sibling at the same z-index, so whatever it covers is beneath it. The real
    // mouse click below is the proof that it is reachable; this records what a
    // hit test sees so a failure says why.
    const hit = document.elementFromPoint(x, y);
    return {
      filterRegion,
      inIso,
      outIso,
      chip: { x, y },
      topmost: hit === chip || chip.contains(hit),
      before: { in: window.__capState(inIso), out: window.__capState(outIso) },
    };
  },
  { selectionIso: selAfterPick, selectionRegion: selectedRegion }
);

/** Toggle the filter chip with a real mouse, on then off. */
const toggleRegionChip = async () => {
  await page.mouse.click(regionSetup.chip.x, regionSetup.chip.y);
  await page.waitForTimeout(700);
};

if (regionSetup.err) {
  check("region filter dims other regions", false, regionSetup.err);
  check("the selection stays findable while its region is dimmed", false, regionSetup.err);
} else {
  await toggleRegionChip();
  const filtered = await page.evaluate(
    ({ filterRegion, inIso, outIso }) => {
      const chip = Array.from(document.querySelectorAll('nav[aria-label="Filter by region"] button')).find((b) =>
        (b.textContent || "").trim().startsWith(filterRegion)
      );
      return {
        in: window.__capState(inIso),
        out: window.__capState(outIso),
        pressed: chip?.getAttribute("aria-pressed") ?? null,
      };
    },
    regionSetup
  );
  const selectionWhileDimmed = await capState(selAfterPick);
  await toggleRegionChip();
  const cleared = await page.evaluate(
    ({ inIso, outIso }) => ({ in: window.__capState(inIso), out: window.__capState(outIso) }),
    regionSetup
  );

  check(
    "region filter dims other regions",
    regionSetup.topmost &&
      filtered.in?.opacity === regionSetup.before.in?.opacity &&
      filtered.out?.opacity < regionSetup.before.out?.opacity &&
      filtered.pressed === "true" &&
      cleared.out?.opacity > filtered.out?.opacity,
    `${regionSetup.filterRegion}/${regionSetup.inIso} ${regionSetup.before.in?.opacity} -> ${filtered.in?.opacity} (kept), ` +
      `${selectedRegion}/${regionSetup.outIso} ${regionSetup.before.out?.opacity} -> ${filtered.out?.opacity} (dimmed) -> ${cleared.out?.opacity} (cleared), ` +
      `chip topmost ${regionSetup.topmost}, pressed ${filtered.pressed}`
  );
  check(
    "the selection stays findable while its region is dimmed",
    !!selectionWhileDimmed &&
      selectionWhileDimmed.opacity !== null &&
      selectionWhileDimmed.opacity > 0.5 &&
      selectionWhileDimmed.lift > 1.02 &&
      filtered.out?.opacity !== null &&
      filtered.out?.opacity < 0.1,
    `${selAfterPick}/${selectedRegion} ${selectionWhileDimmed?.hex}@${selectionWhileDimmed?.opacity} lift ${selectionWhileDimmed?.lift} ` +
      `while ${regionSetup.filterRegion} is filtered; peer ${regionSetup.outIso} at ${filtered.out?.opacity}`
  );
}

// ---------------------------------------------------------------------------
// 5. Draw calls. The other half of the regression: the old single-map globe spent
// ~8200 per frame; the two-layer build must stay in the hundreds.
// ---------------------------------------------------------------------------
const calls = await page.evaluate(() => window.__globe.renderer().info.render.calls);
check("draw calls stay bounded", calls > 0 && calls < MAX_CALLS, `${calls} (need < ${MAX_CALLS})`);

// ---------------------------------------------------------------------------
// 5b. Full-land click coverage and gesture tolerance.
//
// The geometry gate proves every source part is reachable by a ray. This proves
// the three runtime promises that only a real pointer can test: a pruned island
// is clickable, a shaky click falls back to where the press started, and a drag
// is never mistaken for a selection.
// ---------------------------------------------------------------------------
stage("checking full-land clicks and gestures");
const islandPage = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  reducedMotion: "reduce",
});
const islandErrors = watchErrors(islandPage);
// This page exists to prove globe picking, not charts. Answer the chart request
// with a quiet no-chart payload so 20 lazy thumbnails and their decodes stay out
// of the gesture window: the shake below is a few pixels, and a busy main thread
// can stretch it past CLICK_MAX_MS.
await islandPage.route(/\/api\/charts\?/, (route) =>
  route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      charted: false,
      country: "ZZ",
      reason: "Charts are not part of this globe check.",
    }),
  })
);
const waitForPicking = async (target) => {
  await target.waitForFunction(
    () =>
      !!window.__globeHit &&
      document.querySelector("#stage-loading")?.getAttribute("aria-hidden") === "true",
    null,
    { timeout: 30_000 }
  );
  await installOracle(target);
};
await islandPage.goto(`${BASE}/?c=BR`, { waitUntil: "networkidle" });
await waitForPicking(islandPage);

const ISLANDS = [
  ["Hawaii", 19.6, -155.55, "US"],
  ["Tenerife", 28.3, -16.6, "ES"],
  ["Azores", 37.78, -25.45, "PT"],
  ["Jeju", 33.5, 126.53, "KR"],
  ["Galapagos", -0.6, -90.5, "EC"],
];
const islandResults = [];
for (const [name, lat, lng, want] of ISLANDS) {
  await islandPage.evaluate(
    ({ lat, lng }) => window.__globe.pointOfView({ lat, lng, altitude: 0.45 }, 0),
    { lat, lng }
  );
  await islandPage.waitForTimeout(250);
  const point = await islandPage.evaluate(([lat, lng]) => window.__screenOf(lat, lng), [lat, lng]);
  const at = point
    ? await islandPage.evaluate(
        ([x, y]) => window.__oracle(x, y, innerWidth, innerHeight),
        point
      )
    : null;
  let selected = null;
  if (point && at === want) {
    await islandPage.mouse.click(point[0], point[1]);
    await islandPage
      .waitForFunction(
        (iso) => new URLSearchParams(location.search).get("c") === iso,
        want,
        { timeout: 5_000 }
      )
      .catch(() => {});
    selected = await islandPage.evaluate(() => new URLSearchParams(location.search).get("c"));
    // Let the route's focus flight land before the next camera reset, or the
    // still-pending flight would move the globe out from under the next click.
    // 500ms was enough on an idle page, but chart loads and image decodes can
    // stretch the tween; 1200ms is still cheap next to a mis-picked island.
    await islandPage.waitForTimeout(1200);
  }
  islandResults.push({ name, want, point, at, selected, ok: at === want && selected === want });
}
check(
  "pruned islands and territories are clickable from the globe",
  islandResults.length === ISLANDS.length && islandResults.every((r) => r.ok),
  islandResults
    .map((r) => `${r.name}: ${r.selected ?? "none"}${r.ok ? "" : ` (wants ${r.want}, point ${r.point}, oracle ${r.at})`}`)
    .join(", ")
);

// A shaky click: press on Singapore, move 9px (inside the 10px slop) onto water,
// release. The release pick misses, so the down position has to be used.
//
// The last island click started a chart request; if the list is still busy the
// main thread can stretch this two-event gesture past CLICK_MAX_MS even though a
// human flick takes a fraction of a second. Let that work settle first.
await islandPage
  .waitForFunction(
    () => !document.querySelector('section[aria-label$="chart"] [aria-busy="true"]'),
    null,
    { timeout: 20_000 }
  )
  .catch(() => {});

/**
 * Playwright drives every mouse step through the browser's event loop, so a
 * busy main thread can stretch this press past `CLICK_MAX_MS` even though the
 * same 9px flick from a human stays well inside it. That is a harness artefact,
 * not the behaviour under test — so the gesture is retried from a fresh camera a
 * bounded number of times.
 *
 * Retrying cannot turn a broken fallback into a pass: if the release position
 * is (wrongly) used, or the press is rejected for any reason other than its
 * measured duration, no attempt selects Singapore. The measured duration is
 * recorded on every attempt and reported with the result.
 */
const SHAKY = { lat: 1.35, lng: 103.82, altitude: 0.45 };
const resetShakyCamera = async () => {
  await islandPage.evaluate(
    (view) => window.__globe.pointOfView(view, 0),
    SHAKY
  );
  await islandPage.waitForTimeout(250);
};
await islandPage.evaluate(() => {
  window.__gestures = [];
  window.__gestureDown = null;
  document.addEventListener(
    "pointerdown",
    (e) => {
      window.__gestureDown = { at: e.timeStamp, x: e.clientX, y: e.clientY };
    },
    true
  );
  document.addEventListener(
    "pointerup",
    (e) => {
      const down = window.__gestureDown;
      if (!down) return;
      window.__gestures.push({
        ...down,
        upX: e.clientX,
        upY: e.clientY,
        ms: Math.round(e.timeStamp - down.at),
      });
      window.__gestureDown = null;
    },
    true
  );
});

const shakyAttempts = [];
for (let attempt = 0; attempt < 3; attempt++) {
  await resetShakyCamera();
  const down = await islandPage.evaluate((view) => window.__screenOf(view.lat, view.lng), SHAKY);
  let up = null;
  if (down) {
    for (const [dx, dy] of [[9, 0], [0, 9], [-9, 0], [0, -9], [7, 7], [-7, 7]]) {
      const candidate = [down[0] + dx, down[1] + dy];
      const water = await islandPage.evaluate(
        ([x, y]) => window.__oracle(x, y, innerWidth, innerHeight),
        candidate
      );
      if (water === null) {
        up = candidate;
        break;
      }
    }
  }
  if (!down || !up) {
    shakyAttempts.push({ down, up, downIso: null, picked: null, ms: null });
    break;
  }
  const downIso = await islandPage.evaluate(
    ([x, y]) => window.__oracle(x, y, innerWidth, innerHeight),
    down
  );
  const seen = await islandPage.evaluate(() => window.__gestures.length);
  await islandPage.mouse.move(down[0], down[1]);
  await islandPage.mouse.down();
  // One move step, not two. Each Playwright step waits on the page's frame
  // budget, and a stepped gesture is needlessly slower than the flick it models.
  await islandPage.mouse.move(up[0], up[1]);
  await islandPage.mouse.up();
  await islandPage.waitForTimeout(700);
  const gesture = await islandPage.evaluate((n) => window.__gestures[n] ?? null, seen);
  const picked = await islandPage.evaluate(() => new URLSearchParams(location.search).get("c"));
  shakyAttempts.push({ down, up, downIso, picked, ms: gesture?.ms ?? null });
  if (downIso === "SG" && picked === "SG") break;
}
check(
  "a shaky click selects the country under the press, not the release",
  shakyAttempts.length > 0 &&
    shakyAttempts.some((a) => a.downIso === "SG" && a.picked === "SG"),
  shakyAttempts
    .map(
      (a) =>
        `down ${a.down} ${a.downIso}, release ${a.up} (water), ${a.ms ?? "?"}ms, selected ${a.picked}`
    )
    .join(" | ") || "no gesture"
);

// A drag must not select. Land on Brazil, drag 80px, release over whatever is
// under the pointer, and assert the URL never moved.
await islandPage.evaluate(() =>
  window.__globe.pointOfView({ lat: -10, lng: -52, altitude: 0.6 }, 0)
);
await islandPage.waitForTimeout(250);
const dragDown = await islandPage.evaluate(() => window.__screenOf(-10, -52));
const dragDownIso = dragDown
  ? await islandPage.evaluate(([x, y]) => window.__oracle(x, y, innerWidth, innerHeight), dragDown)
  : null;
const selectionBeforeDrag = await islandPage.evaluate(() =>
  new URLSearchParams(location.search).get("c")
);
if (dragDown) {
  await islandPage.mouse.move(dragDown[0], dragDown[1]);
  await islandPage.mouse.down();
  await islandPage.mouse.move(dragDown[0] + 80, dragDown[1] + 40, { steps: 8 });
  await islandPage.mouse.up();
  await islandPage.waitForTimeout(900);
}
const dragPicked = await islandPage.evaluate(() => new URLSearchParams(location.search).get("c"));
check(
  "a drag rotates the globe without selecting a country",
  !!dragDown && dragDownIso === "BR" && dragPicked === selectionBeforeDrag,
  `down ${dragDown} ${dragDownIso}, selected before drag ${selectionBeforeDrag}, after ${dragPicked} (unchanged)`
);
check("no page errors on the full-land click page", islandErrors.length === 0, islandErrors.slice(0, 3).join(" | "));
await islandPage.close();

// ---------------------------------------------------------------------------
// 5c. Input during startup is queued, not dropped.
//
// Delay the hit-layer module so the globe and camera exist while picking is
// still not live — the exact window the old `pointer-events-none` wrapper made
// unreachable. A tap there must select once the layer finishes building.
// ---------------------------------------------------------------------------
stage("checking queued startup input");
const startupPage = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  reducedMotion: "reduce",
});
const startupErrors = watchErrors(startupPage);
let heldModule = false;
await startupPage.route("**/app/lib/hitLayer.ts*", async (route) => {
  heldModule = true;
  // Long enough that measuring the pre-tap state cannot race the build: the
  // point is to tap while picking is genuinely not live.
  await new Promise((resolve) => setTimeout(resolve, 8000));
  await route.continue();
});
await startupPage.goto(`${BASE}/?c=US`, { waitUntil: "domcontentloaded" });
await startupPage.waitForFunction(() => !!window.__globe, null, { timeout: 30_000 });
await installOracle(startupPage);
// The camera only reaches the selected country after the map state arrives.
const cameraFocused = await startupPage
  .waitForFunction(
    () => {
      const p = window.__globe?.pointOfView?.();
      return !!p && p.lat > 20 && p.lat < 60 && p.lng < -55 && p.lng > -135;
    },
    null,
    { timeout: 10_000 }
  )
  .then(() => true)
  .catch(() => false);
const canadaPoint = cameraFocused
  ? await startupPage.evaluate(() => window.__screenOf(55, -105))
  : null;
const preTap = await startupPage.evaluate(
  ([x, y]) => {
    const el = x ? document.elementFromPoint(x, y) : null;
    return {
      interactive: document.querySelector("#stage-loading")?.getAttribute("aria-hidden") === "true",
      hitLayer: !!window.__globeHit,
      hitTag: el ? `${el.tagName} ${String(el.className ?? "").slice(0, 40)}` : null,
    };
  },
  canadaPoint ?? [0, 0]
);
if (canadaPoint) await startupPage.mouse.click(canadaPoint[0], canadaPoint[1]);
const queuedSelection = await startupPage
  .waitForFunction(
    () => new URLSearchParams(location.search).get("c") === "CA",
    null,
    { timeout: 15_000 }
  )
  .then(() => true)
  .catch(() => false);
const startupSelected = await startupPage.evaluate(() =>
  new URLSearchParams(location.search).get("c")
);
check(
  "a tap during startup is queued and replayed",
  heldModule &&
    cameraFocused &&
    !!canadaPoint &&
    !preTap.interactive &&
    !preTap.hitLayer &&
    queuedSelection &&
    startupSelected === "CA",
  `module held ${heldModule}, camera ${cameraFocused}, point ${canadaPoint}, ` +
    `interactive ${preTap.interactive}, hit layer ${preTap.hitLayer}, topmost ${preTap.hitTag}, ` +
    `selected ${startupSelected}`
);
check("no page errors on the startup page", startupErrors.length === 0, startupErrors.slice(0, 3).join(" | "));
await startupPage.close();

// ---------------------------------------------------------------------------
// 6 + 7. The player. Both of these shipped broken and neither is about the globe.
// ---------------------------------------------------------------------------
stage("checking the player");
// This page has ended on whatever country the region-filter test selected,
// which may be uncharted — its panel deliberately has no list to play. Step
// back to the charted country the run started on, play from there, then return
// forward so the history assertions below still see the stack they expect.
await page.goBack();
await page.waitForFunction(
  (iso) => new URLSearchParams(location.search).get("c") === iso,
  startIso,
  { timeout: 10_000 }
);
await page.waitForFunction(
  () => document.querySelectorAll('section[aria-label$="chart"] ol li button').length > 0,
  null,
  { timeout: 20_000 }
);
await page.evaluate(() =>
  document.querySelector('section[aria-label$="chart"] ol li button').click()
);
await page.waitForTimeout(5000);
const player = await page.evaluate(() => {
  const bars = document.querySelectorAll("span.origin-left");
  const progress = bars[1];
  const buffered = bars[0];
  const time = Array.from(document.querySelectorAll("span.tnum")).find((s) =>
    /\d+:\d\d/.test(s.textContent)
  );
  return {
    // The Tailwind v4 trap: `scale-x-0` compiles to the standalone `scale` property,
    // which composes with an inline `transform` instead of being replaced by it, so
    // the bar collapsed to zero width while the time label and click-to-seek carried
    // on working. A rendered width above zero is the whole assertion.
    progressW: progress ? Math.round(progress.getBoundingClientRect().width) : null,
    trackW: progress && progress.parentElement ? Math.round(progress.parentElement.getBoundingClientRect().width) : null,
    bufferedW: buffered ? Math.round(buffered.getBoundingClientRect().width) : null,
    progressTransform: progress ? progress.style.transform : null,
    time: time ? time.textContent : null,
    hasMediaSession: !!navigator.mediaSession,
    metadata: navigator.mediaSession && navigator.mediaSession.metadata
      ? {
          title: navigator.mediaSession.metadata.title,
          artist: navigator.mediaSession.metadata.artist,
          artwork: navigator.mediaSession.metadata.artwork.length,
        }
      : null,
    playbackState: navigator.mediaSession ? navigator.mediaSession.playbackState : null,
  };
});
check(
  "player progress bar renders",
  player.progressW !== null && player.progressW > 0 && player.trackW > 0 && /scaleX\(0?\.\d*[1-9]/.test(player.progressTransform ?? ""),
  `progress ${player.progressW}px of ${player.trackW}px, buffered ${player.bufferedW}px, time ${player.time}`
);
check(
  "Media Session metadata set for the OS transport",
  player.hasMediaSession && !!player.metadata && !!player.metadata.title,
  player.metadata ? `${player.metadata.title} / ${player.metadata.artist} / ${player.metadata.artwork} artwork, state ${player.playbackState}` : "no metadata"
);

// Return to the selection the run left behind. The queue is session state, so
// moving country must not interrupt it — the media-key checks below rely on
// that, and so does the back/forward section.
await page.goForward();
await page.waitForFunction(
  (iso) => new URLSearchParams(location.search).get("c") === iso,
  selAfterPick,
  { timeout: 10_000 }
);

/**
 * The media keys themselves.
 *
 * Proved two ways, because neither alone is enough. `__msActions` records which
 * actions the page subscribed to — the MacBook's next/previous keys arrive as
 * `nexttrack`/`previoustrack`, and nothing happens at all without them, which is
 * exactly how this shipped broken. Then the transport is exercised through the UI
 * to show the callbacks those handlers invoke really do change the track.
 */
const registered = await page.evaluate(() => [...new Set(window.__msActions ?? [])]);
const WANTED = ["previoustrack", "nexttrack", "play", "pause", "seekbackward", "seekforward", "seekto"];
const missing = WANTED.filter((a) => !registered.includes(a));
check(
  "Media Session transport handlers installed",
  missing.length === 0,
  missing.length ? `missing ${missing.join(", ")} (registered: ${registered.join(", ") || "none"})` : `registered ${registered.join(", ")}`
);

const queueTitle = () =>
  page.evaluate(() => {
    const section = document.querySelector('section[aria-label="Now playing"]');
    if (!section) return null;
    // The title is the first truncating element in the player that has text.
    const el = Array.from(section.querySelectorAll('div[class*="truncate"], span[class*="truncate"]')).find(
      (n) => n.textContent.trim().length > 0
    );
    return el ? el.textContent.trim() : null;
  });
const before = await queueTitle();
const nextBtn = await page.evaluate(() => {
  const b = document.querySelector('button[aria-label="Next track"]');
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)];
});
if (nextBtn) await page.mouse.click(nextBtn[0], nextBtn[1]);
await page.waitForTimeout(1800);
const after = await queueTitle();
check(
  "next-track transport changes the track",
  !!before && !!after && before !== after,
  `${before} -> ${after}`
);

// ---------------------------------------------------------------------------
// 8. One theme. The four-palette switcher is gone, and the shell must boot
//    straight into the single calm token set — no `data-theme` handoff, no
//    swatches, no theme control hiding in the header.
// ---------------------------------------------------------------------------
stage("checking the single theme");
const themeState = await page.evaluate(() => {
  const root = document.documentElement;
  const css = getComputedStyle(root);
  const body = getComputedStyle(document.body);
  // Resolve the expected stage colour from the same token the shell uses, so
  // this does not hardcode a hex that a future palette tweak would break.
  const probe = document.createElement("span");
  probe.style.background = "var(--color-void)";
  document.body.appendChild(probe);
  const expectedBg = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return {
    dataTheme: root.getAttribute("data-theme"),
    swatches: document.querySelectorAll("[data-swatch]").length,
    paletteGroups: document.querySelectorAll(
      '[role="radiogroup"][aria-label*="palette" i], [role="radiogroup"][aria-label*="colour" i]'
    ).length,
    themeControls: Array.from(document.querySelectorAll("header button")).filter((b) =>
      /theme|palette|colour/i.test(b.getAttribute("aria-label") ?? "")
    ).length,
    bodyBg: body.backgroundColor,
    expectedBg,
    ink: css.getPropertyValue("--color-ink").trim(),
    accent: css.getPropertyValue("--color-accent").trim(),
    colorScheme: css.colorScheme,
  };
});
check(
  "one calm theme, with no theme switcher",
  themeState.dataTheme === null &&
    themeState.swatches === 0 &&
    themeState.paletteGroups === 0 &&
    themeState.themeControls === 0 &&
    themeState.bodyBg === themeState.expectedBg &&
    !!themeState.ink &&
    !!themeState.accent &&
    themeState.colorScheme === "dark",
  `data-theme=${themeState.dataTheme ?? "none"}, ${themeState.swatches} swatches, ` +
    `${themeState.paletteGroups} palette groups, ${themeState.themeControls} theme controls, ` +
    `body ${themeState.bodyBg} (token ${themeState.expectedBg}), ink ${themeState.ink}, accent ${themeState.accent}`
);

// ---------------------------------------------------------------------------
// 9. Back and forward are the other half of "the URL is the selection".
// ---------------------------------------------------------------------------
stage("checking back and forward");
await page.goBack();
await page.waitForFunction(
  (iso) => new URLSearchParams(location.search).get("c") === iso,
  startIso,
  { timeout: 10_000 }
);
await page.waitForTimeout(1200);
const backIso = await page.evaluate(() => new URLSearchParams(location.search).get("c"));
const backCap = await capState(startIso);
await page.goForward();
await page.waitForFunction(
  (iso) => new URLSearchParams(location.search).get("c") === iso,
  selAfterPick,
  { timeout: 10_000 }
);
await page.waitForTimeout(1200);
const forwardIso = await page.evaluate(() => new URLSearchParams(location.search).get("c"));
const forwardCap = await capState(selAfterPick);
check(
  "back and forward restore the selected country",
  backIso === startIso &&
    forwardIso === selAfterPick &&
    !!backCap &&
    backCap.opacity !== null &&
    backCap.opacity > 0.5 &&
    !!forwardCap &&
    forwardCap.opacity !== null &&
    forwardCap.opacity > 0.5,
  `${startIso} <- back ${backIso}@${backCap?.opacity}, forward ${forwardIso}@${forwardCap?.opacity}`
);

// ---------------------------------------------------------------------------
// 11 + 12. The country picker and Surprise me.
//
// The picker is the keyboard path to every country, so these are interaction
// assertions, not snapshot checks: the shortcuts must open it with the search
// focused, Escape must hand focus back, a query must match an ISO code that
// appears nowhere in the country's name, Enter must update the URL and close,
// and the charted/uncharted distinction must survive into the accessibility tree.
// ---------------------------------------------------------------------------
stage("checking the country picker");
const PICKER_TRIGGER = 'header button[aria-haspopup="dialog"]';
const PICKER_DIALOG = '[role="dialog"][aria-label="Pick a country"]';
const PICKER_INPUT = `${PICKER_DIALOG} input[role="combobox"]`;

const readPicker = async () => {
  await page.waitForTimeout(60);
  return page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"][aria-label="Pick a country"]');
    if (!dialog) return null;
    const input = dialog.querySelector('input[role="combobox"]');
    const options = Array.from(dialog.querySelectorAll('[role="option"]'));
    const activeId = input?.getAttribute("aria-activedescendant");
    const active = options.find((o) => o.id === activeId) ?? null;
    return {
      focus: document.activeElement === input,
      value: input?.value ?? null,
      activeLabel: active?.getAttribute("aria-label") ?? null,
      activeIso: active?.getAttribute("data-iso") ?? null,
      groups: Array.from(dialog.querySelectorAll('[role="group"]')).map((g) =>
        g.getAttribute("aria-label")
      ),
      labels: options.map((o) => o.getAttribute("aria-label")),
      status: dialog.querySelector('[role="status"]')?.textContent?.trim() ?? null,
      footer: dialog.lastElementChild?.textContent?.replace(/\s+/g, " ").trim() ?? "",
      text: dialog.textContent ?? "",
    };
  });
};

const readTrigger = () =>
  page.evaluate((sel) => {
    const trigger = document.querySelector(sel);
    return {
      focused: document.activeElement === trigger,
      expanded: trigger?.getAttribute("aria-expanded") ?? null,
    };
  }, PICKER_TRIGGER);

const openFrom = async (key) => {
  await page.keyboard.press(key);
  await page.waitForSelector(PICKER_DIALOG, { timeout: 5_000 });
  return readPicker();
};

// Focus the trigger explicitly: the gate has been clicking through native
// history, which leaves focus on the document rather than on any control.
await page.evaluate((sel) => document.querySelector(sel).focus(), PICKER_TRIGGER);

const metaOpen = await openFrom("Meta+k");
check(
  "⌘K opens the picker with the search focused",
  !!metaOpen?.focus && metaOpen.labels.length > 100,
  metaOpen ? `${metaOpen.labels.length} options, search focused ${metaOpen.focus}` : "no dialog"
);

await page.keyboard.press("Escape");
await page.waitForSelector(PICKER_DIALOG, { state: "detached", timeout: 5_000 });
const escaped = await readTrigger();
check(
  "Escape closes the picker and returns focus to its trigger",
  escaped.focused && escaped.expanded === "false",
  `focus ${escaped.focused}, aria-expanded ${escaped.expanded}`
);

const ctrlOpen = await openFrom("Control+k");
check("Ctrl-K opens the picker", !!ctrlOpen?.focus, ctrlOpen ? `search focused ${ctrlOpen.focus}` : "no dialog");

// Empty query: region groups, and a quiet charted/uncharted marker.
const usLabel = ctrlOpen?.labels.find((l) => l?.startsWith("United States,"));
const andorraLabel = ctrlOpen?.labels.find((l) => l?.startsWith("Andorra,"));
check(
  "empty query groups countries by region",
  (ctrlOpen?.groups.length ?? 0) >= 5 && !!ctrlOpen?.groups.includes("Africa"),
  ctrlOpen?.groups.join(", ")
);
check(
  "charted and uncharted countries are marked quietly",
  !!usLabel?.includes("has an official chart") &&
    !!andorraLabel?.includes("no official chart") &&
    /Charted/.test(ctrlOpen?.footer ?? "") &&
    /Uncharted/.test(ctrlOpen?.footer ?? "") &&
    !/Spotify|fallback/i.test(ctrlOpen?.text ?? ""),
  `${usLabel} / ${andorraLabel} / ${ctrlOpen?.footer}`
);

// ISO matching: "gb" is in neither "United Kingdom" nor its alias, so only the
// code can put it first.
await page.fill(PICKER_INPUT, "gb");
const isoMatch = await readPicker();
check(
  "typing an ISO code finds that country",
  !!isoMatch?.labels[0]?.startsWith("United Kingdom,"),
  isoMatch?.labels.slice(0, 3).join(" | ")
);

await page.fill(PICKER_INPUT, "cote");
const folded = await readPicker();
check(
  "typing without diacritics still finds the country",
  !!folded?.labels.some((l) => l?.startsWith("Côte d'Ivoire,")),
  folded?.labels.slice(0, 3).join(" | ")
);

await page.fill(PICKER_INPUT, "zzzzzz");
const nothing = await readPicker();
check(
  "no matches shows an empty state",
  nothing?.labels.length === 0 && /No country matches/.test(nothing.status ?? ""),
  `${nothing?.labels.length} options, status ${nothing?.status}`
);

// Arrows move the active option; Enter selects whichever option is active and
// the route writes it to the URL before the dialog closes.
await page.fill(PICKER_INPUT, "united");
const beforeArrow = await readPicker();
await page.keyboard.press("ArrowDown");
const afterArrow = await readPicker();
check(
  "arrow keys move the active option",
  !!beforeArrow?.activeLabel &&
    !!afterArrow?.activeLabel &&
    beforeArrow.activeLabel !== afterArrow.activeLabel,
  `${beforeArrow?.activeLabel} -> ${afterArrow?.activeLabel}`
);

await page.keyboard.press("Enter");
await page.waitForSelector(PICKER_DIALOG, { state: "detached", timeout: 5_000 });
await page.waitForTimeout(150);
const enterPick = await page.evaluate(() => new URLSearchParams(location.search).get("c"));
const enterTrigger = await readTrigger();
check(
  "Enter selects, closes the picker and updates the URL",
  !!afterArrow?.activeIso && enterPick === afterArrow.activeIso && enterTrigger.focused,
  `${afterArrow?.activeLabel} -> ?c=${enterPick}, focus ${enterTrigger.focused}`
);

const slashOpen = await openFrom("/");
check("slash opens the picker", !!slashOpen?.focus, slashOpen ? `search focused ${slashOpen.focus}` : "no dialog");

// The grouped (empty-query) order is region order, while the unfiltered result
// list is global alphabetical order. Selection must read from the order that is
// rendered, or Enter silently picks a country other than the highlighted one.
await page.keyboard.press("ArrowDown");
const groupedMoved = await readPicker();
check(
  "arrows move through the region-grouped order",
  !!slashOpen?.activeIso &&
    !!groupedMoved?.activeIso &&
    slashOpen.activeIso !== groupedMoved.activeIso,
  `${slashOpen?.activeLabel} -> ${groupedMoved?.activeLabel}`
);
await page.keyboard.press("Enter");
await page.waitForSelector(PICKER_DIALOG, { state: "detached", timeout: 5_000 });
await page.waitForTimeout(150);
const groupedPick = await page.evaluate(() => new URLSearchParams(location.search).get("c"));
check(
  "Enter selects the highlighted grouped option",
  !!groupedMoved?.activeIso && groupedPick === groupedMoved.activeIso,
  `${groupedMoved?.activeLabel} -> ?c=${groupedPick}`
);

stage("checking Surprise me");
const charted = new Set(CHART_ISOS);
const surprises = [];
for (let i = 0; i < 4; i++) {
  await page.evaluate(() => document.querySelector('button[aria-label="Surprise me"]').click());
  await page.waitForTimeout(120);
  surprises.push(await page.evaluate(() => new URLSearchParams(location.search).get("c")));
}
check(
  "Surprise me selects only charted countries",
  surprises.every((iso) => !!iso && charted.has(iso)),
  surprises.join(", ")
);

// ---------------------------------------------------------------------------
// 13. Idle rotation. A selection deliberately parks the globe, and the first
//     real interaction ends the invitation for good — so this needs a page that
//     has never been touched. Closing the chart programmatically keeps the
//     pointer out of the picture; the only real pointer move is the one that
//     must stop the spin.
// ---------------------------------------------------------------------------
stage("checking idle rotation");
check(
  "a selection parks the idle rotation",
  await page.evaluate(() => window.__globe.controls().autoRotate === false),
  "autoRotate false after a full run with a country selected"
);

check("no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));

// The page above has a live player attached; use a clean page for full-document
// navigations so a media teardown cannot be mistaken for a routing error.
await page.close();

const idlePage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const idleErrors = watchErrors(idlePage);
await idlePage.goto(`${BASE}/?c=US`, { waitUntil: "networkidle" });
await idlePage.waitForFunction(
  () => document.querySelector("#stage-loading")?.getAttribute("aria-hidden") === "true",
  null,
  { timeout: 30_000 }
);
await idlePage.evaluate(() => document.querySelector('button[aria-label="Close chart"]').click());
await idlePage.waitForFunction(() => !new URLSearchParams(location.search).get("c"), null, {
  timeout: 5_000,
});
const idleArmed = await idlePage
  .waitForFunction(() => window.__globe.controls().autoRotate === true, null, { timeout: 10_000 })
  .then(() => true)
  .catch(() => false);
await idlePage.mouse.move(720, 450);
await idlePage.waitForTimeout(150);
const idleStopped = await idlePage.evaluate(() => window.__globe.controls().autoRotate === false);
check(
  "idle rotation starts after a pause and stops on interaction",
  idleArmed && idleStopped,
  `armed ${idleArmed}, stopped ${idleStopped}`
);
check("no page errors on the idle page", idleErrors.length === 0, idleErrors.slice(0, 3).join(" | "));
await idlePage.close();

// ---------------------------------------------------------------------------
// 14. The rail on a narrow laptop. 1100px is inside the range where the rail
//    used to break: the last chips sat under the full-height chart panel, so
//    they were visible but unclickable — `elementFromPoint` over them returned
//    the chart's metadata line. The panel is a later sibling at the same
//    z-index, so only a real click at the chip's own coordinates proves the fix.
//    The same page then selects a *dimmed* country, proving the filter dims
//    without hiding or disabling.
// ---------------------------------------------------------------------------
stage("checking the rail on a narrow laptop");
const railPage = await browser.newPage({ viewport: { width: 1100, height: 800 } });
const railErrors = watchErrors(railPage);
await railPage.goto(`${BASE}/?c=US`, { waitUntil: "networkidle" });
await railPage.waitForFunction(() => !!window.__globe, null, { timeout: 30_000 });
await railPage.waitForFunction(
  () => document.querySelector("#stage-loading")?.getAttribute("aria-hidden") === "true",
  null,
  { timeout: 30_000 }
);
await railPage.waitForTimeout(1200);
await installOracle(railPage);

const chipBoxes = await railPage.evaluate(() => {
  const chips = Array.from(document.querySelectorAll('nav[aria-label="Filter by region"] button'));
  return chips.map((b) => {
    const r = b.getBoundingClientRect();
    const x = Math.round(r.x + r.width / 2);
    const y = Math.round(r.y + r.height / 2);
    const hit = document.elementFromPoint(x, y);
    return {
      label: (b.textContent || "").trim().replace(/\d+$/, "").trim(),
      x,
      y,
      topmost: hit === b || b.contains(hit),
      hitTag: hit === b ? null : `${hit?.tagName ?? "none"} ${String(hit?.className ?? "").slice(0, 50)}`,
    };
  });
});
const coveredChips = chipBoxes.filter((c) => !c.topmost);
check(
  "every region chip is reachable beside the chart panel on a narrow laptop",
  chipBoxes.length >= 7 && coveredChips.length === 0,
  `${chipBoxes.length} chips at 1100px, ${coveredChips.length} covered ` +
    coveredChips.slice(0, 3).map((c) => `${c.label}@${c.x},${c.y} (${c.hitTag})`).join(" ")
);

// The last chip is the one that used to disappear under the panel. Click it with
// a real mouse: a synthetic `element.click()` bypasses hit-testing and would
// happily pass a button no pointer can reach.
const lastChip = chipBoxes[chipBoxes.length - 1];
if (lastChip) await railPage.mouse.click(lastChip.x, lastChip.y);
await railPage.waitForTimeout(700);
const lastChipApplied = await railPage.evaluate(() => {
  const pressed = Array.from(document.querySelectorAll('nav[aria-label="Filter by region"] button'))
    .filter((b) => b.getAttribute("aria-pressed") === "true")
    .map((b) => (b.textContent || "").trim());
  return { pressed };
});
check(
  "a real mouse click on the last chip applies the region filter",
  !!lastChip &&
    lastChipApplied.pressed.length === 1 &&
    lastChipApplied.pressed[0].startsWith(lastChip.label),
  `${lastChip?.label} -> pressed ${lastChipApplied.pressed.join(", ") || "none"}`
);
if (lastChip) await railPage.mouse.click(lastChip.x, lastChip.y);
await railPage.waitForTimeout(400);

// A world view makes out-of-region land reachable for a real click.
await railPage.evaluate(() => window.__globe.pointOfView({ lat: 12, lng: -18, altitude: 2.2 }, 0));
await railPage.waitForTimeout(500);
const europeChip = chipBoxes.find((c) => c.label.startsWith("Europe"));
if (europeChip) await railPage.mouse.click(europeChip.x, europeChip.y);
await railPage.waitForTimeout(700);
const keptRegion = europeChip?.label ?? "Europe";
const outlineBefore = await railPage.evaluate(() => window.__outlineState());

const dimmedTarget = await railPage.evaluate((kept) => {
  const W = window.innerWidth;
  const H = window.innerHeight;
  const info = new Map();
  window.__globe.scene().traverse((o) => {
    if (o.__globeObjType !== "polygon") return;
    const d = window.__datumOf(o);
    if (d?.iso && d.region && !info.has(d.iso)) info.set(d.iso, { region: d.region, name: d.name });
  });
  const selected = new URLSearchParams(location.search).get("c");
  // Keep clear of the header, the region rail and the chart panel.
  for (let y = 120; y < 660; y += 40) {
    for (let x = 60; x < 660; x += 40) {
      const iso = window.__oracle(x, y, W, H);
      if (!iso || iso === selected) continue;
      const entry = info.get(iso);
      // The filtered-in region keeps its fill; every other region is dimmed, and
      // that dimming is the premise of the click below, so measure it here.
      if (!entry || entry.region === kept) continue;
      return { x, y, iso, region: entry.region, name: entry.name, opacityBefore: window.__capState(iso)?.opacity ?? null };
    }
  }
  return null;
}, keptRegion);
if (dimmedTarget) await railPage.mouse.click(dimmedTarget.x, dimmedTarget.y);
await railPage.waitForTimeout(1600);
const outlineAfter = await railPage.evaluate(() => window.__outlineState());
const afterDimmedClick = await railPage.evaluate(
  (iso) => ({
    c: new URLSearchParams(location.search).get("c"),
    cap: iso ? window.__capState(iso) : null,
    trigger: document.querySelector('header button[aria-haspopup="dialog"]')?.getAttribute("aria-label") ?? null,
    pressed: Array.from(document.querySelectorAll('nav[aria-label="Filter by region"] button'))
      .filter((b) => b.getAttribute("aria-pressed") === "true")
      .map((b) => (b.textContent || "").trim()),
  }),
  dimmedTarget?.iso ?? null
);
const expectedName = dimmedTarget?.name ?? null;
check(
  "a dimmed country is still selectable, and the picker follows",
  !!dimmedTarget &&
    dimmedTarget.opacityBefore !== null &&
    dimmedTarget.opacityBefore < 0.1 &&
    afterDimmedClick.c === dimmedTarget.iso &&
    !!afterDimmedClick.cap &&
    afterDimmedClick.cap.opacity !== null &&
    afterDimmedClick.cap.opacity > 0.5 &&
    afterDimmedClick.cap.lift > 1.02 &&
    afterDimmedClick.pressed.length === 1 &&
    afterDimmedClick.pressed[0].startsWith(keptRegion) &&
    !!expectedName &&
    (afterDimmedClick.trigger ?? "").includes(expectedName),
  dimmedTarget
    ? `${dimmedTarget.iso}/${dimmedTarget.region} @${dimmedTarget.opacityBefore} under ${keptRegion} -> ` +
      `?c=${afterDimmedClick.c} ${afterDimmedClick.cap?.hex}@${afterDimmedClick.cap?.opacity} lift ${afterDimmedClick.cap?.lift}, ` +
      `picker "${afterDimmedClick.trigger}"`
    : "no dimmed country was on screen to click"
);
check(
  "selecting on the globe redraws the selection outline",
  !!outlineBefore &&
    !!outlineAfter &&
    outlineAfter.points > 0 &&
    // The outline has to trace the newly selected country. A frozen outline
    // keeps its geometry, so an identical box is the failure this catches —
    // whether the line object was rebuilt or reused is not the claim.
    !!outlineAfter.bbox &&
    outlineAfter.bbox !== outlineBefore.bbox,
  `outline ${outlineBefore?.points} pts [${outlineBefore?.bbox}] -> ` +
    `${outlineAfter?.points} pts [${outlineAfter?.bbox}]`
);
check("no page errors on the rail page", railErrors.length === 0, railErrors.slice(0, 3).join(" | "));
await railPage.close();
const routePage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const routeErrors = watchErrors(routePage);

// ---------------------------------------------------------------------------
// 10. Bad links must land somewhere real and explain themselves. Unknown paths
//     must never fall through to the globe.
// ---------------------------------------------------------------------------
stage("checking bad country codes and the 404 route");
const readRouteState = () =>
  routePage.evaluate(() => ({
    c: new URLSearchParams(location.search).get("c"),
    notice:
      document.querySelector('section[aria-label$="chart"] [role="status"]')?.textContent?.trim() ?? null,
    panel: !!document.querySelector('section[aria-label$="chart"]'),
    globe: !!window.__globe,
    heading: document.querySelector("h1")?.textContent?.trim() ?? null,
    home: !!Array.from(document.querySelectorAll("a")).find((a) =>
      a.textContent?.includes("Back to the globe")
    ),
  }));

await routePage.goto(`${BASE}/?c=ZZ`, { waitUntil: "networkidle" });
await routePage.waitForFunction(() => !!window.__globe, null, { timeout: 30_000 });
await routePage.waitForFunction(
  () => {
    const c = new URLSearchParams(location.search).get("c");
    return !!c && c !== "ZZ";
  },
  null,
  { timeout: 10_000 }
);
await routePage.waitForTimeout(800);
const invalid = await readRouteState();
check(
  "invalid country code recovers with an explanation",
  !!invalid.c &&
    /^[A-Z]{2}$/.test(invalid.c) &&
    !!invalid.notice &&
    invalid.notice.includes("ZZ") &&
    /showing/i.test(invalid.notice) &&
    invalid.panel &&
    invalid.globe,
  `${invalid.c}: ${invalid.notice}`
);

await routePage.goto(`${BASE}/?c=`, { waitUntil: "networkidle" });
await routePage.waitForFunction(() => !!window.__globe, null, { timeout: 30_000 });
await routePage.waitForFunction(() => !!new URLSearchParams(location.search).get("c"), null, {
  timeout: 10_000,
});
await routePage.waitForTimeout(800);
const blank = await readRouteState();
check(
  "blank country code recovers with an explanation",
  !!blank.c &&
    /^[A-Z]{2}$/.test(blank.c) &&
    !!blank.notice &&
    /didn.t name a country/i.test(blank.notice) &&
    blank.panel &&
    blank.globe,
  `${blank.c}: ${blank.notice}`
);

await routePage.goto(`${BASE}/?c=us`, { waitUntil: "networkidle" });
await routePage.waitForFunction(
  () => new URLSearchParams(location.search).get("c") === "US",
  null,
  { timeout: 10_000 }
);
await routePage.waitForTimeout(400);
const canonical = await readRouteState();
check(
  "lower-case country code canonicalises and selects",
  canonical.c === "US" && canonical.panel && canonical.globe,
  `${canonical.c}, panel ${canonical.panel}`
);

await routePage.goto(`${BASE}/no-such-page`, { waitUntil: "networkidle" });
await routePage.waitForTimeout(600);
const notFoundState = await readRouteState();
check(
  "unknown route shows the branded recovery screen",
  !notFoundState.globe &&
    !!notFoundState.heading &&
    notFoundState.heading.includes("on the chart") &&
    notFoundState.home,
  `${notFoundState.heading}, globe ${notFoundState.globe}, home link ${notFoundState.home}`
);
await routePage.getByRole("link", { name: "Back to the globe" }).click();
await routePage.waitForFunction(() => !!window.__globe, null, { timeout: 30_000 });
await routePage.waitForTimeout(800);
const homeState = await readRouteState();
check(
  "the 404 recovery link returns home",
  new URL(routePage.url()).pathname === "/" && !!homeState.c && homeState.globe,
  routePage.url()
);

check("no routing page errors", routeErrors.length === 0, routeErrors.slice(0, 3).join(" | "));

// ---------------------------------------------------------------------------
// 15. The chart panel. The route contract above is only half the promise: the
//     panel has to show all 20 rows with the row anatomy the ticket names, and
//     the provenance line has to carry live/stale, the chart week and the fetch
//     time without becoming a badge.
//
//     Both tabs then have to be a pure switch over that one payload: no second
//     chart request, and the active kind has to live in the URL so a reload lands
//     back on it.
// ---------------------------------------------------------------------------
stage("checking the chart panel");
const chartRequests = [];
const countChartRequests = (request) => {
  const url = new URL(request.url());
  if (url.pathname === "/api/charts") chartRequests.push(url.search);
};
routePage.on("request", countChartRequests);

// The routing checks above visited countries on this page, so its persisted
// store is already warm. Start cold: this check is about the request the hook
// makes on a first load, not about answering from the browser cache.
await routePage.evaluate(() => localStorage.clear());
chartRequests.length = 0;
await routePage.goto(`${BASE}/?c=US`, { waitUntil: "networkidle" });
await routePage.waitForFunction(
  () => document.querySelectorAll('section[aria-label$="chart"] ol li').length === 20,
  null,
  { timeout: 30_000 }
);
check(
  "first load requests charts by country only",
  chartRequests.length >= 1 &&
    chartRequests.every((query) => query.includes("country=US") && !query.includes("type=")),
  `${chartRequests.length} request(s): ${chartRequests.join(", ")}`
);
const panel = await routePage.evaluate(() => {
  const section = document.querySelector('section[aria-label$="chart"]');
  const rows = Array.from(section?.querySelectorAll("ol li button") ?? []);
  return {
    meta: section?.querySelector("[data-chart-provenance]")?.textContent?.trim() ?? "",
    rows: rows.length,
    labels: rows.map((b) => b.getAttribute("aria-label") ?? ""),
    text: rows.map((b) => (b.textContent ?? "").replace(/\s+/g, " ").trim()),
    thumbs: rows.filter((b) => !!b.querySelector("img")).length,
    activeTab:
      section?.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim() ?? "",
  };
});
const panelRanks = panel.labels.map((label) => Number(/rank (\d+),/.exec(label)?.[1] ?? 0));
const isRowAnatomy = (p) => {
  const ranks = p.labels.map((label) => Number(/rank (\d+),/.exec(label)?.[1] ?? 0));
  return (
    p.rows === 20 &&
    p.thumbs === 20 &&
    p.labels.every((label) =>
      /^Play .+ by .+, rank \d+, (new to the chart|holding its position|up \d+ from last week|down \d+ from last week)$/.test(
        label
      )
    ) &&
    ranks.every((rank, i) => rank === i + 1) &&
    p.text.every((text) => /(NEW|▲|▼|—)/.test(text))
  );
};
check(
  "the chart panel shows 20 songs with rank, movement, title, artist and thumbnail",
  panel.activeTab === "Songs" && isRowAnatomy(panel),
  `${panel.rows} rows, ${panel.thumbs} thumbnails, ranks ${panelRanks[0]}..${panelRanks.at(-1)}`
);
check(
  "the panel states live provenance, the chart week and the fetch time",
  /^Live\b/.test(panel.meta) && /Week of /.test(panel.meta) && /\bfetched\b/i.test(panel.meta),
  panel.meta
);

// Switch to Videos. The payload is already in memory, so the row count must not
// dip through a loading skeleton and no `/api/charts` request may be issued.
chartRequests.length = 0;
await routePage.getByRole("tab", { name: "Videos" }).click();
await routePage.waitForFunction(
  () => {
    const section = document.querySelector('section[aria-label$="chart"]');
    const active = section?.querySelector('[role="tab"][aria-selected="true"]');
    return (
      active?.textContent?.trim() === "Videos" &&
      section.querySelectorAll("ol li").length === 20
    );
  },
  null,
  { timeout: 5_000 }
);
const videosPanel = await routePage.evaluate(() => {
  const section = document.querySelector('section[aria-label$="chart"]');
  const rows = Array.from(section?.querySelectorAll("ol li button") ?? []);
  return {
    rows: rows.length,
    labels: rows.map((b) => b.getAttribute("aria-label") ?? ""),
    text: rows.map((b) => (b.textContent ?? "").replace(/\s+/g, " ").trim()),
    thumbs: rows.filter((b) => !!b.querySelector("img")).length,
    activeTab:
      section?.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim() ?? "",
  };
});
check(
  "the Videos tab renders 20 videos with the same row anatomy",
  videosPanel.activeTab === "Videos" && isRowAnatomy(videosPanel),
  `${videosPanel.rows} rows, ${videosPanel.thumbs} thumbnails`
);
check(
  "switching to Videos after first load costs no chart request",
  chartRequests.length === 0,
  `${chartRequests.length} request(s)`
);
check(
  "the active tab is in the URL",
  new URL(routePage.url()).searchParams.get("kind") === "videos",
  routePage.url()
);

// A reload must land on the same tab, not silently fall back to Songs — and it
// must do so from the persisted chart, without a chart request. The rows appear
// from the synchronous store read in the hook's layout effect.
chartRequests.length = 0;
const storedBeforeReload = await routePage.evaluate(() => ({
  songs: localStorage.getItem("wts.chart.v1:US:songs") !== null,
  videos: localStorage.getItem("wts.chart.v1:US:videos") !== null,
}));
const reloadStartedAt = Date.now();
await routePage.reload({ waitUntil: "domcontentloaded" });
await routePage.waitForFunction(
  () => {
    const section = document.querySelector('section[aria-label$="chart"]');
    const active = section?.querySelector('[role="tab"][aria-selected="true"]');
    return (
      active?.textContent?.trim() === "Videos" &&
      section.querySelectorAll("ol li").length === 20
    );
  },
  null,
  { timeout: 30_000 }
);
const reloadMs = Date.now() - reloadStartedAt;
const reloaded = await routePage.evaluate(() => {
  const section = document.querySelector('section[aria-label$="chart"]');
  return {
    activeTab:
      section?.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim() ?? "",
    rows: section?.querySelectorAll("ol li").length ?? 0,
  };
});
check(
  "the Videos tab survives reload",
  reloaded.activeTab === "Videos" && reloaded.rows === 20,
  `${reloaded.activeTab}, ${reloaded.rows} rows, ${routePage.url()}`
);
check(
  "a reload renders the chart from persisted browser storage with no chart request",
  chartRequests.length === 0 &&
    storedBeforeReload.songs &&
    storedBeforeReload.videos &&
    reloaded.rows === 20 &&
    reloadMs < 500,
  `${chartRequests.length} request(s), rows after ${reloadMs}ms`
);

// And back to Songs is still just a switch: the reloaded payload is cached once.
chartRequests.length = 0;
await routePage.getByRole("tab", { name: "Songs" }).click();
await routePage.waitForFunction(
  () => {
    const section = document.querySelector('section[aria-label$="chart"]');
    const active = section?.querySelector('[role="tab"][aria-selected="true"]');
    return (
      active?.textContent?.trim() === "Songs" &&
      section.querySelectorAll("ol li").length === 20
    );
  },
  null,
  { timeout: 5_000 }
);
check(
  "switching back to Songs costs no chart request",
  chartRequests.length === 0,
  `${chartRequests.length} request(s)`
);

// localStorage is user-writable, so the store has to survive a value that is
// not a chart at all. The correct answer is to throw it away and refetch — not
// to render it, not to crash, and not to keep it forever.
chartRequests.length = 0;
await routePage.evaluate(() => {
  localStorage.setItem("wts.chart.v1:US:songs", "{not a chart");
});
await routePage.reload({ waitUntil: "networkidle" });
await routePage.waitForFunction(
  () => document.querySelectorAll('section[aria-label$="chart"] ol li').length === 20,
  null,
  { timeout: 30_000 }
);
const afterCorruption = await routePage.evaluate(() => {
  const raw = localStorage.getItem("wts.chart.v1:US:songs");
  let repaired = false;
  try {
    repaired = !!raw && "tracks" in JSON.parse(raw);
  } catch {
    repaired = false;
  }
  return {
    rows: document.querySelectorAll('section[aria-label$="chart"] ol li').length,
    repaired,
  };
});
check(
  "corrupt browser storage is discarded and refetched, not rendered",
  afterCorruption.rows === 20 && afterCorruption.repaired && chartRequests.length >= 1,
  `${afterCorruption.rows} rows, ${chartRequests.length} request(s), repaired ${afterCorruption.repaired}`
);

// ---------------------------------------------------------------------------
// 15b. The no-chart notice. An uncharted country is a legitimate answer, not an
//      error and not an invitation to borrow a neighbour's chart. The panel must
//      name the country, carry the explicit payload's reason, render no rows at
//      all, and offer the one useful next act: the picker, already filtered to
//      countries that have a chart to show.
// ---------------------------------------------------------------------------
stage("checking the no-chart notice");
chartRequests.length = 0;
await routePage.goto(`${BASE}/?c=AD`, { waitUntil: "networkidle" });
await routePage.waitForSelector('[data-no-chart="true"]', { timeout: 20_000 });
const noChartPanel = await routePage.evaluate(() => {
  const section = document.querySelector('section[aria-label$="chart"]');
  const notice = section?.querySelector('[data-no-chart="true"]');
  return {
    notice: notice?.textContent?.replace(/\s+/g, " ").trim() ?? "",
    section: section?.textContent?.replace(/\s+/g, " ").trim() ?? "",
    rows: section?.querySelectorAll("ol li").length ?? 0,
    tabs: section?.querySelectorAll('[role="tab"]').length ?? 0,
    actions: Array.from(notice?.querySelectorAll("button") ?? []).map((b) =>
      (b.textContent ?? "").trim()
    ),
  };
});
const topUsTitle = usSongs?.[0]?.title ?? "";
check(
  "an uncharted country shows the explicit reason and no chart at all",
  /No official chart for Andorra/.test(noChartPanel.notice) &&
    noChartPanel.notice.includes(NO_CHART_REASON) &&
    noChartPanel.rows === 0 &&
    noChartPanel.tabs === 0 &&
    noChartPanel.actions.length === 1 &&
    /charted countries/i.test(noChartPanel.actions[0]) &&
    // Not even the chart of the country we were looking at a moment ago.
    (!topUsTitle || !noChartPanel.section.includes(topUsTitle)),
  `${noChartPanel.rows} rows, ${noChartPanel.tabs} tabs, "${noChartPanel.notice.slice(0, 120)}"`
);
check(
  "the panel asked the API for the uncharted country itself",
  chartRequests.some((query) => query.includes("country=AD")),
  chartRequests.join(", ")
);

// The action is the only way out of a dead end, so it must open the picker
// already filtered — not merely focus the search box.
await routePage.getByRole("button", { name: "Browse charted countries" }).click();
await routePage.waitForSelector(PICKER_DIALOG, { timeout: 5_000 });
const filteredPicker = await routePage.evaluate(() => {
  const dialog = document.querySelector('[role="dialog"][aria-label="Pick a country"]');
  const options = Array.from(dialog?.querySelectorAll('[role="option"]') ?? []);
  return {
    filtered: dialog?.getAttribute("data-charted-only"),
    labels: options.map((o) => o.getAttribute("aria-label") ?? ""),
    text: dialog?.textContent?.replace(/\s+/g, " ").trim() ?? "",
    placeholder: dialog?.querySelector("input[role=combobox]")?.getAttribute("placeholder") ?? "",
  };
});
check(
  "the notice opens the picker filtered to countries with an official chart",
  filteredPicker.filtered === "true" &&
    filteredPicker.labels.length >= 60 &&
    filteredPicker.labels.every((label) => label.includes("has an official chart")) &&
    !filteredPicker.labels.some((label) => label.startsWith("Andorra,")) &&
    /Charted only/.test(filteredPicker.text) &&
    /charted countries/.test(filteredPicker.placeholder),
  `${filteredPicker.labels.length} options, filter ${filteredPicker.filtered}, "${filteredPicker.placeholder}"`
);

// The filter is a starting point, not a trap: clearing it brings the whole
// world back without closing the dialog.
await routePage.getByRole("button", { name: /Charted only/ }).click();
const clearedPicker = await routePage.evaluate(() => {
  const dialog = document.querySelector('[role="dialog"][aria-label="Pick a country"]');
  const labels = Array.from(dialog?.querySelectorAll('[role="option"]') ?? []).map(
    (o) => o.getAttribute("aria-label") ?? ""
  );
  return {
    filtered: dialog?.getAttribute("data-charted-only"),
    options: labels.length,
    andorra: labels.some((label) => label.startsWith("Andorra,")),
  };
});
check(
  "the picker filter can be cleared back to every country",
  clearedPicker.filtered === "false" && clearedPicker.andorra && clearedPicker.options > 100,
  `${clearedPicker.options} options, Andorra ${clearedPicker.andorra}`
);

// And choosing a charted country from here actually leaves the dead end.
await routePage.fill(PICKER_INPUT, "united states");
await routePage.waitForTimeout(60);
await routePage.keyboard.press("Enter");
await routePage.waitForSelector(PICKER_DIALOG, { state: "detached", timeout: 5_000 });
await routePage.waitForFunction(
  () => document.querySelectorAll('section[aria-label$="chart"] ol li').length === 20,
  null,
  { timeout: 20_000 }
);
check(
  "choosing from the no-chart picker lands on that country's chart",
  new URL(routePage.url()).searchParams.get("c") === "US",
  routePage.url()
);
// Every page keeps a live WebGL scene, and headless Chromium rasterises it in
// software on the GPU process. Two of them saturate the machine and starve the
// renderer this gate is trying to measure — the prefetch section's click latency
// went from ~75ms with one page to ~220ms with two. This page has no checks left,
// so close it now rather than at the end of the script.
await routePage.close();

// The stale path has to reach the panel, not just the API. Serve the real
// payload back with an older timestamp and the provenance flipped, and assert
// the row still carries the week and the fetch time.
stage("checking stale provenance in the panel");
const stalePage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await stalePage.route(/\/api\/charts\?/, (route) =>
  route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      ...usChart.body,
      source: "stale",
      fetchedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    }),
  })
);
await stalePage.goto(`${BASE}/?c=US`, { waitUntil: "domcontentloaded" });
await stalePage.waitForFunction(
  () => document.querySelectorAll('section[aria-label$="chart"] ol li').length === 20,
  null,
  { timeout: 20_000 }
);
const staleMeta = await stalePage.evaluate(
  () =>
    document
      .querySelector('section[aria-label$="chart"] [data-chart-provenance]')
      ?.textContent?.trim() ?? ""
);
check(
  "the panel marks stale data with its original fetch time",
  /^Stale\b/.test(staleMeta) &&
    /Week of /.test(staleMeta) &&
    /\bfetched\b/i.test(staleMeta),
  staleMeta
);
await stalePage.close();

// ---------------------------------------------------------------------------
// 16. Error and retry. Intercept the client's chart request so the failure is
//     delivered where the hook actually reads it, then let the retry through to
//     the real route. The retry is only meaningful if it refetches — the old
//     implementation answered from the same cache that held the failure.
// ---------------------------------------------------------------------------
stage("checking chart error and retry");
const errorPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
// The 502 is this check's own injected response; it is not an app error.
const errorPageErrors = watchErrors(errorPage, [/status of 502/]);
await errorPage.route(/\/api\/charts\?/, (route) =>
  route.fulfill({
    status: 502,
    contentType: "application/json",
    body: JSON.stringify({ error: "The chart source is down for this check." }),
  })
);
await errorPage.goto(`${BASE}/?c=US`, { waitUntil: "domcontentloaded" });
await errorPage.waitForSelector('section[aria-label$="chart"] button:has-text("Try again")', {
  timeout: 20_000,
});
const errorState = await errorPage.evaluate(() => ({
  text: document.querySelector('section[aria-label$="chart"]')?.textContent ?? "",
  retry: !!Array.from(document.querySelectorAll('section[aria-label$="chart"] button')).find(
    (b) => (b.textContent ?? "").includes("Try again")
  ),
}));
check(
  "a failed chart shows a clear error with a retry",
  errorState.retry && /down for this check/.test(errorState.text),
  errorState.text.replace(/\s+/g, " ").trim().slice(0, 120)
);
await errorPage.unroute(/\/api\/charts\?/);
await errorPage.getByRole("button", { name: "Try again" }).click();
await errorPage.waitForFunction(
  () => document.querySelectorAll('section[aria-label$="chart"] ol li').length === 20,
  null,
  { timeout: 30_000 }
);
check(
  "retry refetches and recovers the chart",
  true,
  "20 rows after Try again"
);
check(
  "no page errors on the chart error page",
  errorPageErrors.length === 0,
  errorPageErrors.slice(0, 3).join(" | ")
);
await errorPage.close();

// ---------------------------------------------------------------------------
// 17. Bootstrap and persistence.
//
//     Two promises that used to be serial. The chart request must start while
//     the map assets are still in flight — not after two GeoJSON downloads and
//     parses — and a country the user has already read must come back from the
//     browser's own store on reload without touching the network.
//
//     Holding `country-caps.geojson` at the route is the deterministic way to
//     prove the first half: the chart cannot be waiting for it if the panel has
//     rows while that request is still open. The chart itself is fulfilled from
//     the payload the API check already fetched, so this measures bootstrap
//     wiring, not upstream latency.
// ---------------------------------------------------------------------------
stage("checking parallel bootstrap and persisted charts");
const bootPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const bootErrors = watchErrors(bootPage);
let releaseCaps;
const capsGate = new Promise((resolve) => {
  releaseCaps = resolve;
});
let capsRequested = false;
let capsReleased = false;
let capsStarted;
const capsStartedPromise = new Promise((resolve) => {
  capsStarted = resolve;
});
await bootPage.route("**/country-caps.geojson", async (route) => {
  capsRequested = true;
  capsStarted();
  await capsGate;
  capsReleased = true;
  await route.continue();
});
// Answer for whichever country the bootstrap picks, so a response can never be
// mistaken for another country's chart by the panel's own guard.
await bootPage.route(/\/api\/charts\?/, (route) => {
  const country = new URL(route.request().url()).searchParams.get("country") ?? "US";
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ...usChart.body, country }),
  });
});

const bootStartedAt = Date.now();
await bootPage.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
let bootRows = false;
try {
  await bootPage.waitForFunction(
    () => document.querySelectorAll('section[aria-label$="chart"] ol li').length === 20,
    null,
    { timeout: 15_000 }
  );
  bootRows = true;
} catch {
  bootRows = false;
}
// Give the map effect a moment to make its own request; the chart may legitimately
// win the race, but the caps request must exist and still be held for this to prove
// anything.
await Promise.race([capsStartedPromise, new Promise((resolve) => setTimeout(resolve, 2_000))]);
const bootRowsMs = Date.now() - bootStartedAt;
check(
  "first load renders a chart while the map assets are still loading",
  bootRows && capsRequested && !capsReleased,
  `${bootRows ? "20 rows" : "no rows"} in ${bootRowsMs}ms, caps ${capsRequested ? "held" : "never requested"}`
);
check(
  "first load bootstraps a country into the URL before the map arrives",
  new URL(bootPage.url()).searchParams.get("c") === "US",
  bootPage.url()
);
releaseCaps();
await bootPage
  .waitForFunction(
    () => document.getElementById("stage-loading")?.getAttribute("aria-hidden") === "true",
    null,
    { timeout: 30_000 }
  )
  .catch(() => undefined);
check(
  "no page errors while the chart and the map load in parallel",
  bootErrors.length === 0,
  bootErrors.slice(0, 3).join(" | ")
);
await bootPage.close();

// ---------------------------------------------------------------------------
// 18. Hover prefetch. The panel's data path is fast once the payload is in the
//     browser; the request is not. Resting on a charted country starts that
//     request, so the click that follows is a render rather than a round trip.
//     The negatives matter as much as the positive: an uncharted country has
//     nothing to prefetch, leaving must abandon the request, and a drag must
//     never look like a hover.
//
//     Every chart request on this page is fulfilled from the payload the API
//     check already fetched, so this measures the app's wiring rather than the
//     keyless upstream's latency.
// ---------------------------------------------------------------------------
stage("checking hover prefetch");
// The main page is still holding a live YouTube player from the transport
// checks, and decoding video on a background page roughly doubles the time the
// foreground page needs to render 20 rows (measured: 210ms vs 76ms on the same
// machine). Close it first: this section measures the app's own render, not an
// unrelated tab's decoder. Nothing below uses `page`.
await page.close();
const prefetchPage = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  reducedMotion: "reduce",
});
const prefetchErrors = watchErrors(prefetchPage);
const prefetched = [];
const failedPrefetches = [];
/** Countries whose request is held open instead of answered, so the app's abort
 *  is observed as a failed request rather than inferred. */
const heldPrefetch = new Set();
await prefetchPage.route(/\/api\/charts\?/, async (route) => {
  const country = new URL(route.request().url()).searchParams.get("country") ?? "";
  prefetched.push(country);
  if (heldPrefetch.has(country)) {
    // Long enough that the only way this request ends before the answer is the
    // app abandoning it.
    await new Promise((resolve) => setTimeout(resolve, 2500));
    await route.abort().catch(() => undefined);
    return;
  }
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    // The payload names whichever country asked, so the panel's own guard
    // cannot reject it.
    body: JSON.stringify({ ...usChart.body, country }),
  });
});
prefetchPage.on("requestfailed", (request) => {
  const url = new URL(request.url());
  if (url.pathname !== "/api/charts") return;
  failedPrefetches.push(`${url.searchParams.get("country")} ${request.failure()?.errorText ?? ""}`);
});

await prefetchPage.goto(`${BASE}/?c=US`, { waitUntil: "domcontentloaded" });
await prefetchPage.waitForFunction(
  () => document.querySelectorAll('section[aria-label$="chart"] ol li').length === 20,
  null,
  { timeout: 20_000 }
);
await prefetchPage
  .waitForFunction(() => !!window.__globe && !!window.__globeHit, null, { timeout: 30_000 })
  .catch(async (error) => {
    // Without the hit layer nothing is clickable, and this wait is the only place
    // that notices. Report what the page actually knows — a bare timeout here
    // wasted a whole gate run with no diagnosis.
    const state = await prefetchPage
      .evaluate(() => ({
        globe: !!window.__globe,
        hit: !!window.__globeHit,
        loadingHidden: document.getElementById("stage-loading")?.getAttribute("aria-hidden"),
        mapError: (document.body.textContent ?? "").includes("The map didn't load"),
      }))
      .catch(() => null);
    throw new Error(
      `country hit layer never became ready: ${JSON.stringify(state)}` +
        (prefetchErrors.length ? `\npage errors: ${prefetchErrors.join(" | ")}` : "") +
        `\n${error.message}`
    );
  });
await installOracle(prefetchPage);
// Let the initial camera flight to the deep-linked country finish, so a manual
// pose below cannot be overwritten midway through a check.
await prefetchPage.waitForTimeout(600);

// How much a frame costs in this browser. Headless Chromium rasterises WebGL on
// the CPU, and this scene is ~535 draw calls at 1440x900: measured at ~50ms a
// frame, so 20fps. That matters here because React Router applies a search-param
// change as a transition, which can only commit when the main thread is free —
// the click's own 30-50ms of work was being reported as 150-280ms purely because
// it had to wait for software-rendered frames. The two timed clicks therefore
// run with the renderer paused: three-globe still updates its scene graph and
// React still renders and commits, but the check measures the app instead of the
// rasteriser. The frame time goes into the result so the reason stays visible.
const frameMs = await prefetchPage.evaluate(
  () =>
    new Promise((resolve) => {
      let frames = 0;
      const started = performance.now();
      const tick = () => {
        frames++;
        if (performance.now() - started < 1000) requestAnimationFrame(tick);
        else resolve(Math.round((performance.now() - started) / frames));
      };
      requestAnimationFrame(tick);
    })
);
const pauseRenderer = (paused) =>
  prefetchPage.evaluate((p) => {
    const renderer = window.__globe?.renderer?.();
    if (!renderer) return false;
    const store = window;
    if (p) {
      if (store.__realRender) return true;
      store.__realRender = renderer.render;
      renderer.render = () => {};
    } else if (store.__realRender) {
      renderer.render = store.__realRender;
      delete store.__realRender;
    }
    return true;
  }, paused);

const lookAt = async (lat, lng) => {
  await prefetchPage.evaluate(
    ([la, ln]) => window.__globe.pointOfView({ lat: la, lng: ln, altitude: 0.7 }, 0),
    [lat, lng]
  );
  await prefetchPage.waitForTimeout(400);
};

/** A pixel the scene's own hit layer attributes to `iso`, away from the panel. */
const countryPixel = (iso) =>
  prefetchPage.evaluate((want) => {
    const W = innerWidth;
    const H = innerHeight;
    for (let y = 140; y < H - 140; y += 12) {
      for (let x = 100; x < W - 460; x += 12) {
        if (window.__oracle(x, y, W, H) === want) return [x, y];
      }
    }
    return null;
  }, iso);

/** Pose the globe, put the pointer on a country, and prove the scene agrees. */
const hoverCountry = async (iso, lat, lng) => {
  await lookAt(lat, lng);
  const px = await countryPixel(iso);
  if (!px) return null;
  prefetched.length = 0;
  await prefetchPage.mouse.move(px[0], px[1]);
  await prefetchPage.waitForFunction(
    (want) => new RegExp(`^${want}\\b`).test(document.querySelector("header p")?.textContent ?? ""),
    iso,
    { timeout: 5_000 }
  );
  return px;
};

/**
 * Measure, from inside the page, how long the clicked country's chart took to
 * have its 20 rows — and whether a loading skeleton was inserted on the way.
 * The section is matched by name: the previous country's panel is already
 * showing 20 rows when the click lands.
 *
 * Two clocks, because they answer different questions. `commit` is the DOM
 * mutation (a microtask after React writes), which is the app's own render. `rows`
 * is the first frame that mutation could have been *painted* onto, and in
 * headless Chromium the globe is rasterised by the GPU process in software, so a
 * frame can cost tens of milliseconds for reasons that have nothing to do with
 * this page.
 */
const armClickProbe = (iso) =>
  prefetchPage.evaluate((want) => {
    const name = window.__capState(want)?.name ?? want;
    const label = `${name} chart`;
    window.__click = { rows: null, commit: null, skeleton: false };
    const ready = () => {
      const section = document.querySelector(`section[aria-label="${label}"]`);
      return !!section && section.querySelectorAll("ol li").length === 20;
    };
    document.addEventListener(
      "pointerup",
      () => {
        const started = performance.now();
        const seen = new MutationObserver(() => {
          if (document.querySelector('[aria-label="Loading chart"]')) window.__click.skeleton = true;
          if (window.__click.commit === null && ready()) {
            window.__click.commit = Math.round(performance.now() - started);
          }
        });
        seen.observe(document.body, { childList: true, subtree: true });
        const tick = () => {
          if (!ready()) {
            requestAnimationFrame(tick);
            return;
          }
          window.__click.rows = Math.round(performance.now() - started);
          seen.disconnect();
        };
        requestAnimationFrame(tick);
      },
      { once: true, capture: true }
    );
  }, iso);

const readClickProbe = () => prefetchPage.evaluate(() => window.__click);
const waitForNode = async (predicate, timeout = 5_000) => {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (predicate()) return true;
    await prefetchPage.waitForTimeout(50);
  }
  return false;
};

// -- 1. Resting on a charted country warms it. -------------------------------
const brPixel = await hoverCountry("BR", -10, -52);
await prefetchPage.waitForTimeout(700);
check(
  "hovering a charted country prefetches its chart",
  !!brPixel && prefetched.length === 1 && prefetched[0] === "BR",
  brPixel ? `${prefetched.length} request(s): ${prefetched.join(", ") || "none"}` : "no BR pixel"
);

// -- 2. The click asks for nothing, flashes no skeleton, and lands inside the
//       latency budget. `frameMs` is the software-rasterised frame time from
//       above; the renderer is paused for the two timed clicks so this measures
//       the app's commit rather than the rasteriser.
const rendererPaused = await pauseRenderer(true);
// A software frame already in flight when `render` was stubbed can still take
// `frameMs` to finish, and the click would queue behind it — that alone was the
// difference between 41ms and 98ms on the same page. Two frames guarantees the
// pause is in effect before the clock starts.
await prefetchPage.evaluate(
  () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
);
await armClickProbe("BR");
if (brPixel) await prefetchPage.mouse.click(brPixel[0], brPixel[1]);
await prefetchPage.waitForFunction(
  () => {
    const section = document.querySelector('section[aria-label="Brazil chart"]');
    return !!section && section.querySelectorAll("ol li").length === 20;
  },
  null,
  { timeout: 10_000 }
);
const firstClick = await readClickProbe();
check(
  "clicking the hovered country shows its chart with no loading state, no request, in under 100ms",
  firstClick.rows !== null &&
    firstClick.rows < 100 &&
    firstClick.skeleton === false &&
    prefetched.length === 1 &&
    rendererPaused,
  `${firstClick.rows}ms painted (${firstClick.commit}ms committed) at ${frameMs}ms/frame, skeleton ${firstClick.skeleton}, ${prefetched.length} request(s) including the prefetch`
);

// -- 3. A second country, so the result is not a one-off. --------------------
const mxPixel = await hoverCountry("MX", 23, -102);
await prefetchPage.waitForTimeout(700);
await armClickProbe("MX");
if (mxPixel) await prefetchPage.mouse.click(mxPixel[0], mxPixel[1]);
await prefetchPage.waitForFunction(
  () => {
    const section = document.querySelector('section[aria-label="Mexico chart"]');
    return !!section && section.querySelectorAll("ol li").length === 20;
  },
  null,
  { timeout: 10_000 }
);
const secondClick = await readClickProbe();
await pauseRenderer(false);
check(
  "a hovered click on a second country renders in under 100ms",
  secondClick.rows !== null &&
    secondClick.rows < 100 &&
    secondClick.skeleton === false &&
    prefetched.length === 1,
  `${secondClick.rows}ms painted (${secondClick.commit}ms committed) at ${frameMs}ms/frame, skeleton ${secondClick.skeleton}, ${prefetched.length} request(s) including the prefetch`
);

// -- 4. Uncharted countries have nothing to prefetch. ------------------------
// Algeria is large, obviously hoverable, and has no official chart.
const dzPixel = await hoverCountry("DZ", 28, 15);
await prefetchPage.waitForTimeout(600);
check(
  "hovering an uncharted country prefetches nothing",
  !!dzPixel && prefetched.length === 0,
  dzPixel ? `${prefetched.length} request(s) over DZ` : "no DZ pixel"
);

// -- 5. Leaving abandons the request in flight. ------------------------------
heldPrefetch.add("AR");
const arPixel = await hoverCountry("AR", -35, -64);
const arStarted = await waitForNode(() => prefetched.includes("AR"));
// The chart panel is a sibling overlay, so moving onto it ends the stage's
// hover outright — the same pointerleave a user makes by reaching for the list.
await prefetchPage.mouse.move(1200, 400);
const arAborted = await waitForNode(() => failedPrefetches.some((f) => f.startsWith("AR ")));
const arStored = await prefetchPage.evaluate(
  () => localStorage.getItem("wts.chart.v1:AR:songs") !== null
);
check(
  "moving away aborts the prefetch in flight",
  !!arPixel && arStarted && arAborted && arStored === false,
  arPixel
    ? `started ${arStarted}, aborted ${arAborted}, stored ${arStored}` +
        (failedPrefetches.length ? ` (${failedPrefetches.join(", ")})` : "")
    : "no AR pixel"
);

// -- 6. A drag is not a hover. ----------------------------------------------
// Move onto the country and drag within the debounce window: the movement must
// cancel the wait, and the drag itself must not select. The wait after release
// is under the debounce (150ms): a prefetch started by the drag would have to be
// visible by then. Then the pointer leaves the globe, so the resting hover that
// follows a drag cannot be mistaken for the drag's own request.
await lookAt(-35, -71);
const clPixel = await countryPixel("CL");
prefetched.length = 0;
const prefetchSelectionBeforeDrag = new URL(prefetchPage.url()).searchParams.get("c");
if (clPixel) {
  await prefetchPage.mouse.move(clPixel[0], clPixel[1]);
  await prefetchPage.mouse.down();
  await prefetchPage.mouse.move(clPixel[0] + 90, clPixel[1] + 50, { steps: 8 });
  await prefetchPage.mouse.up();
}
await prefetchPage.waitForTimeout(140);
const duringDrag = prefetched.length;
await prefetchPage.mouse.move(1200, 400);
await prefetchPage.waitForTimeout(500);
const selectionAfterDrag = new URL(prefetchPage.url()).searchParams.get("c");
check(
  "a drag over a charted country prefetches nothing",
  !!clPixel && duringDrag === 0 && prefetched.length === 0,
  clPixel
    ? `${duringDrag} request(s) within the debounce, ${prefetched.length} after leaving`
    : "no CL pixel"
);
check(
  "a drag rotates the globe without selecting a country",
  selectionAfterDrag === prefetchSelectionBeforeDrag,
  `before ${prefetchSelectionBeforeDrag}, after ${selectionAfterDrag}`
);
check(
  "no page errors on the prefetch page",
  prefetchErrors.length === 0,
  prefetchErrors.slice(0, 3).join(" | ")
);
await prefetchPage.close();

// ---------------------------------------------------------------------------
// 24. The chart sheet on a phone. Below the rail breakpoint the chart is a
//     bottom sheet, and folding it is how the globe comes back without losing
//     the selection (or interrupting the audio). The peek bar has to answer for
//     the chart in every state — loading, charted, no chart — and folding must
//     be reversible from the keyboard, not only with a pointer.
// ---------------------------------------------------------------------------
stage("checking the folded sheet and peek on a phone");
const PHONE = { width: 390, height: 844 };
const sheetPage = await browser.newPage({
  viewport: PHONE,
  isMobile: true,
  hasTouch: true,
  reducedMotion: "reduce",
});
const sheetErrors = watchErrors(sheetPage);

/** One request deliberately left outstanding, so "loading" in the peek is a
 *  real in-flight chart rather than a state that merely looks like one. */
let releaseHeldChart = () => {};
const heldChart = new Promise((resolve) => (releaseHeldChart = resolve));
let heldCountry = "JP";
await sheetPage.route(/\/api\/charts\?/, async (route) => {
  const country = new URL(route.request().url()).searchParams.get("country") ?? "";
  if (country === heldCountry) {
    heldCountry = null;
    await heldChart;
  }
  const body = CHART_ISOS.includes(country)
    ? // The payload names whichever country asked, so the panel's own guard
      // cannot reject it.
      { ...usChart.body, country }
    : { charted: false, country, reason: NO_CHART_REASON };
  await route
    .fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) })
    .catch(() => undefined);
});

const readSheet = () =>
  sheetPage.evaluate(() => {
    const peekButton =
      document.querySelector('section[aria-label$="chart"] button[aria-expanded="false"]') ?? null;
    const peekSection = peekButton?.closest("section") ?? null;
    const panel = document.querySelector('button[aria-label="Close chart"]')?.closest("section") ?? null;
    const box = (el) => (el ? el.getBoundingClientRect().toJSON() : null);
    return {
      c: new URLSearchParams(location.search).get("c"),
      rows: document.querySelectorAll('section[aria-label$="chart"] ol li').length,
      panelBox: box(panel),
      peek: !!peekButton,
      peekBox: box(peekSection),
      // innerText, not textContent: the mark, the name and the summary are
      // separate elements and textContent would run them together.
      peekText: peekSection?.innerText?.replace(/\s+/g, " ").trim() ?? null,
      sheetH: parseFloat(
        getComputedStyle(document.querySelector("#main")).getPropertyValue("--sheet-h")
      ),
      chevron: !!document.querySelector('button[aria-label="Collapse chart"]'),
      focus:
        document.activeElement?.getAttribute("aria-label") ??
        document.activeElement?.tagName ??
        null,
    };
  });

/** Centre of a control, so every fold/reopen below is a real pointer click. */
const centreOf = (target, selector) =>
  target.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  }, selector);

const foldByChevron = async () => {
  const at = await centreOf(sheetPage, 'button[aria-label="Collapse chart"]');
  if (at) await sheetPage.mouse.click(at.x, at.y);
  await sheetPage
    .waitForSelector('button[aria-label^="Show the "]', { timeout: 5_000 })
    .catch(() => undefined);
  await sheetPage.waitForTimeout(350);
};

const unfoldByPeek = async () => {
  const at = await centreOf(sheetPage, 'button[aria-label^="Show the "]');
  if (at) await sheetPage.mouse.click(at.x, at.y);
  await sheetPage
    .waitForSelector('button[aria-label="Collapse chart"]', { timeout: 5_000 })
    .catch(() => undefined);
  await sheetPage.waitForTimeout(350);
};

/** A pixel in the clear band above the sheet that the scene says is land
 *  (`iso`) or open sky (`undefined`) — never a point under the header or rail. */
const pixelAboveSheet = (list, want) =>
  sheetPage.evaluate(
    ([isos, kind]) => {
      for (let y = 150; y < 650; y += 10) {
        for (let x = 16; x < innerWidth - 16; x += 10) {
          const iso = window.__oracle(x, y, innerWidth, innerHeight);
          if (kind === "sky" ? iso === undefined : !!iso && !isos.includes(iso)) {
            return { x, y, iso: iso ?? null };
          }
        }
      }
      return null;
    },
    [list, want]
  );

await sheetPage.goto(`${BASE}/?c=US`, { waitUntil: "domcontentloaded" });
await sheetPage.waitForFunction(
  () => document.querySelectorAll('section[aria-label$="chart"] ol li').length === 20,
  null,
  { timeout: 20_000 }
);
await sheetPage.waitForFunction(() => !!window.__globe && !!window.__globeHit, null, {
  timeout: 30_000,
});
await installOracle(sheetPage);
await sheetPage.waitForTimeout(600);

const openSheet = await readSheet();
check(
  "on a phone the chart is a bottom sheet with a fold chevron",
  !!openSheet.panelBox &&
    openSheet.panelBox.height > PHONE.height * 0.4 &&
    openSheet.panelBox.height < PHONE.height * 0.6 &&
    openSheet.panelBox.width > PHONE.width - 40 &&
    openSheet.panelBox.bottom > PHONE.height - 20 &&
    openSheet.chevron &&
    !openSheet.peek &&
    Math.abs(openSheet.sheetH - openSheet.panelBox.height) < 2,
  `panel ${Math.round(openSheet.panelBox?.height)}px tall and ` +
    `${Math.round(openSheet.panelBox?.width)}px wide, bottom ${Math.round(openSheet.panelBox?.bottom)}, ` +
    `--sheet-h ${openSheet.sheetH}`
);

await foldByChevron();
const foldedSheet = await readSheet();
const expectedWeek = usChart.body?.week?.start ? fmtWeek(usChart.body.week) : "";
check(
  "the chevron folds the sheet to a peek bar without losing the selection",
  foldedSheet.c === "US" &&
    foldedSheet.peek &&
    !foldedSheet.chevron &&
    (foldedSheet.peekBox?.height ?? 999) < 70 &&
    foldedSheet.sheetH < 70 &&
    foldedSheet.rows === 0,
  `?c=${foldedSheet.c}, peek ${Math.round(foldedSheet.peekBox?.height ?? 0)}px, ` +
    `--sheet-h ${foldedSheet.sheetH}`
);
check(
  "the peek summarises the chart and its week",
  /^US\s+United States/.test(foldedSheet.peekText ?? "") &&
    (foldedSheet.peekText ?? "").includes(`20 songs · ${expectedWeek}`),
  foldedSheet.peekText
);
check(
  "folding hands focus to the peek bar instead of dropping it on <body>",
  (foldedSheet.focus ?? "").startsWith("Show the United States chart"),
  foldedSheet.focus ?? "nothing focused"
);

await unfoldByPeek();
const reopened = await readSheet();
check(
  "the peek reopens the same chart, and focus follows it back",
  reopened.c === "US" &&
    !reopened.peek &&
    reopened.chevron &&
    reopened.rows === 20 &&
    (reopened.focus ?? "") === "Collapse chart",
  `?c=${reopened.c}, ${reopened.rows} rows, focus ${reopened.focus ?? "none"}`
);

// A selection must unfold, whichever way it was made. The globe first: pose the
// camera at a world view, then click the country the scene's own hit layer
// reports under a pixel — so this cannot pass by clicking the panel instead.
await foldByChevron();
await sheetPage.evaluate(() =>
  window.__globe.pointOfView({ lat: -10, lng: -55, altitude: 1.7 }, 0)
);
await sheetPage.waitForTimeout(900);
const globePick = await pixelAboveSheet(["US"], "land");
if (globePick) await sheetPage.mouse.click(globePick.x, globePick.y);
await sheetPage.waitForTimeout(1200);
const afterGlobePick = await readSheet();
check(
  "selecting a country on the globe unfolds the sheet",
  !!globePick &&
    afterGlobePick.c === globePick.iso &&
    !afterGlobePick.peek &&
    !!afterGlobePick.chevron,
  globePick
    ? `${globePick.iso} @${globePick.x},${globePick.y} -> ?c=${afterGlobePick.c}, ` +
      `peek ${afterGlobePick.peek}`
    : "no land pixel above the peek bar"
);

await foldByChevron();
const surpriseAt = await centreOf(sheetPage, 'button[aria-label="Surprise me"]');
if (surpriseAt) await sheetPage.mouse.click(surpriseAt.x, surpriseAt.y);
await sheetPage.waitForTimeout(1200);
const afterSurprise = await readSheet();
check(
  "Surprise me unfolds the sheet",
  !!surpriseAt && !!afterSurprise.c && !afterSurprise.peek && !!afterSurprise.chevron,
  `?c=${afterSurprise.c}, peek ${afterSurprise.peek}`
);

await foldByChevron();
const pickerAt = await centreOf(sheetPage, 'header button[aria-haspopup="dialog"]');
if (pickerAt) await sheetPage.mouse.click(pickerAt.x, pickerAt.y);
await sheetPage
  .waitForSelector('[role="dialog"][aria-label="Pick a country"] [role="option"]', {
    timeout: 5_000,
  })
  .catch(() => undefined);
const pickerOption = await sheetPage.evaluate(() => {
  const option = document.querySelector('[role="dialog"][aria-label="Pick a country"] [role="option"]');
  if (!option) return null;
  option.scrollIntoView({ block: "center" });
  const r = option.getBoundingClientRect();
  return {
    x: Math.round(r.x + r.width / 2),
    y: Math.round(r.y + r.height / 2),
    iso: option.getAttribute("data-iso"),
  };
});
if (pickerOption) await sheetPage.mouse.click(pickerOption.x, pickerOption.y);
await sheetPage.waitForTimeout(1200);
const afterPicker = await readSheet();
check(
  "picking a country unfolds the sheet",
  !!pickerOption &&
    afterPicker.c === pickerOption.iso &&
    !afterPicker.peek &&
    !!afterPicker.chevron,
  pickerOption
    ? `${pickerOption.iso} -> ?c=${afterPicker.c}, peek ${afterPicker.peek}`
    : "no picker option"
);

// A genuine tap that hits no country folds. Open sky is the cleanest miss: it
// cannot be confused with a click on the panel, the header or the rail.
const skyPixel = await pixelAboveSheet([], "sky");
if (skyPixel) await sheetPage.mouse.click(skyPixel.x, skyPixel.y);
await sheetPage.waitForTimeout(700);
const afterEmptyTap = await readSheet();
check(
  "an empty-space tap folds the sheet and keeps the selection",
  !!skyPixel && afterEmptyTap.peek && !afterEmptyTap.chevron && afterEmptyTap.c === afterPicker.c,
  skyPixel
    ? `sky @${skyPixel.x},${skyPixel.y} -> peek ${afterEmptyTap.peek}, ?c=${afterEmptyTap.c}`
    : "no open-sky pixel above the sheet"
);

// The peek answers for a chart that has not arrived yet, and replaces that
// answer with the summary the moment it does. The skeleton is in the server HTML,
// so wait for the globe before touching a control: a click that lands before
// hydration is simply dropped.
await sheetPage.goto(`${BASE}/?c=JP`, { waitUntil: "domcontentloaded" });
await sheetPage.waitForSelector('[aria-label="Loading chart"]', { timeout: 10_000 });
await sheetPage.waitForFunction(() => !!window.__globe, null, { timeout: 30_000 });
await foldByChevron();
const loadingPeek = await readSheet();
check(
  "the peek says the chart is loading",
  loadingPeek.peek && /Loading…/.test(loadingPeek.peekText ?? ""),
  loadingPeek.peekText
);
releaseHeldChart();
await sheetPage
  .waitForFunction(
    () =>
      /20 songs/.test(
        document.querySelector('section[aria-label$="chart"]')?.innerText ?? ""
      ),
    null,
    { timeout: 10_000 }
  )
  .catch(() => undefined);
const settledPeek = await readSheet();
check(
  "the peek replaces loading with the chart week once the answer lands",
  settledPeek.peek && (settledPeek.peekText ?? "").includes("20 songs · "),
  settledPeek.peekText
);

await sheetPage.goto(`${BASE}/?c=AD`, { waitUntil: "domcontentloaded" });
await sheetPage.waitForSelector('[data-no-chart="true"]', { timeout: 10_000 });
await sheetPage.waitForFunction(() => !!window.__globe, null, { timeout: 30_000 });
await foldByChevron();
const noChartPeek = await readSheet();
check(
  "the peek states that no official chart exists",
  noChartPeek.peek && /No official chart/.test(noChartPeek.peekText ?? ""),
  noChartPeek.peekText
);

// ---------------------------------------------------------------------------
// 25. Layout coherence on a phone and a tablet.
//
//      The sheet height is one number. This section proves the server's first
//      paint already uses it (JavaScript disabled, so there is no chance a
//      mount effect has corrected anything), that the sheet, rail and camera
//      all agree about it, that folding re-frames the globe by exactly the
//      space the sheet gives back, and that the player docks inside that height
//      instead of growing the dock over the rail or the list.
//
//      The 768px case is not incidental: the layout used to switch rail/sheet in
//      CSS at 640px while JS called everything under 1024px narrow, so a tablet
//      got a phone's camera offset beside a full-height rail.
// ---------------------------------------------------------------------------
stage("checking layout coherence");

const readLayout = () =>
  sheetPage.evaluate(() => {
    const box = (el) => (el ? el.getBoundingClientRect().toJSON() : null);
    const panel =
      document.querySelector('button[aria-label="Close chart"]')?.closest("section") ?? null;
    const peek =
      document.querySelector('button[aria-label^="Show the "]')?.closest("section") ?? null;
    const aside = document.querySelector('aside[aria-label="Chart and player"]');
    const player = document.querySelector('section[aria-label="Now playing"]');
    const rail = document.querySelector('nav[aria-label="Filter by region"]');
    const view = window.__globe?.camera?.()?.view ?? null;
    return {
      sheetH: parseFloat(
        getComputedStyle(document.querySelector("#main")).getPropertyValue("--sheet-h")
      ),
      panel: box(panel),
      peek: box(peek),
      aside: box(aside),
      player: box(player),
      rail: box(rail),
      cameraX: view ? view.offsetX : 0,
      cameraY: view ? view.offsetY : 0,
      w: innerWidth,
      h: innerHeight,
      c: new URLSearchParams(location.search).get("c"),
    };
  });

await sheetPage.goto(`${BASE}/?c=US`, { waitUntil: "domcontentloaded" });
await sheetPage.waitForFunction(
  () => document.querySelectorAll('section[aria-label$="chart"] ol li').length === 20,
  null,
  { timeout: 20_000 }
);
await sheetPage.waitForFunction(() => !!window.__globe, null, { timeout: 30_000 });
await sheetPage.waitForTimeout(900);

const openLayout = await readLayout();
check(
  "the sheet, the rail and the globe read one sheet height",
  !!openLayout.panel &&
    Math.abs(openLayout.sheetH - openLayout.panel.height) < 1.5 &&
    !!openLayout.rail &&
    openLayout.rail.bottom <= openLayout.panel.top - 4 &&
    openLayout.sheetH > PHONE.height * 0.4,
  `--sheet-h ${openLayout.sheetH}, panel ${Math.round(openLayout.panel?.height ?? 0)}px, ` +
    `rail bottom ${Math.round(openLayout.rail?.bottom ?? 0)} vs panel top ${Math.round(openLayout.panel?.top ?? 0)}`
);

// First paint is the server's HTML. With scripting disabled nothing can have run
// after mount, so this is exactly what a phone paints before hydration.
const firstPaintContext = await browser.newContext({
  viewport: PHONE,
  isMobile: true,
  hasTouch: true,
  javaScriptEnabled: false,
});
const firstPaintPage = await firstPaintContext.newPage();
await firstPaintPage.goto(`${BASE}/?c=US`, { waitUntil: "load" });
const firstPaint = await firstPaintPage.evaluate(() => {
  const panel =
    document.querySelector('button[aria-label="Close chart"]')?.closest("section") ?? null;
  const box = panel?.getBoundingClientRect() ?? null;
  return {
    sheetH: parseFloat(
      getComputedStyle(document.querySelector("#main")).getPropertyValue("--sheet-h")
    ),
    panel: box ? box.toJSON() : null,
  };
});
await firstPaintContext.close();
check(
  "a phone's first paint is already the settled sheet, with no mount-time snap",
  !!firstPaint.panel &&
    Math.abs(firstPaint.sheetH - openLayout.sheetH) < 1 &&
    Math.abs(firstPaint.panel.top - (openLayout.panel?.top ?? -1)) < 1 &&
    Math.abs(firstPaint.panel.height - (openLayout.panel?.height ?? -1)) < 1,
  `first ${Math.round(firstPaint.panel?.height ?? 0)}px @${Math.round(firstPaint.panel?.top ?? 0)}, ` +
    `settled ${Math.round(openLayout.panel?.height ?? 0)}px @${Math.round(openLayout.panel?.top ?? 0)}`
);

// Folding gives the globe exactly half the sheet's height back, because the
// camera offset is `-sheetReserve / 2` plus the header term — which cancels in
// the difference. This is the one assertion that ties the camera to the same
// number the layout uses.
await foldByChevron();
await sheetPage.waitForTimeout(600);
const foldedLayout = await readLayout();
check(
  "folding re-frames the globe by half the height the sheet gives back",
  foldedLayout.sheetH < 70 &&
    !!foldedLayout.peek &&
    Math.abs(
      openLayout.cameraY - foldedLayout.cameraY - (openLayout.sheetH - foldedLayout.sheetH) / 2
    ) < 1.5,
  `--sheet-h ${openLayout.sheetH} -> ${foldedLayout.sheetH}, ` +
    `camera offsetY ${openLayout.cameraY} -> ${foldedLayout.cameraY}`
);
await unfoldByPeek();
await sheetPage.waitForTimeout(500);

// 768px is a sheet, not a rail: the CSS breakpoint and the JS one have to agree.
await sheetPage.setViewportSize({ width: 768, height: 900 });
await sheetPage.waitForTimeout(900);
const tablet = await readLayout();
check(
  "at 768px the chart is still a bottom sheet, and the rail clears it",
  tablet.w === 768 &&
    !!tablet.panel &&
    tablet.panel.width > 700 &&
    tablet.panel.bottom > 880 &&
    Math.abs(tablet.sheetH - tablet.panel.height) < 1.5 &&
    !!tablet.rail &&
    tablet.rail.bottom <= tablet.panel.top - 4,
  `${Math.round(tablet.panel?.width ?? 0)}x${Math.round(tablet.panel?.height ?? 0)} ` +
    `at y${Math.round(tablet.panel?.top ?? 0)}, rail bottom ${Math.round(tablet.rail?.bottom ?? 0)}`
);

// Clickability at this width, at coordinates that are genuinely above the sheet.
const tabletEuropeChip = await centreOf(
  sheetPage,
  'nav[aria-label="Filter by region"] button[title="Fade everything outside Europe"]'
);
if (tabletEuropeChip) await sheetPage.mouse.click(tabletEuropeChip.x, tabletEuropeChip.y);
await sheetPage.waitForTimeout(500);
const railPressed = await sheetPage.evaluate(
  () =>
    document.querySelector('nav[aria-label="Filter by region"] button[aria-pressed="true"]')
      ?.textContent?.replace(/\s+/g, " ").trim() ?? null
);
check(
  "a tablet rail chip above the sheet answers a real pointer click",
  !!tabletEuropeChip && /^Europe/.test(railPressed ?? ""),
  tabletEuropeChip
    ? `clicked ${tabletEuropeChip.x},${tabletEuropeChip.y} -> ${railPressed}`
    : "no Europe chip"
);
if (tabletEuropeChip) await sheetPage.mouse.click(tabletEuropeChip.x, tabletEuropeChip.y);

// Back to the phone. `sheetErrors` is checked before playback so the YouTube
// iframe (which logs environment noise in headless Chromium) cannot fail it.
await sheetPage.setViewportSize(PHONE);
await sheetPage.waitForTimeout(700);
const backOnPhone = await readLayout();
check(
  "returning to phone width restores the same sheet and framing",
  Math.abs(backOnPhone.sheetH - openLayout.sheetH) < 1.5 &&
    Math.abs(backOnPhone.cameraY - openLayout.cameraY) < 1.5 &&
    Math.abs((backOnPhone.panel?.height ?? 0) - openLayout.sheetH) < 1.5,
  `--sheet-h ${backOnPhone.sheetH}, camera offsetY ${backOnPhone.cameraY}`
);
check("no page errors on the layout page", sheetErrors.length === 0, sheetErrors.slice(0, 3).join(" | "));

// The player is inside the sheet, not stacked under it. Play with a real click
// on the first row; the iframe itself is irrelevant to the geometry.
const playAt = await centreOf(sheetPage, 'section[aria-label$="chart"] ol li button');
if (playAt) await sheetPage.mouse.click(playAt.x, playAt.y);
await sheetPage.waitForSelector('section[aria-label="Now playing"]', { timeout: 10_000 });
await sheetPage.waitForTimeout(900);
const withPlayer = await readLayout();
check(
  "the player docks inside the sheet without covering the list or the rail",
  !!withPlayer.player &&
    !!withPlayer.panel &&
    Math.abs(withPlayer.aside.height - withPlayer.sheetH) < 1.5 &&
    withPlayer.panel.bottom <= withPlayer.player.top - 8 &&
    !!withPlayer.rail &&
    withPlayer.rail.bottom <= withPlayer.panel.top - 4,
  `aside ${Math.round(withPlayer.aside?.height ?? 0)}px, sheet ${withPlayer.sheetH}, ` +
    `list bottom ${Math.round(withPlayer.panel?.bottom ?? 0)} vs player top ${Math.round(withPlayer.player?.top ?? 0)}`
);

await foldByChevron();
await sheetPage.waitForTimeout(700);
const foldedWithPlayer = await readLayout();
check(
  "a folded sheet reserves the peek bar and the player together",
  !!foldedWithPlayer.peek &&
    !!foldedWithPlayer.player &&
    Math.abs(foldedWithPlayer.sheetH - foldedWithPlayer.aside.height) < 1.5 &&
    !!foldedWithPlayer.rail &&
    foldedWithPlayer.rail.bottom <= foldedWithPlayer.aside.top - 4,
  `--sheet-h ${foldedWithPlayer.sheetH}, aside ${Math.round(foldedWithPlayer.aside?.height ?? 0)}px, ` +
    `rail bottom ${Math.round(foldedWithPlayer.rail?.bottom ?? 0)} vs dock top ${Math.round(foldedWithPlayer.aside?.top ?? 0)}`
);

// Closing the chart leaves the player on its own. The rail must clear it, and
// the full sheet height is still reserved even though no sheet exists.
await unfoldByPeek();
await sheetPage.waitForTimeout(500);
const closeAt = await centreOf(sheetPage, 'button[aria-label="Close chart"]');
if (closeAt) await sheetPage.mouse.click(closeAt.x, closeAt.y);
await sheetPage.waitForTimeout(700);
const playerOnly = await readLayout();
check(
  "with only the player docked, the rail clears it and the sheet height stays reserved",
  !playerOnly.panel &&
    !!playerOnly.player &&
    Math.abs(playerOnly.sheetH - openLayout.sheetH) < 1.5 &&
    !!playerOnly.rail &&
    playerOnly.rail.bottom <= playerOnly.player.top - 4 &&
    playerOnly.c === null,
  `--sheet-h ${playerOnly.sheetH}, rail bottom ${Math.round(playerOnly.rail?.bottom ?? 0)} ` +
    `vs player top ${Math.round(playerOnly.player?.top ?? 0)}, ?c=${playerOnly.c}`
);

await sheetPage.close();

// Wide layouts have a rail, not a sheet. Charts are irrelevant to this section
// and four country selections would otherwise each wait on the upstream, so
// name whichever country asked — the same stub the prefetch section uses.
const wideSheetPage = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  reducedMotion: "reduce",
});
const wideSheetErrors = watchErrors(wideSheetPage);
await wideSheetPage.route(/\/api\/charts\?/, (route) => {
  const country = new URL(route.request().url()).searchParams.get("country") ?? "";
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ...usChart.body, country }),
  });
});
await wideSheetPage.goto(`${BASE}/?c=US`, { waitUntil: "domcontentloaded" });
await wideSheetPage.waitForFunction(
  () => document.querySelectorAll('section[aria-label$="chart"] ol li').length === 20,
  null,
  { timeout: 20_000 }
);
await wideSheetPage.waitForFunction(() => !!window.__globe && !!window.__globeHit, null, {
  timeout: 30_000,
});
await installOracle(wideSheetPage);

// ---------------------------------------------------------------------------
// 26. Focus and world view.
//
//      The pure gate (`scripts/focus-check.mjs`) proves the arithmetic: world is
//      never closer than focus, and a selection can only move closer. This
//      section proves the wiring on the named countries from the ticket, plus
//      the three ways out of a focus: Escape, an empty tap, and a resize after
//      either.
//
//      Reduced motion makes every flight instant, so each assertion reads the
//      camera after the state has settled rather than after a guessed duration.
// ---------------------------------------------------------------------------
stage("checking focus and world view");

const WIDE_LAYOUT = { width: 1440, height: 900, isWide: true, sheetPx: 0 };
const WORLD = worldAltitude(WIDE_LAYOUT);
const readPose = () =>
  wideSheetPage.evaluate(() => {
    const pose = window.__globe.pointOfView();
    return {
      ...pose,
      c: new URLSearchParams(location.search).get("c"),
      panel: !!document.querySelector('button[aria-label="Close chart"]'),
      chevron: !!document.querySelector('button[aria-label="Collapse chart"]'),
      peek: !!document.querySelector('button[aria-label^="Show the "]'),
    };
  });
const poseAt = (lat, lng, altitude) =>
  wideSheetPage.evaluate(
    ([la, ln, alt]) => window.__globe.pointOfView({ lat: la, lng: ln, altitude: alt }, 0),
    [lat, lng, altitude]
  );
/** A pixel the scene's own hit layer attributes to `iso`, near the projected
 *  centre. The projection alone is a good guess, but a centroid can sit in a
 *  bay; the oracle makes the click land on the country the check names. */
const focusPixel = (lat, lng, iso) =>
  wideSheetPage.evaluate(
    ([la, ln, want]) => {
      const centre = window.__screenOf(la, ln);
      if (!centre) return null;
      if (window.__oracle(centre[0], centre[1], innerWidth, innerHeight) === want) return centre;
      for (let r = 3; r <= 30; r += 3) {
        for (let dy = -r; dy <= r; dy += 3) {
          for (let dx = -r; dx <= r; dx += 3) {
            const x = centre[0] + dx;
            const y = centre[1] + dy;
            if (window.__oracle(x, y, innerWidth, innerHeight) === want) return [x, y];
          }
        }
      }
      return centre;
    },
    [lat, lng, iso]
  );

// Selecting a microstate used to resolve to the *farthest* framing: the span
// formula's "minimum" radius was the smallest globe, so Singapore flew outward.
// Pose the camera closer than the comfortable focus first, then click the
// country's centre. The camera may stay where it is, but it must not retreat.
const MICROSTATES = [
  { iso: "SG", lat: 1.35, lng: 103.82 },
  { iso: "HK", lat: 22.32, lng: 114.17 },
  { iso: "LU", lat: 49.82, lng: 6.13 },
  { iso: "SV", lat: 13.79, lng: -88.9 },
];
for (const c of MICROSTATES) {
  await poseAt(c.lat, c.lng, 0.5);
  const before = await readPose();
  const at = await focusPixel(c.lat, c.lng, c.iso);
  if (at) await wideSheetPage.mouse.click(at[0], at[1]);
  await wideSheetPage
    .waitForFunction(
      (iso) => new URLSearchParams(location.search).get("c") === iso,
      c.iso,
      { timeout: 5_000 }
    )
    .catch(() => undefined);
  await wideSheetPage.waitForTimeout(150);
  const after = await readPose();
  check(
    `selecting ${c.iso} from a closer camera never moves outward`,
    !!at && after.c === c.iso && after.altitude <= before.altitude + 0.01,
    at
      ? `click @${at[0]},${at[1]} -> ?c=${after.c}, altitude ${before.altitude.toFixed(3)} -> ${after.altitude.toFixed(3)}`
      : "the country centre did not project on screen"
  );
}

// Escape is the keyboard way back to the world. The selection, its ring and
// `?c=` all stay; only the camera moves.
await poseAt(13.79, -88.9, 0.6);
await wideSheetPage.keyboard.press("Escape");
await wideSheetPage.waitForTimeout(200);
const escapedWorld = await readPose();
check(
  "Escape returns to world view and keeps the selection",
  Math.abs(escapedWorld.altitude - WORLD) < 0.02 &&
    escapedWorld.c === "SV" &&
    escapedWorld.panel &&
    !escapedWorld.chevron,
  `altitude ${escapedWorld.altitude.toFixed(3)} (world ${WORLD.toFixed(3)}), ?c=${escapedWorld.c}`
);

// A wide empty tap is the pointer equivalent. Water is a genuine miss — open sky
// can be hard to find when the globe is close — and both reach `onEmptyTap`.
await poseAt(13.79, -88.9, 0.6);
const wideWater = await wideSheetPage.evaluate(() => {
  for (let y = 150; y < innerHeight - 200; y += 12) {
    for (let x = 40; x < 980; x += 12) {
      const hit = window.__oracle(x, y, innerWidth, innerHeight);
      if (hit === null || hit === undefined) return { x, y, kind: hit === null ? "water" : "sky" };
    }
  }
  return null;
});
if (wideWater) await wideSheetPage.mouse.click(wideWater.x, wideWater.y);
await wideSheetPage.waitForTimeout(250);
const wideSheet = await readPose();
check(
  "a wide layout has no fold, and an empty tap returns to world view",
  !!wideWater &&
    !wideSheet.chevron &&
    !wideSheet.peek &&
    wideSheet.panel &&
    wideSheet.c === "SV" &&
    Math.abs(wideSheet.altitude - WORLD) < 0.02,
  wideWater
    ? `${wideWater.kind} @${wideWater.x},${wideWater.y} -> chevron ${wideSheet.chevron}, ` +
      `?c=${wideSheet.c}, altitude ${wideSheet.altitude.toFixed(3)} (world ${WORLD.toFixed(3)})`
    : "no water pixel on the stage"
);
check(
  "the wide empty tap leaves the camera offset beside the rail",
  await wideSheetPage.evaluate(
    () => Math.abs((window.__globe?.camera?.()?.view?.offsetX ?? 0) - (384 + 48) / 2) < 1
  ),
  "the rail still owns its half of the stage"
);

// Pressing the country that is already selected is a recentre, not a no-op:
// pan the camera away first, then click the selected country's centre.
await poseAt(32, -70, 0.7);
const panBefore = await readPose();
const svAt = await focusPixel(13.79, -88.9, "SV");
if (svAt) await wideSheetPage.mouse.click(svAt[0], svAt[1]);
await wideSheetPage.waitForTimeout(250);
const recentred = await readPose();
check(
  "clicking the selected country recentres it",
  !!svAt &&
    recentred.c === "SV" &&
    recentred.altitude <= panBefore.altitude + 0.01 &&
    Math.abs(recentred.lat - 13.79) < 1 &&
    Math.abs(recentred.lng + 88.9) < 1,
  svAt
    ? `pan ${panBefore.lat.toFixed(1)},${panBefore.lng.toFixed(1)} -> ` +
      `${recentred.lat.toFixed(1)},${recentred.lng.toFixed(1)} at ${recentred.altitude.toFixed(3)}`
    : "the selected country did not project on screen"
);

// Escape, then resize. A layout re-frame is allowed to move the camera exactly
// to its target, but while `worldView` holds that target is the world — a resize
// must not quietly re-focus the country the user just zoomed out of.
await wideSheetPage.keyboard.press("Escape");
await wideSheetPage.waitForTimeout(150);
await wideSheetPage.setViewportSize({ width: 1200, height: 800 });
await wideSheetPage.waitForTimeout(350);
const resized = await readPose();
const resizedWorld = worldAltitude({ width: 1200, height: 800, isWide: true, sheetPx: 0 });
check(
  "a resize after Escape stays at world view",
  Math.abs(resized.altitude - resizedWorld) < 0.02 && resized.c === "SV",
  `altitude ${resized.altitude.toFixed(3)} (world ${resizedWorld.toFixed(3)}), ?c=${resized.c}`
);

// And a selection still leaves world view: the same country, now at a world
// altitude, must move to the comfortable focus rather than staying out.
const afterResizeAt = await focusPixel(13.79, -88.9, "SV");
if (afterResizeAt) await wideSheetPage.mouse.click(afterResizeAt[0], afterResizeAt[1]);
await wideSheetPage.waitForTimeout(250);
const refocused = await readPose();
const resizedFocus = focusAltitude({ width: 1200, height: 800, isWide: true, sheetPx: 0 });
check(
  "selecting after a world reset returns to the country focus",
  !!afterResizeAt &&
    refocused.c === "SV" &&
    Math.abs(refocused.altitude - resizedFocus) < 0.02 &&
    resizedFocus < resizedWorld,
  afterResizeAt
    ? `altitude ${refocused.altitude.toFixed(3)} (focus ${resizedFocus.toFixed(3)}, world ${resizedWorld.toFixed(3)})`
    : "the country did not project on screen after the resize"
);

check(
  "no page errors on the wide sheet page",
  wideSheetErrors.length === 0,
  wideSheetErrors.slice(0, 3).join(" | ")
);
await wideSheetPage.close();

await browser.close();

const failed = results.filter((r) => !r.pass);
console.log("");
console.log(`${results.length - failed.length}/${results.length} browser checks passed`);
process.exit(failed.length ? 1 : 0);