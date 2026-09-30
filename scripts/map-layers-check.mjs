// Gate for the two-layer render map (see scripts/build-map-layers.mjs).
// The globe silently degrades if these break, so assert them here rather than
// eyeballing a 18fps globe:
//   1. every chart country has a cap — otherwise a real chart is unclickable
//   2. no duplicate ISOs — a dup means two objects fight for the same hover
//   3. winding is Natural Earth's (outer > 0, holes < 0) — three-conic-polygon
//      reads it backwards as "whole sphere complement" and fills the globe
//   4. caps only contain rings that exist in the source map (no invented land)
//   5. the border layer carries every source ring (nothing silently disappears)
//   6. part budget — this is the draw-call guard, don't let it creep back up
// Usage: node scripts/map-layers-check.mjs
// Exit non-zero on any failure.
import { readFileSync } from "node:fs";

const SRC = "public/world-50m-simple.geojson";
const CAPS = "public/country-caps.geojson";
const BORDERS = "public/country-borders.geojson";
const PART_BUDGET = 400;

const src = JSON.parse(readFileSync(SRC, "utf8"));
const caps = JSON.parse(readFileSync(CAPS, "utf8"));
const borders = JSON.parse(readFileSync(BORDERS, "utf8"));

const ISO_BY_NAME = { France: "FR", Norway: "NO", Taiwan: "TW" };
function isoOf(p) {
  const a2 = p?.ISO_A2;
  if (typeof a2 === "string" && /^[A-Z]{2}$/.test(a2)) return a2;
  return ISO_BY_NAME[p?.NAME] ?? null;
}
function chartCountries() {
  const s = readFileSync("app/lib/countries.ts", "utf8");
  const block = s.slice(s.indexOf("CHART_COUNTRIES"));
  const body = block.slice(block.indexOf("{") + 1, block.indexOf("}"));
  return new Set([...body.matchAll(/([A-Z]{2}):/g)].map((m) => m[1]));
}
const partsOf = (g) => (g.type === "Polygon" ? [g.coordinates] : g.coordinates);
const key = (r) => r.map(([x, y]) => `${x},${y}`).join(" ");

let failed = 0;
const check = (ok, label, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? `: ${detail}` : ""}`);
};

// 1. coverage of chart countries
const capIsos = new Set(caps.features.map((f) => f.properties.ISO_A2));
const chart = chartCountries();
const missing = [...chart].filter((iso) => !capIsos.has(iso));
check(missing.length === 0, "every chart country has a cap", missing.length ? `missing ${missing.join(",")}` : `${chart.size} countries`);

// 2. no duplicate ISOs
const seen = new Set();
const dupes = [];
for (const f of caps.features) {
  if (seen.has(f.properties.ISO_A2)) dupes.push(f.properties.ISO_A2);
  seen.add(f.properties.ISO_A2);
}
check(dupes.length === 0, "no duplicate cap ISOs", dupes.length ? dupes.join(",") : `${seen.size} unique`);

// 3. winding
let badWinding = 0;
const shoelace = (ring) => {
  let s = 0;
  for (let i = 0; i < ring.length - 1; i++) s += (ring[i + 1][0] - ring[i][0]) * (ring[i + 1][1] + ring[i][1]);
  return s;
};
for (const f of caps.features) {
  for (const poly of partsOf(f.geometry)) {
    if (!poly.length) continue;
    if (shoelace(poly[0]) <= 0) badWinding++;
    for (let i = 1; i < poly.length; i++) if (shoelace(poly[i]) >= 0) badWinding++;
  }
}
check(badWinding === 0, "cap winding is Natural Earth order", badWinding ? `${badWinding} rings inverted` : "outer > 0, holes < 0");

// 4. caps are a subset of the source geometry
const srcRings = new Set();
for (const f of src.features) for (const poly of partsOf(f.geometry)) for (const r of poly) srcRings.add(key(r));
let invented = 0;
for (const f of caps.features) for (const poly of partsOf(f.geometry)) for (const r of poly) if (!srcRings.has(key(r))) invented++;
check(invented === 0, "cap rings all come from the source map", invented ? `${invented} invented` : "no invented geometry");

// 5. border layer carries every source ring
let srcRingsN = 0;
for (const f of src.features) for (const poly of partsOf(f.geometry)) srcRingsN += poly.length;
const borderFeature = borders.features[0];
const borderRings = borderFeature?.geometry?.type === "MultiLineString" ? borderFeature.geometry.coordinates.length : 0;
check(borders.features.length === 1 && borderRings === srcRingsN, "border layer carries every source ring", `${borderRings}/${srcRingsN}`);

// 6. draw-call budget
let capParts = 0;
for (const f of caps.features) capParts += partsOf(f.geometry).length;
check(capParts <= PART_BUDGET, "cap part budget", `${capParts} parts (budget ${PART_BUDGET}) ~${capParts} draw calls`);

// bonus: nothing that had an ISO in the source lost it
const srcIsos = new Set(src.features.map((f) => isoOf(f.properties)).filter(Boolean));
const lost = [...srcIsos].filter((iso) => !capIsos.has(iso));
check(lost.length === 0, "no country dropped from the caps", lost.length ? lost.join(",") : `${srcIsos.size} carried over`);

// 7. the generated display table covers exactly the caps, no more, no less
const meta = readFileSync("app/lib/countryMeta.ts", "utf8");
const metaIsos = new Set([...meta.slice(meta.indexOf("COUNTRY_META")).matchAll(/^ {2}([A-Z]{2}): \{/gm)].map((m) => m[1]));
const metaMissing = [...capIsos].filter((iso) => !metaIsos.has(iso));
const metaExtra = [...metaIsos].filter((iso) => !capIsos.has(iso));
check(
  metaMissing.length === 0 && metaExtra.length === 0,
  "countryMeta matches the caps map",
  [metaMissing.length ? `missing ${metaMissing.join(",")}` : "", metaExtra.length ? `stale ${metaExtra.join(",")}` : ""].filter(Boolean).join("; ") || `${metaIsos.size} in sync`
);

console.log(failed ? `${failed} map-layer checks FAILED` : "all map-layer checks passed");
process.exit(failed ? 1 : 0);
