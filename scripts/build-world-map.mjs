// Build the world map from scratch: Natural Earth 50m for every country,
// patched ONLY along the Kashmir dispute with the Survey-of-India claim
// line (datameet india-composite), applied symmetrically — whatever India
// gains is cut from Pakistan/China, so overlaps are zero by construction.
// Usage: node scripts/build-world-map.mjs
// Inputs: /tmp/ne50m.geojson, /tmp/datameet_india.geojson
// Output: public/world-50m.geojson
// Gate: node scripts/map-check.mjs public/world-50m.geojson (must pass)
import { readFileSync, writeFileSync } from "node:fs";
import { union } from "@turf/union";
import { difference } from "@turf/difference";
import { intersect } from "@turf/intersect";
import { featureCollection } from "@turf/helpers";
import area from "@turf/area";

const ne = JSON.parse(readFileSync("/tmp/ne50m.geojson", "utf8"));
const dm = JSON.parse(readFileSync("/tmp/datameet_india.geojson", "utf8"));
const dmIndia = dm.features.find((f) =>
  ["MultiPolygon", "Polygon"].includes(f.geometry?.type)
);
if (!dmIndia) throw new Error("datameet India geometry missing");

const byName = (n) => ne.features.find((f) => f.properties?.NAME === n);
const india = byName("India");
const pakistan = byName("Pakistan");
const china = byName("China");
if (!india || !pakistan || !china) throw new Error("IN/PK/CN features missing");

function tryOp(op, a, b) {
  try {
    return op(featureCollection([a, b]));
  } catch {
    return op(a, b);
  }
}

// The claim: everything the Survey-of-India line places inside India but
// Natural Earth assigns to Pakistan or China (PoK + Aksai Chin + K2 sector).
const pakChina = tryOp(union, pakistan, china);
const claim = tryOp(intersect, dmIndia, pakChina);
if (!claim) throw new Error("claim intersection failed");
console.log(`claim area: ${(area(claim) / 1e6).toFixed(0)} km²`);

const indiaNew = tryOp(union, india, claim);
const pakNew = tryOp(difference, pakistan, claim);
const chinaNew = tryOp(difference, china, claim);
if (!indiaNew || !pakNew || !chinaNew) throw new Error("boolean ops failed");

// Restore country properties (turf drops them); picking keys on these.
indiaNew.properties = india.properties;
pakNew.properties = pakistan.properties;
chinaNew.properties = china.properties;

// Rewind boolean-op output to Natural Earth's winding (outer shoelace > 0,
// holes < 0). turf emits the opposite, and three-conic-polygon-geometry
// interprets that as whole-sphere-complement: it fills a global grid,
// renders globe-spanning meshes, and raycasting returns that country for
// every pointer position. Verified: reversed sliver triangulates 200-span,
// rewound triangulates to its true patch (see scripts/tri-check.mjs).
function shoelace(ring) {
  let s = 0;
  for (let i = 0; i < ring.length - 1; i++)
    s += (ring[i + 1][0] - ring[i][0]) * (ring[i + 1][1] + ring[i][1]);
  return s;
}
function rewindGeometry(geom) {
  const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
  for (const poly of polys) {
    if (poly.length > 0 && shoelace(poly[0]) < 0) poly[0] = [...poly[0]].reverse();
    for (let i = 1; i < poly.length; i++)
      if (shoelace(poly[i]) > 0) poly[i] = [...poly[i]].reverse();
  }
}
for (const f of [indiaNew, pakNew, chinaNew]) rewindGeometry(f.geometry);

const out = {
  type: "FeatureCollection",
  features: ne.features.map((f) => {
    if (f.properties?.NAME === "India") return indiaNew;
    if (f.properties?.NAME === "Pakistan") return pakNew;
    if (f.properties?.NAME === "China") return chinaNew;
    return f;
  }),
};
writeFileSync("public/world-50m.geojson", JSON.stringify(out));
console.log("wrote public/world-50m.geojson");
