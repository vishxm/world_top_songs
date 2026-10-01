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
//   2. ocean stays silent end-to-end (the far-side regression, through the UI)
//   3. a selection repaints the caps when the pointer is off the canvas
//   4. the region rail dims other regions
//   5. the draw-call budget holds
//   6. the player's progress bar renders (a Tailwind v4 regression, see NowPlaying)
//   7. Media Session handlers are installed, so the MacBook transport keys land
//
// Run it against a dev server. Usage: node scripts/globe-pick-check.mjs [url]
import { chromium } from "playwright";

const URL_ = process.argv[2] ?? "http://localhost:5173/?c=US";
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
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") pageErrors.push(m.text().slice(0, 160));
});

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
await page.waitForTimeout(2500);
stage("globe ready");

// Park the globe. It idles with autoRotate on, and a rotating globe invalidates
// every sample point between measuring and hovering.
await page.evaluate(() => {
  window.__globe.controls().autoRotate = false;
});

/**
 * The independent oracle, installed in the page.
 *
 * Deliberately a reimplementation of the rule rather than a call into the app:
 * hits sorted near→far, the first country cap wins, and the globe sphere ends the
 * search because everything past it is on the far side of the planet. The
 * atmosphere shell, the merged border layer, the selection outline and the pulse
 * rings are transparent to the pointer by design.
 */
await page.evaluate(async () => {
  const THREE = await import("/node_modules/three/build/three.module.js");
  window.__THREE = THREE;
  const typeOf = (o) => {
    while (o) {
      if (o.__globeObjType) return o.__globeObjType;
      o = o.parent;
    }
    return null;
  };
  const datumOf = (o) => {
    while (o) {
      const d = o.__data && o.__data.data;
      if (d && d.iso) return d;
      o = o.parent;
    }
    return null;
  };
  window.__oracle = (x, y, W, H) => {
    const g = window.__globe;
    const rc = new THREE.Raycaster();
    rc.setFromCamera(new THREE.Vector2((x / W) * 2 - 1, -(y / H) * 2 + 1), g.camera());
    for (const hit of rc.intersectObject(g.scene(), true)) {
      const t = typeOf(hit.object);
      if (t === "polygon") {
        const d = datumOf(hit.object);
        return d ? d.iso : null;
      }
      if (t === "globe") return null;
    }
    return null;
  };
  // Exposed for the cap-material probes below, which must resolve the datum the
  // same way rather than assuming `__data` sits on the tagged object.
  window.__datumOf = datumOf;
});

