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
//   8. one calm theme, with no theme switcher or theme handoff
//   9. back and forward restore the URL-selected country
//  10. bad country codes recover with an explanation, and unknown routes land on
//      the branded recovery screen
//  11. the country picker opens from every shortcut, matches names and ISO codes,
//      marks charted countries, and updates the URL
//  12. Surprise me only ever lands on a charted country
//
// Run it against a dev server. Usage: node scripts/globe-pick-check.mjs [url]
import { chromium } from "playwright";
import { CHART_ISOS } from "../app/lib/countries.ts";

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
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
page.on("console", (m) => {
  // Chromium's own permissions-policy warning from the embedded YouTube iframe
  // is environment noise, not an app error.
  if (m.type() === "error" && !/Permissions policy violation/.test(m.text())) {
    pageErrors.push(m.text().slice(0, 160));
  }
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
 * The independent oracle, installed in the page.
 *
 * Deliberately a reimplementation of the rule rather than a call into the app:
 * hits sorted near→far, the first country cap wins, and the globe sphere ends the
 * search because everything past it is on the far side of the planet. The merged
 * border layer and the selection outline are transparent to the pointer by design.
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
const idleErrors = [];
idlePage.on("pageerror", (e) => idleErrors.push(String(e)));
idlePage.on("console", (m) => {
  if (m.type() === "error" && !/Permissions policy violation/.test(m.text())) {
    idleErrors.push(m.text().slice(0, 160));
  }
});
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

const routePage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const routeErrors = [];
routePage.on("pageerror", (e) => routeErrors.push(String(e)));
routePage.on("console", (m) => {
  if (m.type() === "error" && !/Permissions policy violation/.test(m.text())) {
    routeErrors.push(m.text().slice(0, 160));
  }
});

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

await routePage.close();
await browser.close();

const failed = results.filter((r) => !r.pass);
console.log("");
console.log(`${results.length - failed.length}/${results.length} browser checks passed`);
process.exit(failed.length ? 1 : 0);