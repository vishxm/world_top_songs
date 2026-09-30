// Split the render map into the two layers the globe actually draws:
//
//   public/country-caps.geojson    - one fill+hit target per country, built from
//                                    the largest polygon parts only (~250 objects)
//   public/country-borders.geojson - EVERY 50m border ring merged into a single
//                                    MultiLineString (1 object, 1 draw call)
//
// Why: three-globe turns each polygon part into its own Mesh+LineSegments pair.
// The simplified 50m map has ~1650 parts (island nations dominate), which meant
// ~8200 draw calls a frame and a 18fps globe. Caps carry the interaction, borders
// carry the detail, so caps can be pruned and borders can be merged.
//
// Dropped cap parts stay visible as outlines — the border layer is full fidelity.
//
// Usage:  node scripts/build-map-layers.mjs
// Input:  public/world-50m-simple.geojson (what the globe renders; winding-correct)
// Gate:   node scripts/map-layers-check.mjs (must pass)
import { readFileSync, writeFileSync } from "node:fs";

const SRC = "public/world-50m-simple.geojson";
const CAPS_OUT = "public/country-caps.geojson";
const BORDERS_OUT = "public/country-borders.geojson";

// Which parts of a country get a fill + hit target. Archipelagos dominate the
// part count (Japan/Indonesia/Philippines alone are ~400), so we keep the parts
// that carry the country's visual mass and drop the long tail. Everything
// dropped still draws, as outline, from the border layer.
//
//   - the largest part is always kept, so every country stays clickable
//   - stop once the kept parts cover COVERAGE of the country's total area
//   - never keep a part below MIN_KM2 (Singapore is 735 km2 and must survive)
//   - never keep more than MAX_PARTS (bounds the worst case)
const COVERAGE = 0.85;
const MAX_PARTS_CHART = 8;
const MAX_PARTS_OTHER = 3;
const MIN_KM2_CHART = 1; // Singapore (735 km2) and Malta (316 km2) must survive
const MIN_KM2_OTHER = 900;

// Natural Earth ships "-99" for these. France/Norway are real chart countries;
// Taiwan is too (and was unreachable until this map was added).
const ISO_BY_NAME = { France: "FR", Norway: "NO", Taiwan: "TW" };

/** ISO 3166-1 alpha-2 for a Natural Earth feature, or null when it is a
 *  territory/disputed unit we deliberately do not make selectable. */
function isoOf(props) {
  const a2 = props?.ISO_A2;
  if (typeof a2 === "string" && /^[A-Z]{2}$/.test(a2)) return a2;
  return ISO_BY_NAME[props?.NAME] ?? null;
}

/** Countries with a real per-country chart. Parsed out of the TS source so the
 *  build can never drift from the runtime list. */
function chartCountries() {
  const src = readFileSync("app/lib/countries.ts", "utf8");
  const block = src.slice(src.indexOf("CHART_COUNTRIES"));
  const body = block.slice(block.indexOf("{") + 1, block.indexOf("}"));
  const out = new Set();
  for (const m of body.matchAll(/([A-Z]{2}):/g)) out.add(m[1]);
  if (out.size < 40) throw new Error(`chart country list looks wrong (${out.size} entries)`);
  return out;
}

/** Spherical area of a lon/lat ring in km2 (outer rings are positive). */
function ringAreaKm2(ring) {
  if (ring.length < 4) return 0;
  const rad = Math.PI / 180;
  let total = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [x1, y1] = ring[j];
    const [x2, y2] = ring[i];
    total += (x2 - x1) * rad * (2 + Math.sin(y1 * rad) + Math.sin(y2 * rad));
  }
  return Math.abs((total * 6371 * 6371) / 2);
}

function polygonAreaKm2(poly) {
  // Holes only subtract, but a part with no outer ring has no area at all.
  let a = ringAreaKm2(poly[0] ?? []);
  for (let i = 1; i < poly.length; i++) a -= ringAreaKm2(poly[i]);
  return Math.max(0, a);
}

function partsOf(geometry) {
  return geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
}

function roundCoords(c, dp) {
  const k = 10 ** dp;
  if (typeof c[0] === "number") return [Math.round(c[0] * k) / k, Math.round(c[1] * k) / k, ...(c.length > 2 ? [c[2]] : [])];
  return c.map((x) => roundCoords(x, dp));
}

const src = JSON.parse(readFileSync(SRC, "utf8"));
const chart = chartCountries();

// ---------------------------------------------------------------- borders
// Every ring of every feature, outer and hole alike, as one MultiLineString.
const borderLines = [];
let borderRings = 0;
for (const f of src.features) {
  for (const poly of partsOf(f.geometry)) {
    for (const ring of poly) {
      if (ring.length < 2) continue;
      borderLines.push(roundCoords(ring, 4));
      borderRings++;
    }
  }
}
const borders = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { kind: "borders" },
      geometry: { type: "MultiLineString", coordinates: borderLines },
    },
  ],
};

// ------------------------------------------------------------------ caps
const caps = [];
let droppedParts = 0;
let selectable = 0;
for (const f of src.features) {
  const iso = isoOf(f.properties);
  if (!iso) continue; // Kosovo, N. Cyprus, Somaliland, Siachen, ocean territories
  const isChart = chart.has(iso);
  const maxParts = isChart ? MAX_PARTS_CHART : MAX_PARTS_OTHER;
  const minKm2 = isChart ? MIN_KM2_CHART : MIN_KM2_OTHER;

  const parts = partsOf(f.geometry);
  const areas = parts.map(polygonAreaKm2);
  const totalArea = areas.reduce((a, b) => a + b, 0);

  // Rank by area so the visually load-bearing parts survive first.
  const order = areas.map((area, i) => ({ area, i })).sort((a, b) => b.area - a.area);
  const chosen = new Set();
  let keptArea = 0;
  for (let rank = 0; rank < order.length; rank++) {
    const { area, i } = order[rank];
    if (rank > 0) {
      if (rank >= maxParts) break;
      if (area < minKm2) break;
      if (keptArea >= totalArea * COVERAGE) break;
    }
    chosen.add(i);
    keptArea += area;
  }
  droppedParts += parts.length - chosen.size;
  if (chosen.size === 0) continue;

  const kept = [...chosen].sort((a, b) => a - b).map((i) => parts[i]);
  caps.push({
    type: "Feature",
    properties: {
      ISO_A2: iso,
      NAME: f.properties.NAME,
      // Carried through so the UI can group/filter without shipping a second table.
      CONTINENT: f.properties.CONTINENT ?? "Other",
      REGION: f.properties.REGION_UN ?? f.properties.CONTINENT ?? "Other",
    },
    geometry:
      kept.length === 1
        ? { type: "Polygon", coordinates: roundCoords(kept[0], 4) }
        : { type: "MultiPolygon", coordinates: kept.map((p) => roundCoords(p, 4)) },
  });
  selectable++;
}

// ----------------------------------------------------------------- write
writeFileSync(CAPS_OUT, JSON.stringify({ type: "FeatureCollection", features: caps }));
writeFileSync(BORDERS_OUT, JSON.stringify(borders));

const capParts = caps.reduce((n, f) => n + partsOf(f.geometry).length, 0);
console.log(`caps    ${selectable} countries / ${capParts} parts  (dropped ${droppedParts})`);
console.log(`borders ${borderRings} rings in 1 MultiLineString`);
console.log(`wrote ${CAPS_OUT} + ${BORDERS_OUT}`);
