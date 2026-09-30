// Render-thinning for the globe: Natural Earth 50m triangulated + raycast on
// every pointermove freezes the page (40 hovers -> 30 longtasks). This cuts
// vertex count while keeping the Survey-of-India Kashmir claim intact.
// Usage: node scripts/simplify-map.mjs
// Input: public/world-50m.geojson (source of truth, never modified)
// Output: public/world-50m-simple.geojson (what the globe renders)
// Gate: node scripts/map-check.mjs public/world-50m-simple.geojson (must pass)
import { readFileSync, writeFileSync } from "node:fs";
import { simplify } from "@turf/simplify";

// Degrees. The dispute trio keeps near-full fidelity so the claim line and
// probe points never move; the rest (Russia/Canada/USA/...) sheds vertices
// aggressively. 0.02° ≈ 2km — invisible on a globe.
const TOL_TRIO = 0.002;
const TOL_REST = 0.02;
const TRIO = new Set(["India", "Pakistan", "China"]);

const src = JSON.parse(readFileSync("public/world-50m.geojson", "utf8"));

function roundCoords(c) {
  if (typeof c[0] === "number") return [Math.round(c[0] * 1e4) / 1e4, Math.round(c[1] * 1e4) / 1e4];
  return c.map(roundCoords);
}

let before = 0;
let after = 0;
const count = (coords) => {
  const stack = [coords];
  while (stack.length) {
    const x = stack.pop();
    if (!x.length) continue;
    if (typeof x[0] === "number") after++;
    else for (let i = 0; i < x.length; i++) stack.push(x[i]);
  }
};
const countSrc = (coords) => {
  const stack = [coords];
  while (stack.length) {
    const x = stack.pop();
    if (!x.length) continue;
    if (typeof x[0] === "number") before++;
    else for (let i = 0; i < x.length; i++) stack.push(x[i]);
  }
};

const features = src.features.map((f) => {
  countSrc(f.geometry.coordinates);
  const tol = TRIO.has(f.properties?.NAME) ? TOL_TRIO : TOL_REST;
  const s = simplify(f, { tolerance: tol, highQuality: false, mutate: false });
  s.properties = f.properties;
  s.geometry.coordinates = roundCoords(s.geometry.coordinates);
  count(s.geometry.coordinates);
  return s;
});

writeFileSync("public/world-50m-simple.geojson", JSON.stringify({ type: "FeatureCollection", features }));
console.log(`verts ${before} -> ${after} (${Math.round((1 - after / before) * 100)}% fewer)`);