const readHover = () =>
  page.evaluate(() => {
    const p = document.querySelector("header p");
    const m = p && /^([A-Z]{2})/.exec(p.textContent ?? "");
    return m ? m[1] : "";
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
for (const [x, y] of samples.land) {
  await page.mouse.move(x, y);
  await page.waitForTimeout(70);
  const hovered = await readHover();
  if (!hovered) {
    // Re-measure: if the scene has no cap here now, the sample list was stale.
    const still = await page.evaluate(([px, py]) => window.__oracle(px, py, innerWidth, innerHeight), [x, y]);
    if (still) missed.push(`${x},${y}(wants ${still})`);
    continue;
  }
  if (hovered !== samples.land.find((s) => s[0] === x && s[1] === y)[2]) {
    mismatched.push(`${x},${y}=${hovered}`);
  }
}

const ghost = [];
for (const [x, y] of samples.ocean) {
  await page.mouse.move(x, y);
  await page.waitForTimeout(60);
  const hovered = await readHover();
  if (hovered) ghost.push(`${x},${y}=${hovered}`);
}

check(
  "land pixels name their country",
  samples.land.length >= MIN_LAND && missed.length === 0 && mismatched.length === 0,
  `${samples.land.length} sampled, ${missed.length} missed ${missed.slice(0, 4).join(" ")}, ${mismatched.length} wrong ${mismatched.slice(0, 4).join(" ")}`
);
check(
  "ocean stays silent (no far-side picks)",
  samples.ocean.length >= MIN_OCEAN && ghost.length === 0,
  `${samples.ocean.length} sampled, ${ghost.length} far-side ${ghost.slice(0, 4).join(" ")}`
);

// ---------------------------------------------------------------------------
// 3. A selection must repaint the caps on its own.
// ---------------------------------------------------------------------------
stage("checking selection repaint");
const capState = (iso) =>
  page.evaluate((want) => {
    let out = null;
    window.__globe.scene().traverse((o) => {
      if (o.__globeObjType !== "polygon") return;
      const d = window.__datumOf(o);
      if (!d || d.iso !== want) return;
      const cap = o.children[0];
      const m = Array.isArray(cap.material) ? cap.material[1] : null;
      out = { lift: +cap.scale.x.toFixed(4), opacity: m ? +m.opacity.toFixed(3) : null, hex: m ? m.color.getHexString() : null };
    });
    return out;
  }, iso);

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
await page.waitForSelector('[role="listbox"][aria-label="Countries"] li[role="option"] button', {
  timeout: 10_000,
});
await page.evaluate(() => document.querySelector('[role="listbox"] li[role="option"] button').click());
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
// 4. The region rail has to actually dim the other regions.
// ---------------------------------------------------------------------------
stage("checking region filter");
const regionResult = await page.evaluate(async () => {
  // Walk up for the datum, the way the app's own `datumOf` does — three-globe
  // attaches `__data` to the object it generated, but not always to the one that
  // carries `__globeObjType`, and a shallow lookup silently yields null for every
  // country, which reads as "the filter did nothing".
  const datumOf = (o) => {
    while (o) {
      const d = o.__data && o.__data.data;
      if (d && d.iso) return d;
      o = o.parent;
    }
    return null;
  };
  const pick = (iso) => {
    let out = null;
    window.__globe.scene().traverse((o) => {
      if (o.__globeObjType !== "polygon") return;
      if (datumOf(o)?.iso !== iso) return;
      const cap = o.children[0];
      const m = Array.isArray(cap.material) ? cap.material[1] : null;
      out = m ? +m.opacity.toFixed(3) : null;
    });
    return out;
  };
  // Two countries in different regions, neither of which is the selection.
  const regions = new Map();
  window.__globe.scene().traverse((o) => {
    if (o.__globeObjType !== "polygon") return;
    const d = datumOf(o);
    if (!d || !d.region || regions.has(d.region)) return;
    regions.set(d.region, d.iso);
  });
  const names = Array.from(regions.keys());
  if (names.length < 2) return { err: "not enough regions in the scene" };
  const [inRegion, outRegion] = names;
  // `pick` takes an ISO, not a region name — the map is keyed by region.
  const inIso = regions.get(inRegion);
  const outIso = regions.get(outRegion);
  if (!pick(inIso) || !pick(outIso)) return { err: `could not read opacities for ${inIso}/${outIso}` };

  const chip = Array.from(document.querySelectorAll('nav[aria-label="Filter by region"] button')).find(
    (b) => (b.textContent || "").trim().startsWith(inRegion)
  );
  if (!chip) return { err: `no chip for ${inRegion}` };
  const before = { in: pick(inIso), out: pick(outIso) };
  chip.click();
  await new Promise((r) => setTimeout(r, 700));
  const after = { in: pick(inIso), out: pick(outIso), pressed: chip.getAttribute("aria-pressed") };
  chip.click();
  await new Promise((r) => setTimeout(r, 700));
  const cleared = { in: pick(inIso), out: pick(outIso) };
  return { inRegion, outRegion, inIso, outIso, before, after, cleared };
});
check(
  "region filter dims other regions",
  !regionResult.err &&
    regionResult.after.out < regionResult.before.out &&
    regionResult.after.pressed === "true" &&
    regionResult.cleared.out > regionResult.after.out,
  regionResult.err ??
    `${regionResult.inRegion}/${regionResult.inIso} ${regionResult.before.in} -> ${regionResult.after.in} (kept), ` +
      `${regionResult.outRegion}/${regionResult.outIso} ${regionResult.before.out} -> ${regionResult.after.out} (dimmed) -> ${regionResult.cleared.out} (cleared)`
);

// ---------------------------------------------------------------------------
// 5. Draw calls. The other half of the regression: the old single-map globe spent
// ~8200 per frame; the two-layer build must stay in the hundreds.
// ---------------------------------------------------------------------------
const calls = await page.evaluate(() => window.__globe.renderer().info.render.calls);
check("draw calls stay bounded", calls > 0 && calls < MAX_CALLS, `${calls} (need < ${MAX_CALLS})`);

// ---------------------------------------------------------------------------
// 6 + 7. The player. Both of these shipped broken and neither is about the globe.
// ---------------------------------------------------------------------------
stage("checking the player");
await page.evaluate(() => document.querySelector("li button").click());
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

check("no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));

await browser.close();

const failed = results.filter((r) => !r.pass);
console.log("");
console.log(`${results.length - failed.length}/${results.length} browser checks passed`);
process.exit(failed.length ? 1 : 0);