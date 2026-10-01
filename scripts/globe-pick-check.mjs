// Hover regression gate for the country selector.
//
// The original bug: every country cap sat at polygonAltitude 0, which three-globe
// applies as a mesh scale of exactly 1 — coplanar with the globe mesh. Z-fighting
// aside, the raycast was numerically unreliable, so hovering/clicking silently
// dropped a large random-looking share of countries.
//
// This asserts the invariant that matters: every pixel whose raycast lands on a
// near-side country cap must produce a hover for that country. Run it against a
// dev server. Usage: node scripts/globe-pick-check.mjs [url]
import { chromium } from "playwright";

const URL_ = process.argv[2] ?? "http://localhost:5173/?c=US";
const MIN_RATE = 0.97;
/** The app must agree with its own scene. The only allowance is the frame of
 *  slop between our raycast and the app's rAF-coalesced one, which matters on
 *  shared borders where the two sides are within a pixel of each other. */
const MAX_WRONG = 0.01;
const STEP = 29; // px between samples; co-prime-ish with the grid to avoid aliasing
/** Keep one in N ocean points. Every hovered pixel costs a real pointer move and
 *  a settled frame, and headless WebGL is CPU-bound, so the gate is paced for
 *  a laptop, not for a workstation. This still sweeps ~300 points of surface. */
const OCEAN_EVERY = 3;
const HOVER_SETTLE_MS = 90;

/** This gate hovers ~1600 pixels one at a time and takes minutes. Progress goes
 *  to stderr so a hang is locatable instead of a silent five-minute wait. */
