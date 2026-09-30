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
const STEP = 19; // px between samples; co-prime-ish with the grid to avoid aliasing

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(URL_, { waitUntil: "networkidle" });
await page.waitForFunction(() => !!window.__globe, null, { timeout: 30_000 });
await page.waitForTimeout(2500);

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
 */
const { land, ocean } = await page.evaluate((step) => {
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
  const rc = new THREE.Raycaster();
  const land = [];
  const ocean = [];
  for (let y = 100; y < H - 100; y += step) {
    for (let x = 80; x < W - 80; x += step) {
      if (window.__oracle(THREE, globe, x, y, W, H)) {
        land.push([x, y]);
        continue;
      }
      // Over water (or off the globe entirely) if the surface itself is hit and
      // no cap is in front of it.
      rc.setFromCamera(new THREE.Vector2((x / W) * 2 - 1, -(y / H) * 2 + 1), globe.camera());
      for (const h of rc.intersectObject(globe.scene(), true)) {
        const t = typeOf(h.object);
        if (t === "polygon") break;
        if (t === "globe") {
          ocean.push([x, y]);
          break;
        }
      }
    }
  }
  return { land, ocean };
}, STEP);

const missed = [];
const mismatched = [];
const readHover = () =>
  page.evaluate(() => {
    const p = document.querySelector("header p");
    const m = p && /^([A-Z]{2})/.exec(p.textContent ?? "");
    return m ? m[1] : "";
  });

for (const [x, y] of land) {
  await page.mouse.move(x, y);
  await page.waitForTimeout(120);
  const hovered = await readHover();
  if (!hovered) {
    // Re-measure now. If the scene no longer has a cap here, the sample list
    // was stale (something moved the camera) and this is not an app miss.
    const still = await expectedAt(x, y);
    missed.push(still ? [x, y, still] : [x, y]);
    continue;
  }
  const expected = await expectedAt(x, y);
  if (expected && hovered !== expected) mismatched.push([x, y, hovered, expected]);
}

// Ocean must stay silent. Any ISO here is a country on the hidden hemisphere.
const ghost = [];
for (const [x, y] of ocean) {
  await page.mouse.move(x, y);
  await page.waitForTimeout(70);
  const hovered = await readHover();
  if (hovered) ghost.push([x, y, hovered]);
}

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
  ocean.length > 100 &&
  rate >= MIN_RATE &&
  wrongRate <= MAX_WRONG &&
  ghost.length === 0 &&
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
console.log(`draw calls / frame  : ${perf.calls} (need < 1200)`);
console.log(`fps                 : ${perf.fps}`);

await browser.close();
console.log(ok ? "globe pick checks passed" : "globe pick checks FAILED");
process.exit(ok ? 0 : 1);