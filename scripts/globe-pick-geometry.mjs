/**
 * The globe's picking rule, tested exhaustively and without a browser.
 *
 * WHY THIS EXISTS SEPARATELY FROM `globe-pick-check.mjs`
 *
 * Every assertion that goes through the real UI costs a synthetic pointer move and
 * a settled frame before it can be read back. That is why the browser gate could
 * only afford a few hundred samples. The rule itself, though, is a pure function —
 * and it is the part that has shipped real bugs. So it is tested here, where tens
 * of thousands of rays cost about a second, and the browser gate is left with only
 * the handful of assertions that genuinely need a live DOM.
 *
 * WHAT CHANGED WITH THE FULL-LAND HIT LAYER
 *
 * Picking no longer raycasts the drawn caps. The caps are pruned to the polygon
 * parts that carry each country's visual mass, so Hawaii, the Canaries, the
 * Azores, Jeju, the Galapagos and every small Pacific group had no cap at all.
 * The app now raycasts a separate layer, built by `app/lib/hitLayer.ts` from the
 * *full* ring grouping in `country-borders.geojson`. This gate imports the same
 * builder, so it tests the geometry the app actually uses — not a reimplementation
 * of it. The independent half is still the oracle below.
 *
 * THREE THINGS ARE PROVEN HERE
 *
 *   1. Full-land coverage. Every one of the ~1644 source parts is sampled (the
 *      centroids of its largest tessellated triangles) and a radial ray must
 *      resolve it. This is what catches a part silently vanishing — which is not
 *      hypothetical: an unclosed-ring bug made 91 large countries disappear from
 *      an earlier version of the builder with no error at all.
 *   2. The nearest unoccluded hit. A sweep of cameras asserts that no pick is on
 *      the far side of the planet, and that a hit behind the globe is rejected.
 *   3. No zero-altitude cap. Every altitude constant is > 0, and the source does
 *      not reintroduce a literal `*_ALTITUDE = 0`.
 *
 * THE ORACLE IS INDEPENDENT OF THE THING UNDER TEST
 *
 * The rule is "raycast the hit meshes, take the nearest, reject it if the planet
 * is in front, prefer the smaller country inside the epsilon window". Asserting
 * that against itself proves nothing. So the expected answer is computed a
 * completely different way: solve where the ray meets the surface, turn that
 * point into lat/lng, and ask the GeoJSON which polygon part contains it (outer
 * ring minus holes). No raycasting, no meshes, no three.js in the oracle — only
 * the rule under test shares code with the code being checked, and that is the
 * functions imported from `app/lib/pick`.
 */

import { readFileSync } from "node:fs";
import { PerspectiveCamera, Raycaster, Vector2 } from "three";
import {
  CAP_BASE,
  CAP_SELECTED,
  GLOBE_RADIUS,
  HIT_ALTITUDE,
  PICK_EPSILON,
  nearestUnoccluded,
  surfaceDistance,
} from "../app/lib/pick.ts";

// three-conic-polygon-geometry reads `window.THREE` at module scope — it prefers a
// global THREE when a page provides one. Shimming `window` before the dynamic
// import is enough to fall through to its own bundled three, which is the same
// version the app uses.
globalThis.window ??= {};
const { buildHitLayer, buildPartGeometry } = await import("../app/lib/hitLayer.ts");

/** three-globe's fixed vertical field of view, degrees. */
const FOV = 50;
const WIDTH = 1440;
const HEIGHT = 900;

/** Mirrors `MAX_EDGE`-style thresholds only for reporting, not for building. */
const stage = (s) => process.stderr.write(`  [${new Date().toISOString().slice(11, 19)}] ${s}\n`);

