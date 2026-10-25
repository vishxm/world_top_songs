// Gate for the two-layer render map (see scripts/build-map-layers.mjs).
// The globe silently degrades if these break, so assert them here rather than
// eyeballing a 18fps globe:
//   1. every chart country has a cap — otherwise a real chart is unclickable
//   2. no duplicate ISOs — a dup means two objects fight for the same hover
//   3. winding is Natural Earth's (outer > 0, holes < 0) — three-conic-polygon
//      reads it backwards as "whole sphere complement" and fills the globe
//   4. caps only contain rings that exist in the source map (no invented land)
//   5. the border layer carries every source ring (nothing silently disappears)
//   6. `properties.parts` reconstructs every selectable source polygon, and the
//      no-ISO units stay drawn but ungrouped (drawn-but-unselectable)
//   7. named islands the caps pruned are still present in the land grouping and
//      genuinely absent from the caps — the two must not drift apart
//   8. part budget — this is the draw-call guard, don't let it creep back up
// Usage: node scripts/map-layers-check.mjs
// Exit non-zero on any failure.
import { readFileSync } from "node:fs";

const SRC = "data/maps/world-50m-simple.geojson";
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

// 5b. the hit layer is built from `properties.parts`, so it must reconstruct the
// source exactly. The caps are pruned and must never decide what is clickable.
const grouped = borderFeature?.properties?.parts;
const expectedGrouped = [];
let sourceRing = 0;
let noIsoRings = 0;
for (const f of src.features) {
  const iso = isoOf(f.properties);
  for (const poly of partsOf(f.geometry)) {
    const rings = [];
    for (const ring of poly) {
      if (ring.length < 2) continue;
      rings.push(sourceRing++);
    }
    if (iso && rings.length > 0) expectedGrouped.push({ iso, rings });
    else if (!iso) noIsoRings += rings.length;
  }
}
check(
  Array.isArray(grouped),
  "border layer carries a part grouping",
  Array.isArray(grouped) ? `${grouped.length} parts` : "missing properties.parts"
);
if (Array.isArray(grouped)) {
  const firstDiff = expectedGrouped.findIndex(
    (p, i) => p.iso !== grouped[i]?.iso || JSON.stringify(p.rings) !== JSON.stringify(grouped[i]?.rings)
  );
  check(
    grouped.length === expectedGrouped.length && firstDiff === -1,
    "border parts reconstruct every selectable source polygon",
    firstDiff === -1 && grouped.length === expectedGrouped.length
      ? `${grouped.length} parts across ${new Set(grouped.map((p) => p.iso)).size} ISOs`
      : `expected ${expectedGrouped.length} parts, got ${grouped.length}` +
          (firstDiff === -1 ? "" : `; first differs at ${firstDiff} (${expectedGrouped[firstDiff]?.iso} vs ${grouped[firstDiff]?.iso})`)
  );

  const used = new Set();
  let emptyParts = 0;
  let duplicateRings = 0;
  let outOfBounds = 0;
  let unordered = 0;
  for (const part of grouped) {
    if (!part.rings?.length) emptyParts++;
    let previous = -1;
    for (const i of part.rings ?? []) {
      if (!Number.isInteger(i) || i < 0 || i >= borderRings) outOfBounds++;
      else if (used.has(i)) duplicateRings++;
      else used.add(i);
      if (i <= previous) unordered++;
      previous = i;
    }
  }
  check(emptyParts === 0, "every grouped part has at least one ring", emptyParts ? `${emptyParts} empty` : `${grouped.length} parts`);
  check(duplicateRings === 0, "a border ring belongs to exactly one part", duplicateRings ? `${duplicateRings} duplicated` : "no duplicates");
  check(outOfBounds === 0, "part ring indices are in bounds", outOfBounds ? `${outOfBounds} out of range` : `0..${borderRings - 1}`);
  check(unordered === 0, "part ring indices are ordered outer-first", unordered ? `${unordered} out of order` : "outer then holes");
  check(
    borderRings - used.size === noIsoRings,
    "no-ISO units stay drawn but unselectable",
    `${borderRings - used.size} ungrouped rings (expected ${noIsoRings} from ${src.features.filter((f) => !isoOf(f.properties)).length} units)`
  );
}

