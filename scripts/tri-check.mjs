// Triangulation gate (diagnosing-bugs Phase 1 feedback loop, second half).
// map-check.mjs proves turf point-in-polygon is right; this proves the
// RENDERER agrees: every polygon piece of every country must triangulate
// (via the exact class + args three-globe uses) to a patch smaller than the
// globe. Red-capable: inverted winding (turf boolean-op output) makes
// three-conic-polygon-geometry fill a global grid -> globe-spanning meshes ->
// every hover/click resolves to that country.
// Usage: node scripts/tri-check.mjs [path-to-geojson]
// Exit non-zero on any failure.
globalThis.window = {};
const { readFileSync } = await import("node:fs");
const { default: ConicPolygonGeometry } = await import(
  "three-conic-polygon-geometry"
);

const file = process.argv[2] ?? "public/world-50m-simple.geojson";
const fc = JSON.parse(readFileSync(file, "utf8"));

let failed = 0;
let pieces = 0;

// Fast pre-check: Natural Earth winding is outer shoelace > 0, holes < 0.
// Inverted winding makes the triangulator below fill a global grid (and take
// minutes doing it), so fail immediately instead of hanging.
function shoelace(ring) {
  let s = 0;
  for (let i = 0; i < ring.length - 1; i++)
    s += (ring[i + 1][0] - ring[i][0]) * (ring[i + 1][1] + ring[i][1]);
  return s;
}
for (const feat of fc.features) {
  const name = feat.properties?.NAME ?? "?";
  const polys =
    feat.geometry.type === "Polygon"
      ? [feat.geometry.coordinates]
      : feat.geometry.type === "MultiPolygon"
        ? feat.geometry.coordinates
        : [];
  polys.forEach((poly, i) => {
    if (poly.length > 0 && shoelace(poly[0]) < 0) {
      failed++;
      console.log(`FAIL ${name}[${i}]: outer ring wound clockwise (inverted)`);
    }
    poly.slice(1).forEach((hole, j) => {
      if (shoelace(hole) > 0) {
        failed++;
        console.log(`FAIL ${name}[${i}].hole[${j}]: hole wound ccw (inverted)`);
      }
    });
  });
}
if (failed) {
  console.log(`${failed} winding errors — skipping triangulation`);
  process.exit(1);
}
for (const feat of fc.features) {
  const name = feat.properties?.NAME ?? "?";
  const polys =
    feat.geometry.type === "Polygon"
      ? [feat.geometry.coordinates]
      : feat.geometry.type === "MultiPolygon"
        ? feat.geometry.coordinates
        : [];
  polys.forEach((poly, i) => {
    pieces++;
    let g;
    try {
      // Same invocation as three-globe: bottom 0, top GLOBE_RADIUS,
      // cap+side on, curvature resolution 5 (its default).
      g = new ConicPolygonGeometry(poly, 0, 100, false, true, true, 5);
    } catch (e) {
      failed++;
      console.log(`FAIL ${name}[${i}]: threw ${String(e).slice(0, 80)}`);
      return;
    }
    const p = g.attributes.position;
    let mnx = 1e9, mxx = -1e9, mny = 1e9, mxy = -1e9, mnz = 1e9, mxz = -1e9;
    for (let v = 0; v < p.count; v++) {
      const x = p.getX(v), y = p.getY(v), z = p.getZ(v);
      if (x < mnx) mnx = x;
      if (x > mxx) mxx = x;
      if (y < mny) mny = y;
      if (y > mxy) mxy = y;
      if (z < mnz) mnz = z;
      if (z > mxz) mxz = z;
    }
    if ([mxx - mnx, mxy - mny, mxz - mnz].every((s) => s > 150)) {
      failed++;
      console.log(`FAIL ${name}[${i}]: triangulates globe-spanning`);
    }
  });
}

console.log(
  failed
    ? `${failed}/${pieces} pieces FAILED triangulation`
    : `all ${pieces} pieces triangulate to local patches`
);
process.exit(failed ? 1 : 0);