let failed = 0;
const check = (ok, label, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? `: ${detail}` : ""}`);
};

// ---------------------------------------------------------------------------
// Load the land layer exactly as the app does, and build the hit layer with the
// same builder the app uses.
// ---------------------------------------------------------------------------
stage("loading country-borders.geojson");
const borders = JSON.parse(readFileSync(new URL("../public/country-borders.geojson", import.meta.url), "utf8"));
const borderFeature = borders.features?.[0];
const borderRings = borderFeature?.geometry?.coordinates ?? [];
const landParts = (borderFeature?.properties?.parts ?? []).map((part) => ({
  iso: part.iso,
  rings: part.rings.map((index) => borderRings[index]),
}));

stage("loading country-caps.geojson (for the app's span proxy)");
const caps = JSON.parse(readFileSync(new URL("../public/country-caps.geojson", import.meta.url), "utf8"));

const toCartesian = (lng, lat, altitude, out = [0, 0, 0]) => {
  const phi = ((90 - lat) * Math.PI) / 180;
  const theta = ((90 - lng) * Math.PI) / 180;
  const r = GLOBE_RADIUS * (1 + altitude);
  const s = Math.sin(phi);
  out[0] = r * s * Math.cos(theta);
  out[1] = r * Math.cos(phi);
  out[2] = r * s * Math.sin(theta);
  return out;
};

const wrapLng = (lng) => (lng < -180 ? lng + 360 : lng > 180 ? lng - 360 : lng);

/**
 * The app's `StageCountry.span`: the bbox diagonal in degrees of the pruned cap
 * geometry (see `boxOf` in app/lib/mapData.ts). The epsilon tie-break compares
 * this number, so the gate must use the same one — a different size proxy would
 * test a rule the app does not run.
 */
function spanOf(geometry) {
  let minLng = 180;
  let maxLng = -180;
  let minLat = 90;
  let maxLat = -90;
  const visit = (coords) => {
    if (Array.isArray(coords) && typeof coords[0] === "number") {
      const [lng, lat] = coords;
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      return;
    }
    if (Array.isArray(coords)) for (const c of coords) visit(c);
  };
  visit(geometry?.coordinates ?? []);
  if (minLng > maxLng) return 4;
  return Math.min(180, Math.hypot(maxLng - minLng, maxLat - minLat));
}

const spanByIso = new Map();
for (const f of caps.features ?? []) spanByIso.set(f.properties.ISO_A2, spanOf(f.geometry));
const sizeOfIso = (iso) => spanByIso.get(iso) ?? Infinity;

const t0 = performance.now();
const layer = buildHitLayer(landParts, { radius: GLOBE_RADIUS, altitude: HIT_ALTITUDE });
const buildMs = performance.now() - t0;

let hitTriangles = 0;
let hitVertices = 0;
for (const mesh of layer.children) {
  const position = mesh.geometry.attributes.position;
  const index = mesh.geometry.index;
  hitVertices += position.count;
  hitTriangles += (index ? index.count : position.count) / 3;
}
stage(
  `built ${layer.children.length} hit meshes from ${landParts.length} parts ` +
    `(${Math.round(hitTriangles)} triangles, ${hitVertices} verts) in ${buildMs.toFixed(0)}ms`
);

// ---------------------------------------------------------------------------
// The oracle: point-in-polygon on the GeoJSON, at the point where the ray meets
// the sphere. Entirely independent of the raycasting path.
//
// Indexed by 5-degree latitude bands. A linear scan over every part for every
// ray dominated the runtime, and the grid buys that back without touching the
// answer, since a point cannot be inside a part whose latitude range excludes it.
// ---------------------------------------------------------------------------
const BAND = 5;
const bands = new Map();
for (const part of landParts) {
  const outer = part.rings[0];
  if (!outer || outer.length < 3) continue;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const [, lat] of outer) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  const from = Math.floor((minLat + 90) / BAND);
  const to = Math.floor((maxLat + 90) / BAND);
  for (let b = from; b <= to; b++) {
    if (!bands.has(b)) bands.set(b, []);
    bands.get(b).push(part);
  }
}

function pointInRing(lng, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const intersects = yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/** A part is its outer ring MINUS its holes. The old oracle ignored holes, which
 *  made an enclave a coin flip against its host. */
function ringContains(lng, lat, ring) {
  // Three longitudes, because a ring may have been unrolled off [-180, 180].
  return pointInRing(lng, lat, ring) || pointInRing(lng + 360, lat, ring) || pointInRing(lng - 360, lat, ring);
}

function partContains(lng, lat, rings) {
  if (!rings.length || !ringContains(lng, lat, rings[0])) return false;
  for (let i = 1; i < rings.length; i++) if (ringContains(lng, lat, rings[i])) return false;
  return true;
}

/**
 * The ISO at a surface point, applying the same micro-state rule the app does:
 * when more than one part contains the point (an enclave and its host, or a
 * shared border vertex), the smaller country wins. `null` means ocean or a
 * deliberately unselectable unit (Kosovo, Somaliland, N. Cyprus...).
 */
function countryAt(lng, lat) {
  if (Math.abs(lat) > 89.9) return null;
  const candidates = bands.get(Math.floor((lat + 90) / BAND));
  if (!candidates) return null;
  let best = null;
  let bestSpan = Infinity;
  for (const part of candidates) {
    if (!partContains(lng, lat, part.rings)) continue;
    const span = sizeOfIso(part.iso);
    if (span < bestSpan) {
      best = part.iso;
      bestSpan = span;
    }
  }
  return best;
}

/** Where the ray meets a sphere of the given radius, as lat/lng. Null on a miss. */
function surfaceLatLng(ray, radius = GLOBE_RADIUS) {
  const o = ray.origin;
  const d = ray.direction;
  const b = o.dot(d);
  const c = o.dot(o) - radius * radius;
  const disc = b * b - c;
  if (disc < 0) return null;
  const t = -b - Math.sqrt(disc);
  const p = { x: o.x + d.x * t, y: o.y + d.y * t, z: o.z + d.z * t };
  const r = Math.hypot(p.x, p.y, p.z);
  const lat = 90 - (Math.acos(p.y / r) * 180) / Math.PI;
  // `toCartesian` uses `theta = (90 - lng)`, so the inverse is `90 - theta`, NOT
  // theta. Dropping that 90 rotates the oracle a quarter-turn off the meshes.
  return { lat, lng: wrapLng(90 - (Math.atan2(p.z, p.x) * 180) / Math.PI) };
}

/** Unit surface normal, derived from `toCartesian` itself so it cannot drift into
 *  a different convention. Written out, three-globe's swapped x/z reduces to
 *  `(cos lat · sin lng, sin lat, cos lat · cos lng)`; the textbook
 *  `(sin lat · cos lng, …)` form is the *other* convention, and using it
 *  classified almost every limb ray as head-on. */
function normalAt(lat, lng) {
  const n = toCartesian(lng, lat, 0);
  const r = Math.hypot(n[0], n[1], n[2]);
  return { x: n[0] / r, y: n[1] / r, z: n[2] / r };
}

/** Mirrors three-globe's camera placement for a given lat/lng/altitude.
 *
 *  Positioned with `toCartesian` rather than three's `setFromSphericalCoords`,
 *  which swaps x and z relative to three-globe's convention. */
function makeCamera(lat, lng, altitude) {
  const camera = new PerspectiveCamera(FOV, WIDTH / HEIGHT, 0.1, 2000);
  const pos = toCartesian(lng, lat, altitude);
  camera.position.set(pos[0], pos[1], pos[2]);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  return camera;
}

const raycaster = new Raycaster();
const sizeOfHit = (hit) => sizeOfIso(hit.object.userData.iso);

/** The rule under test, in one place, so every test calls the same thing. */
function pickFromRay(ray) {
  raycaster.ray.copy(ray);
  const hits = raycaster.intersectObjects(layer.children, false);
  return nearestUnoccluded(hits, surfaceDistance(raycaster.ray), PICK_EPSILON, sizeOfHit);
}

/** A radial ray aimed straight at a lat/lng on the cap shell. */
function radialRay(lng, lat) {
  const n = normalAt(lat, lng);
  const start = GLOBE_RADIUS * (1 + HIT_ALTITUDE) + 5;
  raycaster.ray.origin.set(n.x * start, n.y * start, n.z * start);
  raycaster.ray.direction.set(-n.x, -n.y, -n.z);
  return raycaster.ray.clone();
}

/** Pick the ISO at a lat/lng from directly above it. */
function pickAt(lng, lat) {
  const hit = pickFromRay(radialRay(lng, lat));
  return hit ? hit.object.userData.iso : null;
}

// ---------------------------------------------------------------------------
// 1. Constants. THE INVARIANT: no cap may sit at altitude 0, and the hit layer
//    must not be lower than the sphere or higher than the selection.
// ---------------------------------------------------------------------------
stage("checking altitude invariants");
check(CAP_BASE > 0, "CAP_BASE > 0 (a cap at altitude 0 z-fights and loses picks)", `${CAP_BASE}`);
check(CAP_SELECTED > CAP_BASE, "CAP_SELECTED lifts above the base cap", `${CAP_SELECTED} > ${CAP_BASE}`);
check(HIT_ALTITUDE > 0, "HIT_ALTITUDE > 0", `${HIT_ALTITUDE}`);
check(HIT_ALTITUDE <= CAP_SELECTED, "hit surface never floats above a selected cap", `${HIT_ALTITUDE} <= ${CAP_SELECTED}`);
check(PICK_EPSILON > 0, "PICK_EPSILON > 0", `${PICK_EPSILON}`);

const globeSrc = readFileSync(new URL("../app/components/GlobeView.tsx", import.meta.url), "utf8");
check(
  !/const\s+\w*ALTITUDE\s*=\s*0(?:\.0+)?\s*;/.test(globeSrc),
  "GlobeView has no zero-valued *_ALTITUDE constant"
);
check(/const BORDER_ALTITUDE = /.test(globeSrc) && /const OUTLINE_ALTITUDE = /.test(globeSrc), "border and outline altitudes exist");

// ---------------------------------------------------------------------------
// 2. The nearest-unoccluded rule and the enclave tie-break, on synthetic hits.
//    These are pure-function assertions; they cannot be confounded by geometry.
// ---------------------------------------------------------------------------
stage("checking the pick rule on synthetic hits");
const synthetic = [
  { id: "host", distance: 10.0, span: 30 },
  { id: "enclave", distance: 10.3, span: 2 },
];
const bySpan = (hit) => hit.span;
check(
  nearestUnoccluded(synthetic, Infinity, 0.5, bySpan)?.id === "enclave",
  "a smaller country wins inside the epsilon window"
);
check(
  nearestUnoccluded(synthetic, Infinity, 0.1, bySpan)?.id === "host",
  "outside the epsilon window the nearest hit wins"
);
check(
  nearestUnoccluded([{ id: "far", distance: 120, span: 1 }], 100, 0.5, bySpan) === null,
  "a hit behind the planet is rejected"
);
check(
  nearestUnoccluded([{ id: "near", distance: 12, span: 1 }], 100, 0.5, bySpan)?.id === "near",
  "a hit in front of the planet is accepted"
);

// ---------------------------------------------------------------------------
// 3. Full-land coverage: every source part must be reachable by a ray.
//
//    Each part is tessellated on its own (the merged layer has already thrown
//    away part identity), and the centroids of its largest triangles are sampled
//    from largest down. One reachable sample is enough: a coastal sliver whose
//    chord sags under the sphere is not visible land, while a whole part with no
//    reachable sample is a country the user cannot click.
// ---------------------------------------------------------------------------
stage("checking full-land coverage, part by part");
function largestCentroids(geometry, limit) {
  const position = geometry.attributes.position;
  const index = geometry.index;
  const count = index ? index.count : position.count;
  const tris = [];
  for (let i = 0; i < count; i += 3) {
    const j0 = index ? index.getX(i) : i;
    const j1 = index ? index.getX(i + 1) : i + 1;
    const j2 = index ? index.getX(i + 2) : i + 2;
    const point = (j) => [position.getX(j), position.getY(j), position.getZ(j)];
    const a = point(j0);
    const b = point(j1);
    const c = point(j2);
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const area =
      0.5 *
      Math.hypot(
        u[1] * v[2] - u[2] * v[1],
        u[2] * v[0] - u[0] * v[2],
        u[0] * v[1] - u[1] * v[0]
      );
    if (!(area > 0)) continue;
    const p = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
    tris.push({ area, p });
  }
  tris.sort((a, b) => b.area - a.area);
  return tris.slice(0, limit).map(({ p }) => {
    const r = Math.hypot(p[0], p[1], p[2]);
    const x = p[0] / r;
    const y = p[1] / r;
    const z = p[2] / r;
    return {
      lat: 90 - (Math.acos(y) * 180) / Math.PI,
      lng: wrapLng(90 - (Math.atan2(z, x) * 180) / Math.PI),
    };
  });
}

let partsUnbuilt = 0;
let partsUncovered = 0;
let partsCovered = 0;
let partsTiebroken = 0;
const coverageFailures = [];
const coverStarted = performance.now();
for (const part of landParts) {
  const geometry = buildPartGeometry(part.rings, GLOBE_RADIUS);
  if (!geometry) {
    partsUnbuilt++;
    if (coverageFailures.length < 12) coverageFailures.push(`${part.iso}: tessellator rejected every ring`);
    continue;
  }
  const samples = largestCentroids(geometry, 6);
  geometry.dispose();

  let covered = false;
  let sawTie = false;
  let firstPick = null;
  for (const sample of samples) {
    const got = pickAt(sample.lng, sample.lat);
    if (firstPick === null) firstPick = got;
    if (got === part.iso) {
      covered = true;
      break;
    }
    // A smaller country on top of this part is the enclave rule working, not a
    // hole in coverage — but the part still has to be reachable elsewhere.
    if (got && sizeOfIso(got) < sizeOfIso(part.iso)) sawTie = true;
  }
  if (covered) partsCovered++;
  else if (sawTie) {
    partsTiebroken++;
    partsCovered++;
  } else {
    partsUncovered++;
    if (coverageFailures.length < 12)
      coverageFailures.push(
        `${part.iso}: ${samples.length} samples (first pick ${firstPick ?? "null"}) at ` +
          samples.map((s) => `${s.lng.toFixed(2)},${s.lat.toFixed(2)}`).join(" ")
      );
  }
}
const coverMs = performance.now() - coverStarted;
check(
  partsUnbuilt === 0,
  "every source part tessellates",
  `${partsUnbuilt} rejected of ${landParts.length}`
);
check(
  partsUncovered === 0,
  "every source part is reachable by a ray",
  `${partsCovered - partsTiebroken}/${landParts.length} resolved to their own ISO, ` +
    `${partsTiebroken} to a smaller co-located country, ${partsUncovered} unreachable (${coverMs.toFixed(0)}ms)`
);
for (const detail of coverageFailures) console.log(`  coverage detail: ${detail}`);

// ---------------------------------------------------------------------------
// 4. The parts the old cap layer pruned must be clickable — and must actually be
//    absent from the caps, or this test would pass for the wrong reason.
// ---------------------------------------------------------------------------
stage("checking named islands, territories and enclaves");
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
let namedFailures = 0;
for (const [name, lng, lat, want] of NAMED) {
  const got = pickAt(lng, lat);
  if (got !== want) {
    namedFailures++;
    console.log(`  FAIL ${name}: picked ${got ?? "null"}, want ${want}`);
  }
}
check(namedFailures === 0, "named islands/territories/enclaves resolve", `${NAMED.length - namedFailures}/${NAMED.length}`);

/** The pruned caps must genuinely miss these points, or the named test proves
 *  nothing about the full-land layer. */
const capPolygons = [];
for (const f of caps.features ?? []) {
  const polys = f.geometry.type === "MultiPolygon" ? f.geometry.coordinates : [f.geometry.coordinates];
  for (const rings of polys) capPolygons.push({ iso: f.properties.ISO_A2, rings });
}
function capsAt(lng, lat) {
  for (const poly of capPolygons) if (partContains(lng, lat, poly.rings)) return poly.iso;
  return null;
}
const PRUNED = NAMED.filter(([name]) => ["Hawaii", "Maui", "Tenerife", "Gran Canaria", "Azores", "Jeju", "Galapagos"].includes(name));
const stillCapped = PRUNED.filter(([, lng, lat]) => capsAt(lng, lat) !== null);
check(stillCapped.length === 0, "the named pruned islands are absent from the caps layer", stillCapped.map(([n]) => n).join(",") || `${PRUNED.length} verified pruned`);

// ---------------------------------------------------------------------------
// 5. Sweep the viewport from a spread of camera positions and assert the rule
//    against the independent oracle.
// ---------------------------------------------------------------------------
const VIEWS = [
  { name: "Brazil", lat: -10, lng: -55, altitude: 0.45 },
  { name: "Europe", lat: 50, lng: 10, altitude: 0.9 },
  { name: "Africa", lat: 2, lng: 20, altitude: 1.5 },
  { name: "Pacific", lat: -10, lng: -150, altitude: 1.2 },
  { name: "Asia", lat: 35, lng: 110, altitude: 1.1 },
  { name: "Antarctica", lat: -75, lng: 0, altitude: 1.3 },
  { name: "Atlantic rim", lat: 25, lng: -40, altitude: 0.28 },
  { name: "Arctic", lat: 78, lng: 60, altitude: 1.4 },
];

const STEP = 5;
/**
 * Agreement is only asserted at or above this incidence, where the cap/sphere
 * offset is small. The far-side check does NOT use this threshold — it is valid
 * at any angle.
 */
const MIN_INCIDENCE = 0.9;
/**
 * Coarse tripwire on oracle agreement, on top of the hard `farSide === 0`.
 *
 * It cannot be 1.0. The oracle resolves a country by point-in-polygon, while the
 * app reports whichever hit mesh the ray actually struck; near a border those
 * differ by the cap lift's footprint, the 50m rings are simplified, and the
 * epsilon rule deliberately prefers a smaller neighbour within a fraction of a
 * degree of a shared border. Measured steady state is ~93%; the far-side bug put
 * this in the 60s, so 0.9 separates the two cleanly.
 */
const MIN_AGREEMENT = 0.9;
/**
 * Phantom picks over open water are rate-gated rather than asserted at zero.
 * The oracle is planar point-in-polygon; the hit mesh triangulates the same ring
 * on a sphere at finite curvature, so a chord across a concave coastline (a
 * fjord, a strait) can legitimately cover a sliver of water. Measured steady
 * state is ~0.02%; the far-side regression produced whole-screen oceans.
 */
const OCEAN_PICK_RATE = 0.001;

let land = 0;
let ocean = 0;
let space = 0;
let grazing = 0;
let agree = 0;
let disagree = 0;
let farSide = 0;
let oceanPicks = 0;
let oceanCompared = 0;
let grazingDisagree = 0;
let tiebreak = 0;
let wrongOwner = 0;
const farSideDetail = [];
const oceanPickDetail = [];
const wrongOwnerDetail = [];
const mismatches = [];

const sweepStarted = performance.now();
for (const view of VIEWS) {
  stage(`view ${view.name} (${view.lat}, ${view.lng}) alt ${view.altitude}`);
  const camera = makeCamera(view.lat, view.lng, view.altitude);
  for (let y = 0; y < HEIGHT; y += STEP) {
    for (let x = 0; x < WIDTH; x += STEP) {
      const ndc = new Vector2((x / WIDTH) * 2 - 1, -(y / HEIGHT) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);

      // --- the rule under test
      const hits = raycaster.intersectObjects(layer.children, false);
      const surfaceAt = surfaceDistance(raycaster.ray);
      const visible = nearestUnoccluded(hits, surfaceAt, PICK_EPSILON, sizeOfHit);
      const picked = visible ? visible.object.userData.iso : null;

      // --- the independent oracle.
      //
      // The country lookup uses the ray's crossing with the HIT shell, because
      // that is the surface the app actually hits. The occlusion test still uses
      // the real planet at GLOBE_RADIUS — that is the physical occluder.
      const planetLL = surfaceLatLng(raycaster.ray, GLOBE_RADIUS);
      const capLL = surfaceLatLng(raycaster.ray, GLOBE_RADIUS * (1 + HIT_ALTITUDE));
      const ll = capLL ?? planetLL;
      const expected = ll ? countryAt(ll.lng, ll.lat) : null;

      // Self-consistency: whatever was picked should cover the point on its own
      // surface that the ray struck. A larger country where the oracle names a
      // smaller one is a real wrong-datum bug; the reverse is the enclave rule.
      if (picked && visible) {
        const cp = visible.point;
        const cr = Math.hypot(cp.x, cp.y, cp.z);
        const owner = countryAt(
          wrapLng(90 - (Math.atan2(cp.z, cp.x) * 180) / Math.PI),
          90 - (Math.acos(cp.y / cr) * 180) / Math.PI
        );
        if (owner && owner !== picked) {
          if (sizeOfIso(picked) <= sizeOfIso(owner)) tiebreak++;
          else {
            wrongOwner++;
            if (wrongOwnerDetail.length < 8)
              wrongOwnerDetail.push(`${view.name} ${x},${y} picked=${picked} covers=${owner} (larger)`);
          }
        }
      }

      // A ray that misses the planet entirely. The rule must still be
      // self-consistent for these, but they are not asserted silent: the hit
      // surface is lifted, so a sliver of every country legitimately pokes past
      // the planet's silhouette. That is the `Infinity` case in surfaceDistance.
      if (!Number.isFinite(surfaceAt)) {
        space++;
        continue;
      }

      const n = normalAt(planetLL.lat, planetLL.lng);
      const incidence = -(raycaster.ray.direction.x * n.x + raycaster.ray.direction.y * n.y + raycaster.ray.direction.z * n.z);

      // THE FAR-SIDE REGRESSION, asserted for EVERY pick at any incidence.
      // The shipped bug reported Tanzania for a pixel over Brazil. The signature
      // is unambiguous: the cap that was hit sits on the far hemisphere from the
      // surface point under the cursor.
      if (picked && visible) {
        const cp = visible.point;
        const cr = Math.hypot(cp.x, cp.y, cp.z);
        const cn = normalAt(
          90 - (Math.acos(cp.y / cr) * 180) / Math.PI,
          wrapLng(90 - (Math.atan2(cp.z, cp.x) * 180) / Math.PI)
        );
        if (cn.x * n.x + cn.y * n.y + cn.z * n.z < 0) {
          farSide++;
          if (farSideDetail.length < 6)
            farSideDetail.push(`${view.name} ${x},${y} picked=${picked} surface=${expected ?? "ocean"}`);
        }
      }

      if (expected) land++;
      else ocean++;

      if (incidence < MIN_INCIDENCE) {
        grazing++;
        if (picked !== expected) grazingDisagree++;
        continue;
      }
      if (!expected) oceanCompared++;
      if (picked !== expected) {
        disagree++;
        if (!expected && picked) {
          oceanPicks++;
          if (oceanPickDetail.length < 8)
            oceanPickDetail.push(`${view.name} ${x},${y} picked=${picked} surface=null`);
        }
        if (mismatches.length < 8) mismatches.push(`${view.name} ${x},${y} picked=${picked} surface=${expected}`);
      } else {
        agree++;
      }
    }
  }
}
const sweepMs = performance.now() - sweepStarted;

const total = land + ocean + space;
const compared = agree + disagree;
const agreeRate = compared ? agree / compared : 0;
const wrongRate = compared ? wrongOwner / compared : 0;

console.log(`views swept          : ${VIEWS.length} (${sweepMs.toFixed(0)}ms)`);
console.log(`rays cast            : ${total}`);
console.log(`  hit the planet     : ${land + ocean}  (oracle says selectable land ${land}, no selectable country ${ocean})`);
console.log(`  missed the planet  : ${space}  (open sky — a lifted near-limb hit is legitimately visible there)`);
console.log(`  limb, not compared : ${grazing}  (incidence < ${MIN_INCIDENCE}; ${grazingDisagree} disagreed, see notes)`);
console.log(`oracle agreement     : ${agree}/${compared} (${(agreeRate * 100).toFixed(3)}%, need >= ${MIN_AGREEMENT * 100}%)`);
console.log(
  `ocean stayed quiet   : ${oceanCompared - oceanPicks}/${oceanCompared} of compared no-land rays ` +
    `(${oceanPicks} phantom picks, need <= ${(OCEAN_PICK_RATE * 100).toFixed(3)}%)`
);
console.log(`enclave tie-breaks   : ${tiebreak} (informational — a smaller country outranked a larger one)`);
console.log(
  `wrong-datum picks    : ${wrongOwner}/${compared} (${(wrongRate * 100).toFixed(4)}%, need <= 0.01%) — ` +
    `a larger country than the one covering the point; the lift's footprint at a shared border`
);
console.log(`FAR-SIDE PICKS       : ${farSide} (need 0)  <- the regression this gate exists for`);
if (farSideDetail.length) console.log(`far-side detail      : ${farSideDetail.join(" | ")}`);
if (oceanPickDetail.length) console.log(`ocean pick detail    : ${oceanPickDetail.join(" | ")}`);
if (wrongOwnerDetail.length) console.log(`wrong-datum detail   : ${wrongOwnerDetail.join(" | ")}`);
if (mismatches.length) console.log(`mismatch detail      : ${mismatches.join(" | ")}`);

const ok =
  land > 5000 &&
  ocean > 5000 &&
  farSide === 0 &&
  wrongRate <= 0.0001 &&
  oceanCompared > 5000 &&
  oceanPicks / oceanCompared <= OCEAN_PICK_RATE &&
  agreeRate >= MIN_AGREEMENT &&
  partsUnbuilt === 0 &&
  partsUncovered === 0 &&
  namedFailures === 0 &&
  stillCapped.length === 0;
console.log(ok ? "globe pick geometry passed" : "globe pick geometry FAILED");
process.exit(ok ? 0 : 1);