// 5c. The named islands the caps prune must exist in the land grouping, and must
// genuinely be absent from the caps, or the clickability test proves nothing.
const NAMED = [
  ["Hawaii", -155.55, 19.6, "US"],
  ["Maui", -156.33, 20.8, "US"],
  ["Tenerife", -16.6, 28.3, "ES"],
  ["Gran Canaria", -15.6, 27.96, "ES"],
  ["Azores", -25.45, 37.78, "PT"],
  ["Madeira", -16.95, 32.75, "PT"],
  ["Jeju", 126.53, 33.5, "KR"],
  ["Galapagos", -90.5, -0.6, "EC"],
  ["Tahiti", -149.5, -17.65, "PF"],
  ["Reunion", 55.5, -21.1, "FR"],
  ["French Guiana", -53, 4, "FR"],
  ["Corsica", 9.1, 42.15, "FR"],
  ["New Caledonia", 165.5, -21.3, "NC"],
  ["Puerto Rico", -66.4, 18.2, "PR"],
  ["Guam", 144.8, 13.45, "GU"],
  ["Falklands", -59, -51.7, "FK"],
  ["Greenland", -42, 72, "GL"],
  ["Singapore", 103.82, 1.35, "SG"],
  ["Malta", 14.45, 35.9, "MT"],
  ["San Marino", 12.45, 43.94, "SM"],
  ["Andorra", 1.6, 42.55, "AD"],
  ["Liechtenstein", 9.55, 47.15, "LI"],
  ["Lesotho", 28.2, -29.6, "LS"],
  ["Eswatini", 31.5, -26.5, "SZ"],
  ["Bahrain", 50.55, 26.05, "BH"],
  ["Brunei", 114.7, 4.5, "BN"],
  ["Timor-Leste", 125.9, -8.8, "TL"],
];
const PRUNED = new Set(["Hawaii", "Maui", "Tenerife", "Gran Canaria", "Azores", "Jeju", "Galapagos"]);
function pointInRing(lng, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function ringContains(lng, lat, ring) {
  return pointInRing(lng, lat, ring) || pointInRing(lng + 360, lat, ring) || pointInRing(lng - 360, lat, ring);
}
function partContains(lng, lat, rings) {
  if (!rings.length || !ringContains(lng, lat, rings[0])) return false;
  for (let i = 1; i < rings.length; i++) if (ringContains(lng, lat, rings[i])) return false;
  return true;
}
const landPolys = Array.isArray(grouped)
  ? grouped.map((p) => ({ iso: p.iso, rings: p.rings.map((i) => borderFeature.geometry.coordinates[i]) }))
  : [];
const capPolys = [];
for (const f of caps.features) {
  for (const poly of partsOf(f.geometry)) capPolys.push({ iso: f.properties.ISO_A2, rings: poly });
}
let missingLand = 0;
let stillCapped = 0;
for (const [name, lng, lat, want] of NAMED) {
  const land = landPolys.filter((p) => partContains(lng, lat, p.rings)).map((p) => p.iso);
  if (!land.includes(want)) {
    missingLand++;
    console.log(`  FAIL ${name}: land grouping has ${land.join(",") || "nothing"}, want ${want}`);
  }
  if (PRUNED.has(name) && capPolys.some((p) => partContains(lng, lat, p.rings))) {
    stillCapped++;
    console.log(`  FAIL ${name}: still present in the caps layer (not actually pruned)`);
  }
}
check(missingLand === 0, "named islands/territories exist in the land grouping", `${NAMED.length - missingLand}/${NAMED.length}`);
check(stillCapped === 0, "named pruned islands are absent from the caps", stillCapped ? `${stillCapped} still capped` : `${PRUNED.size} verified pruned`);

// 8. draw-call budget
let capParts = 0;
for (const f of caps.features) capParts += partsOf(f.geometry).length;
check(capParts <= PART_BUDGET, "cap part budget", `${capParts} parts (budget ${PART_BUDGET}) ~${capParts} draw calls`);

// bonus: nothing that had an ISO in the source lost it
const srcIsos = new Set(src.features.map((f) => isoOf(f.properties)).filter(Boolean));
const lost = [...srcIsos].filter((iso) => !capIsos.has(iso));
check(lost.length === 0, "no country dropped from the caps", lost.length ? lost.join(",") : `${srcIsos.size} carried over`);

// 9. the generated display table covers exactly the caps, no more, no less
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
