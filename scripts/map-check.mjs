// Map feedback loop (diagnosing-bugs Phase 1).
// Red-capable: asserts the user's exact symptoms —
//   1. clicks in PoK/Aksai Chin must resolve to India (and ONLY India),
//   2. India/Pakistan/China polygons must not overlap (overlap = ambiguous
//      globe picks + flicker along the seam).
// Usage: node scripts/map-check.mjs [path-to-geojson]
// Exit non-zero on any failure.
import { readFileSync } from "node:fs";
import { featureCollection, point } from "@turf/helpers";
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import area from "@turf/area";
import { difference } from "@turf/difference";

const file = process.argv[2] ?? "public/world-50m.geojson";
const fc = JSON.parse(readFileSync(file, "utf8"));
const feats = fc.features;
const byName = (n) => feats.find((f) => f.properties?.NAME === n);

function containing(lng, lat) {
  const pt = point([lng, lat]);
  return feats.filter((f) => {
    try {
      return booleanPointInPolygon(pt, f);
    } catch {
      return false;
    }
  });
}

// [label, lng, lat, expected ISO-ish NAME]
const POINTS = [
  ["Srinagar", 74.8, 34.08, "India"],
  ["Muzaffarabad (AJK)", 73.47, 34.37, "India"],
  ["Gilgit (GB)", 74.3, 35.9, "India"],
  ["Skardu (GB)", 75.63, 35.29, "India"],
  ["Leh (Ladakh)", 77.58, 34.15, "India"],
  ["Depsang (Aksai Chin)", 79.2, 35.0, "India"],
  ["Galwan valley", 78.5, 34.7, "India"],
  ["Pangong north bank", 78.9, 33.95, "India"],
  ["K2 / Baltoro", 76.51, 35.88, "India"],
  ["Delhi", 77.2, 28.61, "India"],
  ["Lahore", 74.34, 31.55, "Pakistan"],
  ["Islamabad", 73.05, 33.7, "Pakistan"],
  ["Rutog (Tibet, not claimed)", 79.73, 33.39, "China"],
  ["Lhasa (China intact)", 91.1, 29.65, "China"],
];

let failed = 0;
for (const [label, lng, lat, want] of POINTS) {
  const hit = containing(lng, lat).map((f) => f.properties?.NAME);
  const ok = hit.length === 1 && hit[0] === want;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}: want [${want}], got [${hit.join(", ") || "none"}]`);
}

function overlapAreaSqM(a, b) {
  try {
    const diff = difference(featureCollection([a, b]));
    if (!diff) return area(a); // B fully covers A
    return Math.max(0, area(a) - area(diff));
  } catch {
    return NaN;
  }
}

const india = byName("India");
const pakistan = byName("Pakistan");
const china = byName("China");
for (const [label, a, b] of [["India∩Pakistan", india, pakistan], ["India∩China", india, china]]) {
  const ov = overlapAreaSqM(a, b);
  const ok = Number.isFinite(ov) && ov < 1e8; // <100 km² tolerance for resampling fuzz
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} overlap ${label}: ${(ov / 1e6).toFixed(1)} km²`);
}

console.log(failed ? `${failed} map checks FAILED` : "all map checks passed");
process.exit(failed ? 1 : 0);