const stage = (name) => process.stderr.write(`  [${new Date().toISOString().slice(11, 19)}] ${name}\n`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
stage("opening " + URL_);
await page.goto(URL_, { waitUntil: "networkidle" });
stage("waiting for the globe");
await page.waitForFunction(() => !!window.__globe, null, { timeout: 30_000 });
await page.waitForTimeout(2500);
stage("globe ready");

// Park the globe. It idles with autoRotate on, and a rotating globe invalidates
// every sample point between measuring and hovering.
await page.evaluate(() => {
  window.__globe.controls().autoRotate = false;
});

/**
 * The pick the scene says a pixel should produce.
 *
 * This is deliberately an independent reimplementation of the rule rather than
 * a call into the app: hits are sorted near→far, the first country cap wins, and
 * the globe sphere terminates the search because everything past it is on the
 * far side of the planet. The atmosphere shell, the merged border layer and the
 * selection rings are transparent to the pointer by design.
 */
const ORACLE = `
  const typeOf = (o) => { while (o) { if (o.__globeObjType) return o.__globeObjType; o = o.parent; } return null; };
  const datumOf = (o) => { while (o) { const d = o.__data && o.__data.data; if (d && d.iso) return d; o = o.parent; } return null; };
  function oracle(THREE, globe, px, py, W, H) {
    const rc = new THREE.Raycaster();
    rc.setFromCamera(new THREE.Vector2((px / W) * 2 - 1, -(py / H) * 2 + 1), globe.camera());
    for (const hit of rc.intersectObject(globe.scene(), true)) {
      const type = typeOf(hit.object);
      if (type === "polygon") { const d = datumOf(hit.object); return d ? d.iso : null; }
      if (type === "globe") return null;
    }
    return null;
  }
  window.__oracle = oracle;
`;

/**
 * The oracle needs a `Raycaster`, and `three` is bundled into the app rather
 * than exposed on `window`. Vite serves it as a real module from the dev server,
 * so borrow it from there — trying the page's own origin first means this also
 * works against a production server, as long as a dev server is running.
 */
const THREE_URLS = [
  "/node_modules/three/build/three.module.js",
  "http://localhost:5173/node_modules/three/build/three.module.js",
];

const threeSource = await page.evaluate(async (urls) => {
  for (const url of urls) {
    try {
      await import(/* @vite-ignore */ url);
      return url;
    } catch {
      /* try the next one */
    }
  }
  return null;
}, THREE_URLS);
if (!threeSource) {
  throw new Error(
    `could not load three for the oracle. Tried:\n  ${THREE_URLS.join("\n  ")}\n` +
      `Start a dev server (npm run dev) and re-run.`
  );
}

// Install the oracle once. `three` is stashed on `window` so the per-pixel
// evaluates below stay synchronous and cheap; we only borrow the Raycaster.
await page.evaluate(
  async ([src, url]) => {
    window.__THREE = await import(/* @vite-ignore */ url);
    // eslint-disable-next-line no-eval
    eval(src);
  },
  [ORACLE, threeSource]
);

/** Expected pick for a screen pixel, measured against the scene *as it is right
 *  now* (the selection lift changes geometry under a stationary pointer). */
const expectedAt = (x, y) =>
  page.evaluate(
    ([px, py]) => window.__oracle(window.__THREE, window.__globe, px, py, innerWidth, innerHeight),
    [x, y]
  );

/**
 * Screen points to test, split by what the scene says is there:
 *   land  — a near-side cap. The app must name it.
 *   ocean — the globe surface, no cap. The app must name NOTHING. This is the
 *           regression guard for the far-side bug: the library's filter could
 *           only reject the sphere, so the scan ran on past it and reported
 *           countries on the far side of the planet (Tanzania for a pixel over
 *           Brazil) with nothing highlighted on screen at all.
 *
 * One raycast per pixel, classified once. Running the oracle and then a second
 * full-scene raycast to tell ocean from open space doubled the most expensive
 * part of the gate for nothing.
 */
const { land, ocean } = await page.evaluate(
  ([step, oceanEvery]) => {
    const THREE = window.__THREE;
    const globe = window.__globe;
    const W = window.innerWidth;
    const H = window.innerHeight;
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
    const rc = new THREE.Raycaster();
    const land = [];
    const ocean = [];
    let n = 0;
    for (let y = 100; y < H - 100; y += step) {
      for (let x = 80; x < W - 80; x += step) {
        n++;
        rc.setFromCamera(new THREE.Vector2((x / W) * 2 - 1, -(y / H) * 2 + 1), globe.camera());
        let kind = "space";
        for (const h of rc.intersectObject(globe.scene(), true)) {
          const t = typeOf(h.object);
          if (t === "polygon") {
            if (datumOf(h.object)) {
              kind = "land";
            }
            break;
          }
          if (t === "globe") {
            kind = "ocean";
            break;
          }
        }
        if (kind === "land") land.push([x, y]);
        // The ocean sweep is the guard against far-side picks, which are a
        // property of the sphere, not of any one country — a third of the
        // points guard it just as well as all of them, at a third of the cost.
        else if (kind === "ocean" && n % oceanEvery === 0) ocean.push([x, y]);
      }
    }
    return { land, ocean };
  },
  [STEP, OCEAN_EVERY]
);

const missed = [];
const mismatched = [];
const readHover = () =>
  page.evaluate(() => {
    const p = document.querySelector("header p");
    const m = p && /^([A-Z]{2})/.exec(p.textContent ?? "");
    return m ? m[1] : "";
  });

/** This gate hovers ~1600 pixels one at a time and takes minutes. Progress goes
 *  to stderr so a hang is locatable instead of a silent five-minute wait. */
const progress = (label, i, total) => {
  if (i % 100 === 0 || i === total) {
    process.stderr.write(`  [${new Date().toISOString().slice(11, 19)}] ${label} ${i}/${total}\n`);
  }
};

stage(`sampled: ${land.length} land, ${ocean.length} ocean`);
for (const [i, [x, y]] of land.entries()) {
  await page.mouse.move(x, y);
  await page.waitForTimeout(HOVER_SETTLE_MS);
  const hovered = await readHover();
  if (!hovered) {
    // Re-measure now. If the scene no longer has a cap here, the sample list
    // was stale (something moved the camera) and this is not an app miss.
    const still = await expectedAt(x, y);
    missed.push(still ? [x, y, still] : [x, y]);
    progress("land", i + 1, land.length);
    continue;
  }
  const expected = await expectedAt(x, y);
  if (expected && hovered !== expected) mismatched.push([x, y, hovered, expected]);
  progress("land", i + 1, land.length);
}

// Ocean must stay silent. Any ISO here is a country on the hidden hemisphere.
const ghost = [];
for (const [i, [x, y]] of ocean.entries()) {
  await page.mouse.move(x, y);
  await page.waitForTimeout(HOVER_SETTLE_MS);
  const hovered = await readHover();
  if (hovered) ghost.push([x, y, hovered]);
  progress("ocean", i + 1, ocean.length);
}

/**
 * The selection must repaint the caps on its own.
 *
 * The repaint used to hang off the hover only, so it fired when the pointer
 * happened to be over the globe and not otherwise: selecting a country from the
 * ⌘K palette, the region rail, Surprise me or the back button left the PREVIOUS
 * country lit up and the new one unlit until the pointer next moved.
 *
 * Driven through the real picker with the pointer parked off the canvas — the
 * exact case that used to break. A synthetic `pushState` + `popstate` is not
 * enough: React Router owns its own history index and ignores that sequence, so
 * the app never actually changes selection and the check passes for the wrong
 * reason.
 */
const capState = (iso) =>
  page.evaluate((want) => {
    let out = null;
    window.__globe.scene().traverse((o) => {
      if (o.__globeObjType !== "polygon") return;
      const i = o.__data && o.__data.data && o.__data.data.iso;
      if (i !== want) return;
      const cap = o.children[0];
      const m = Array.isArray(cap.material) ? cap.material[1] : null;
      out = { lift: +cap.scale.x.toFixed(4), opacity: m ? +m.opacity.toFixed(2) : null };
    });
    return out;
  }, iso);

// Park the pointer off the globe so nothing repaints by accident.
await page.mouse.move(1400, 450);
stage("checking selection repaint");
const startIso = await page.evaluate(() => new URLSearchParams(location.search).get("c"));

// Open the picker by its header control, then choose the first result. The URL
// reports which country that was, which is more reliable than scraping the ISO
// out of the row's text — the badge and the name are adjacent, so "DZAlgeria"
// has no word boundary for `\b[A-Z]{2}\b` to find.
await page.evaluate(() => {
  document.querySelector('header button[aria-haspopup="dialog"]').click();
});
await page.waitForSelector('[role="listbox"][aria-label="Countries"] li[role="option"] button', {
  timeout: 10_000,
});
await page.evaluate(() => {
  document.querySelector('[role="listbox"] li[role="option"] button').click();
});
await page.waitForTimeout(2200);

const selAfterPick = await page.evaluate(() => new URLSearchParams(location.search).get("c"));
const newCap = await capState(selAfterPick);
const oldCap = await capState(startIso);
// Relative, so it does not have to track CAP_SELECTED: the selection has to have
// actually moved, the new one must be lifted, and the old one must have dropped
// back to the base altitude.
const repaint =
  !!startIso &&
  !!selAfterPick &&
  selAfterPick !== startIso &&
  !!newCap &&
  !!oldCap &&
  newCap.lift > 1.01 &&
  oldCap.lift < 1.01;

// Draw calls: the other half of the regression. The old single-map globe spent
// ~8200 per frame; the two-layer build must stay in the hundreds.
const perf = await page.evaluate(
  () =>
    new Promise((resolve) => {
      let frames = 0;
      const t0 = performance.now();
      const tick = () => {
        frames++;
        if (performance.now() - t0 < 2000) requestAnimationFrame(tick);
        else
          resolve({
            fps: Math.round(frames / ((performance.now() - t0) / 1000)),
            calls: window.__globe.renderer().info.render.calls,
          });
      };
      requestAnimationFrame(tick);
    })
);

const rate = land.length ? (land.length - missed.length) / land.length : 0;
const wrongRate = land.length ? mismatched.length / land.length : 1;
const ok =
  land.length > 100 &&
  ocean.length > 50 &&
  rate >= MIN_RATE &&
  wrongRate <= MAX_WRONG &&
  ghost.length === 0 &&
  repaint &&
  perf.calls < 1200;

console.log(`land pixels sampled : ${land.length}`);
console.log(`hover hit rate      : ${(rate * 100).toFixed(1)}% (need >= ${MIN_RATE * 100}%)`);
console.log(`mismatched country  : ${mismatched.length} (${(wrongRate * 100).toFixed(1)}%, allow <= ${MAX_WRONG * 100}%)`);
console.log(
  `missed samples      : ${missed.slice(0, 8).map((m) => (m[2] ? `${m[0]}@${m[1]}(wants ${m[2]})` : m.join("@"))).join(" ") || "none"}`
);
console.log(`mismatch detail     : ${mismatched.slice(0, 8).map((m) => `${m[0]},${m[1]} app=${m[2]} scene=${m[3]}`).join(" | ") || "none"}`);
console.log(`ocean pixels sampled: ${ocean.length}`);
console.log(
  `far-side picks      : ${ghost.length} (need 0) ${ghost.slice(0, 6).map((g) => `${g[0]},${g[1]}=${g[2]}`).join(" ") || ""}`
);
console.log(
  `selection repaints  : ${repaint ? "yes" : "NO"} (${startIso} -> ${selAfterPick}, new lift ${newCap?.lift}, old ${oldCap?.lift})`
);
console.log(`draw calls / frame  : ${perf.calls} (need < 1200)`);
console.log(`fps                 : ${perf.fps}`);

await browser.close();
console.log(ok ? "globe pick checks passed" : "globe pick checks FAILED");
process.exit(ok ? 0 : 1);