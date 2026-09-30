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
/** Adjacent countries are simplified independently, so their coastlines do not
 *  abut perfectly. A pixel right on a coast can legitimately pick the
 *  neighbour; only a larger share of that would indicate a real mis-pick. */
const MAX_WRONG = 0.06;
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

/** Screen pixels whose nearest hit is a country cap, with the country's ISO. */
const samples = await page.evaluate(async (step) => {
  const THREE = await import("/node_modules/three/build/three.module.js");
  const globe = window.__globe;
  const cam = globe.camera();
  const scene = globe.scene();
  const W = window.innerWidth;
  const H = window.innerHeight;
  const group = scene.children.find((c) => c.constructor.name === "Globe");
  const rc = new THREE.Raycaster();
  const out = [];
  for (let y = 100; y < H - 100; y += step) {
    for (let x = 80; x < W - 80; x += step) {
      rc.setFromCamera(new THREE.Vector2((x / W) * 2 - 1, -(y / H) * 2 + 1), cam);
      const hits = rc.intersectObjects([group], true);
      let capHit = null;
      let globeHit = null;
      for (const h of hits) {
        let o = h.object;
        while (o && !Object.prototype.hasOwnProperty.call(o, "__globeObjType")) o = o.parent;
        if (!o) continue;
        const type = o.__globeObjType;
        // The merged border layer and the atmosphere shell are never the pick.
        if (type === "custom" || type === "atmosphere") continue;
        if (type === "globe" && !globeHit) globeHit = h;
        else if (type === "polygon" && !capHit) capHit = h;
      }
      // Only near-side caps: one behind the sphere is not a visible country.
      if (capHit && (!globeHit || capHit.distance < globeHit.distance)) {
        // __data lives on the polygon Group, not on the hit Mesh child.
        let g = capHit.object;
        while (g && !g.__data) g = g.parent;
        const datum = g && g.__data && g.__data.data;
        if (datum && datum.iso) out.push([x, y, datum.iso]);
      }
    }
  }
  return out;
}, STEP);

const missed = [];
let wrongCountry = 0;
for (const [x, y, iso] of samples) {
  await page.mouse.move(x, y);
  await page.waitForTimeout(120);
  const hovered = await page.evaluate(() => {
    const p = document.querySelector("header p");
    const m = p && /^([A-Z]{2})/.exec(p.textContent ?? "");
    return m ? m[1] : "";
  });
  if (!hovered) missed.push([x, y, iso]);
  else if (hovered !== iso) wrongCountry++;
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

const rate = samples.length ? (samples.length - missed.length) / samples.length : 0;
const wrongRate = samples.length ? wrongCountry / samples.length : 1;
const ok =
  samples.length > 100 && rate >= MIN_RATE && wrongRate <= MAX_WRONG && perf.calls < 1200;

console.log(`land pixels sampled : ${samples.length}`);
console.log(`hover hit rate      : ${(rate * 100).toFixed(1)}% (need >= ${MIN_RATE * 100}%)`);
console.log(`neighbour pick      : ${wrongCountry} (${(wrongRate * 100).toFixed(1)}%, allow <= ${MAX_WRONG * 100}%)`);
console.log(`missed samples      : ${missed.slice(0, 8).map((m) => m.join("@")).join(" ") || "none"}`);
console.log(`draw calls / frame  : ${perf.calls} (need < 1200)`);
console.log(`fps                 : ${perf.fps}`);

await browser.close();
console.log(ok ? "globe pick checks passed" : "globe pick checks FAILED");
process.exit(ok ? 0 : 1);