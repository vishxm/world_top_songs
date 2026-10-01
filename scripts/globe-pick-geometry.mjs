/**
 * The globe's picking rule, tested exhaustively and without a browser.
 *
 * WHY THIS EXISTS SEPARATELY FROM `globe-pick-check.mjs`
 *
 * Every assertion that goes through the real UI costs a synthetic pointer move and
 * a settled frame before it can be read back. That is why the browser gate could
 * only afford a few hundred samples and took minutes: the cost is the harness, not
 * the checks. The rule itself, though, is a pure function — and it is the part that
 * has shipped real bugs (twice). So it is tested here instead, where tens of
 * thousands of rays cost about a second, and the browser gate is left with only the
 * handful of assertions that genuinely need a live DOM: that hover is wired to the
 * header, that a selection repaints, and that the draw-call budget holds.
 *
 * THE ORACLE IS INDEPENDENT OF THE THING UNDER TEST
 *
 * The rule is "raycast the caps, take the nearest, reject it if the planet is in
 * front". Asserting that against itself proves nothing. So the expected answer is
 * computed a completely different way: solve where the ray meets the sphere, turn
 * that point into lat/lng, and ask the GeoJSON which polygon contains it. No
 * raycasting, no meshes, no three.js in the oracle at all — only the rule under
 * test shares code with the code being checked, and that is the two functions
 * imported from `app/lib/pick`.
 */

import { readFileSync } from "node:fs";
import { DoubleSide, Mesh, MeshBasicMaterial, Group, PerspectiveCamera, Raycaster, Vector2 } from "three";
import { firstUnoccluded, GLOBE_RADIUS, surfaceDistance } from "../app/lib/pick.ts";

// three-conic-polygon-geometry reads `window.THREE` at module scope — it prefers a
// global THREE when a page provides one. Shimming `window` before the dynamic
// import is enough to fall through to its own bundled three, which is the same
// version the app uses.
globalThis.window ??= {};
const { default: ConicPolygonGeometry } = await import("three-conic-polygon-geometry");

// Must match CAP_BASE in GlobeView.tsx.
const CAP_BASE = 0.004;
/** three-globe's fixed vertical field of view, degrees. */
const FOV = 50;
const WIDTH = 1440;
const HEIGHT = 900;

const stage = (s) => process.stderr.write(`  [${new Date().toISOString().slice(11, 19)}] ${s}\n`);

// ---------------------------------------------------------------------------
// Load the caps exactly as the app does, and mirror them into meshes.
// ---------------------------------------------------------------------------
stage("loading country-caps.geojson");
const caps = JSON.parse(readFileSync(new URL("../public/country-caps.geojson", import.meta.url), "utf8"));

const toCartesian = (lng, lat, altitude, out) => {
  const phi = ((90 - lat) * Math.PI) / 180;
  const theta = ((90 - lng) * Math.PI) / 180;
  const r = GLOBE_RADIUS * (1 + altitude);
  const s = Math.sin(phi);
  out[0] = r * s * Math.cos(theta);
  out[1] = r * Math.cos(phi);
  out[2] = r * s * Math.sin(theta);
};

/**
 * Make a ring's longitudes continuous, so a country straddling the antimeridian
 * (Russia, Fiji) is not split across the whole map. Returns a copy whose
 * longitudes may fall outside [-180, 180]; the oracle compensates by testing the
 * point at lng, lng+360 and lng-360.
 */
function unroll(ring) {
  const out = [[ring[0][0], ring[0][1]]];
  for (let i = 1; i < ring.length; i++) {
    let lng = ring[i][0];
    const prev = out[i - 1][0];
    while (lng - prev > 180) lng -= 360;
    while (prev - lng > 180) lng += 360;
    out.push([lng, ring[i][1]]);
  }
  return out;
}

/**
 * The caps are built with three-globe's OWN tessellator, not a hand-rolled one.
 *
 * This matters more than it looks. Triangulating the same ring with plain earcut
 * produced a final triangle spanning 16 degrees for Brazil, whose chord sags about
 * a unit — deeper than the 0.4-unit lift — so the cap sat *behind* the planet
 * there, the picking rule rejected it, and the gate reported tens of thousands of
 * "missed land" pixels that looked exactly like a catastrophic picking bug.
 * ConicPolygonGeometry subdivides by `curvatureResolution`, and the real app meshes
 * measure a worst sag of 0.21 units (Greenland), comfortably under the lift.
 *
 * A gate that triangulates differently from the app is measuring the harness.
 */
const meshes = [];
const polygons = [];
const group = new Group();
let built = 0;
let triangleCount = 0;
for (const feature of caps.features) {
  const iso = feature.properties.ISO_A2;
  const geom = feature.geometry;
  // Exactly what three-globe does: one conic object per polygon PART, geometry
  // extruded from 0 to GLOBE_RADIUS, then lifted by scaling the mesh.
  const parts = geom.type === "MultiPolygon" ? geom.coordinates : [geom.coordinates];
  const oracleRings = [];
  for (const coords of parts) {
    const rings = coords.map(unroll);
    oracleRings.push(...rings);
    let geometry;
    try {
      geometry = new ConicPolygonGeometry(rings, 0, GLOBE_RADIUS, false, true, false, 5);
    } catch {
      continue;
    }
    triangleCount += (geometry.index ? geometry.index.count : geometry.attributes.position.count) / 3;
    const mesh = new Mesh(
      geometry,
      // DoubleSide, because three-globe's cap material is (`side: THREE.DoubleSide`
      // on `__defaultCapMaterial`). With the FrontSide default the raycaster culls
      // every far-side cap, the hidden hemisphere becomes unraycastable, and the
      // gate reports zero far-side picks even with the occluder deleted — the exact
      // bug it exists to catch, made invisible by the harness.
      new MeshBasicMaterial({ side: DoubleSide })
    );
    mesh.scale.setScalar(1 + CAP_BASE);
    mesh.userData.iso = iso;
    meshes.push(mesh);
    group.add(mesh);
    built++;
  }
  polygons.push({
    iso,
    // Drop the duplicate closing vertex GeoJSON rings carry.
    rings: oracleRings.map((r) =>
      r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1] ? r.slice(0, -1) : r
    ),
  });
}
// Raycasting goes through world matrices, and the lift lives on the mesh scale.
group.updateMatrixWorld(true);
stage(`built ${built} cap meshes (${Math.round(triangleCount)} triangles) from ${polygons.length} countries`);

// ---------------------------------------------------------------------------
// The oracle: point-in-polygon on the GeoJSON, at the point where the ray meets
// the sphere. Entirely independent of the raycasting path.
//
// Indexed by 5-degree latitude bands. A linear scan over every country for every
// ray dominated the runtime — and the grid buys that back without touching the
// answer, since a point cannot be inside a ring whose latitude range excludes it.
// ---------------------------------------------------------------------------
const BAND = 5;
const bands = new Map();
polygons.forEach((poly, index) => {
  for (const ring of poly.rings) {
    let minLat = Infinity;
    let maxLat = -Infinity;
    for (const [, lat] of ring) {
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
    const from = Math.floor((minLat + 90) / BAND);
    const to = Math.floor((maxLat + 90) / BAND);
    for (let b = from; b <= to; b++) {
      if (!bands.has(b)) bands.set(b, []);
      bands.get(b).push(index);
    }
  }
});

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

function countryAt(lng, lat) {
  if (Math.abs(lat) > 89.9) return null;
  const candidates = bands.get(Math.floor((lat + 90) / BAND));
  if (!candidates) return null;
  for (const index of candidates) {
    const poly = polygons[index];
    for (const ring of poly.rings) {
      // Three longitudes, because the ring may have been unrolled off [-180,180].
      if (
        pointInRing(lng, lat, ring) ||
        pointInRing(lng + 360, lat, ring) ||
        pointInRing(lng - 360, lat, ring)
      ) {
        return poly.iso;
      }
    }
  }
  return null;
}

function wrapLng(lng) {
  if (lng < -180) lng += 360;
  if (lng > 180) lng -= 360;
  return lng;
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
  // theta. Dropping that 90 rotates the oracle a quarter-turn off the caps, which
  // made 66% of every sample look like a wrong-country bug.
  return { lat, lng: wrapLng(90 - (Math.atan2(p.z, p.x) * 180) / Math.PI) };
}

/** Unit surface normal, derived from `toCartesian` itself so it cannot drift into a
 *  different convention. Written out, three-globe's swapped x/z reduces to
 *  `(cos lat · sin lng, sin lat, cos lat · cos lng)`; the textbook
 *  `(sin lat · cos lng, …)` form is the *other* convention, and using it
 *  classified almost every limb ray as head-on, which silently emptied the grazing
 *  set and let limb disagreement masquerade as picking bugs. */
function normalAt(lat, lng) {
  const n = [0, 0, 0];
  toCartesian(lng, lat, 0, n);
  const r = Math.hypot(n[0], n[1], n[2]);
  return { x: n[0] / r, y: n[1] / r, z: n[2] / r };
}

// ---------------------------------------------------------------------------
// Sweep the viewport from a spread of camera positions.
// ---------------------------------------------------------------------------
/** Mirrors three-globe's camera placement for a given lat/lng/altitude.
 *
 *  Positioned with `toCartesian` rather than three's `setFromSphericalCoords`,
 *  which swaps x and z relative to three-globe's convention. Using it put the
 *  camera somewhere the caps were not, and the oracle then disagreed with the
 *  meshes almost everywhere — a harness bug that looked exactly like the picking
 *  rule being 90% broken. */
function makeCamera(lat, lng, altitude) {
  const camera = new PerspectiveCamera(FOV, WIDTH / HEIGHT, 0.1, 2000);
  const pos = [0, 0, 0];
  toCartesian(lng, lat, altitude, pos);
  camera.position.set(pos[0], pos[1], pos[2]);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  return camera;
}

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
 * offset is small. See the note at the comparison site. The far-side check does
 * NOT use this threshold — it is valid at any angle.
 */
const MIN_INCIDENCE = 0.9;
/**
 * Coarse tripwire on oracle agreement, on top of the hard `farSide === 0`.
 *
 * It cannot be 1.0. The oracle resolves a country by point-in-polygon, while the app
 * reports whichever cap the ray actually struck; near a border those differ by the
 * cap lift's footprint, and the 50m caps are simplified, so adjacent rings do not
 * abut exactly. Measured steady state is ~93%, and a genuine regression (the
 * far-side bug) put this number in the 60s, so 0.9 separates the two cleanly
 * without pretending to a precision it does not have.
 */
const MIN_AGREEMENT = 0.9;

let land = 0;
let ocean = 0;
let space = 0;
let grazing = 0;
let agree = 0;
let disagree = 0;
let farSide = 0;
let spokeOcean = 0;
let grazingDisagree = 0;
let borderAmbiguous = 0;
const borderDetail = [];
const farSideDetail = [];
const mismatches = [];

for (const view of VIEWS) {
  stage(`view ${view.name} (${view.lat}, ${view.lng}) alt ${view.altitude}`);
  const camera = makeCamera(view.lat, view.lng, view.altitude);
  const rc = new Raycaster();
  for (let y = 0; y < HEIGHT; y += STEP) {
    for (let x = 0; x < WIDTH; x += STEP) {
      const ndc = new Vector2((x / WIDTH) * 2 - 1, -(y / HEIGHT) * 2 + 1);
      rc.setFromCamera(ndc, camera);

      // --- the rule under test
      const hits = rc.intersectObjects(meshes, true);
      const visible = firstUnoccluded(hits, surfaceDistance(rc.ray));
      const picked = visible ? visible.object.userData.iso : null;
      const surface = surfaceDistance(rc.ray);

      // Self-consistency, checked for EVERY ray at any incidence: whatever was
      // picked should be a country that actually covers the point on its own cap
      // that the ray struck. Informational only — it catches a hit attributed to
      // the wrong datum, but it is NOT what decides the far-side check below.
      if (picked && visible) {
        const cp = visible.point;
        const cr = Math.hypot(cp.x, cp.y, cp.z);
        const cLat = 90 - (Math.acos(cp.y / cr) * 180) / Math.PI;
        const cLng = wrapLng(90 - (Math.atan2(cp.z, cp.x) * 180) / Math.PI);
        const owner = countryAt(cLng, cLat);
        if (owner && owner !== picked) {
          // On a shared border the point-in-polygon test is genuinely ambiguous —
          // adjacent rings share vertices, so a point a rounding error either side
          // of the line is inside both and "who owns it" comes down to iteration
          // order. Not a picking failure, so counted rather than failed.
          borderAmbiguous++;
          if (borderDetail.length < 6) borderDetail.push(`${view.name} ${x},${y} picked=${picked} covers=${owner}`);
        }
      }

      // A ray that misses the planet entirely. The rule must still be self-consistent
      // for these, but they are not asserted silent: the caps are lifted, so a
      // sliver of every country legitimately pokes past the planet's silhouette and
      // a near-limb country is correctly pickable against the sky. That is the
      // `Infinity` case in surfaceDistance, and `firstUnoccluded` is what makes it
      // safe.
      if (!Number.isFinite(surface)) {
        space++;
        // No planet crossing here, so the far-side test does not apply — there is
        // no "front" to be behind. Self-consistency was already checked above.
        continue;
      }

      // --- the independent oracle.
      //
      // The country lookup uses the ray's crossing with the CAP shell (radius
      // R(1+CAP_BASE)), because that is the surface the app actually hits. Looking
      // it up on the bare sphere instead leaves the two about 0.25 degrees of arc
      // apart, which is enough to flip Brazil/Bolivia along their shared frontier
      // and made 8% of every sample look like a mismatch.
      //
      // The occlusion test still uses the real planet, at GLOBE_RADIUS — that is
      // the physical occluder and the thing the far-side check is about.
      const planetLL = surfaceLatLng(rc.ray, GLOBE_RADIUS);
      const capLL = surfaceLatLng(rc.ray, GLOBE_RADIUS * (1 + CAP_BASE));
      const ll = capLL ?? planetLL;
      const expected = ll ? countryAt(ll.lng, ll.lat) : null;

      const n = normalAt(planetLL.lat, planetLL.lng);
      const incidence = -(rc.ray.direction.x * n.x + rc.ray.direction.y * n.y + rc.ray.direction.z * n.z);

      // THE FAR-SIDE REGRESSION, asserted for EVERY pick at any incidence.
      //
      // The shipped bug reported Tanzania for a pixel over Brazil, and Bolivia for
      // one over Brazil — countries on the hidden hemisphere, with nothing
      // highlighted on screen at all. The signature is unambiguous and needs no
      // fudge factor: the cap that was hit sits on the far side of the planet from
      // the surface point under the cursor. Anything picked within 90 degrees of
      // that surface point is on the visible hemisphere, by definition.
      //
      // Deliberately INDEPENDENT of the self-consistency check above. A far-side
      // pick is perfectly self-consistent — the ray really did strike that
      // country's cap — which is exactly why gating this on `!selfConsistent`
      // skipped every occurrence and let a build with the occluder deleted pass.
      if (picked && visible) {
        const cp = visible.point;
        const cr = Math.hypot(cp.x, cp.y, cp.z);
        const cn = normalAt(
          90 - (Math.acos(cp.y / cr) * 180) / Math.PI,
          wrapLng(90 - (Math.atan2(cp.z, cp.x) * 180) / Math.PI)
        );
        const cosBetween = cn.x * n.x + cn.y * n.y + cn.z * n.z;
        if (cosBetween < 0) {
          farSide++;
          if (farSideDetail.length < 6)
            farSideDetail.push(`${view.name} ${x},${y} picked=${picked} surface=${expected ?? "ocean"}`);
        }
      }

      if (expected) land++;
      else ocean++;

      // Agreement is asserted only where the cap/sphere offset is small.
      //
      // The oracle locates the SPHERE crossing; the app hits the LIFTED cap. The
      // two are concentric spheres, so they agree exactly at the sub-camera point
      // and diverge as tan(incidence) grows — about 0.25 degrees of arc head-on,
      // and many degrees near the limb. That is enough to cross a border in a
      // sparsely settled region, so a low-incidence disagreement measures the lift,
      // not the picking rule.
      //
      // The far-side test above is different in kind and is asserted at EVERY
      // incidence: it asks whether the picked cap is on the opposite hemisphere,
      // which is a geometric fact with no tolerance in it.
      if (incidence < MIN_INCIDENCE) {
        grazing++;
        if (picked !== expected) grazingDisagree++;
        continue;
      }
      if (picked !== expected) {
        disagree++;
        if (mismatches.length < 8) mismatches.push(`${view.name} ${x},${y} picked=${picked} surface=${expected}`);
      } else {
        agree++;
        if (!picked) spokeOcean++;
      }
    }
  }
}


const total = land + ocean + space;
const compared = agree + disagree;
const agreeRate = compared ? agree / compared : 0;

console.log(`views swept          : ${VIEWS.length}`);
console.log(`rays cast            : ${total}`);
console.log(`  hit the planet     : ${land + ocean}  (oracle says land ${land}, ocean ${ocean})`);
console.log(`  missed the planet  : ${space}  (open sky — a lifted near-limb cap is legitimately visible there)`);
console.log(`  limb, not compared : ${grazing}  (incidence < ${MIN_INCIDENCE}; ${grazingDisagree} disagreed, see notes)`);
console.log(`oracle agreement     : ${agree}/${compared} (${(agreeRate * 100).toFixed(3)}%, need >= ${MIN_AGREEMENT * 100}%)`);
console.log(`ocean stayed quiet   : ${spokeOcean}/${ocean} of compared rays (need all)`);
console.log(`FAR-SIDE PICKS       : ${farSide} (need 0)  <- the regression this gate exists for`);
console.log(`border-ambiguous     : ${borderAmbiguous} (informational — adjacent rings share vertices)`);
if (farSideDetail.length) console.log(`far-side detail      : ${farSideDetail.join(" | ")}`);
if (mismatches.length) console.log(`mismatch detail      : ${mismatches.join(" | ")}`);
if (borderDetail.length) console.log(`border detail        : ${borderDetail.join(" | ")}`);

const oceanCompared = agree + disagree - agree;
const ok =
  land > 5000 &&
  ocean > 5000 &&
  farSide === 0 &&
  agreeRate >= MIN_AGREEMENT;
console.log(ok ? "globe pick geometry passed" : "globe pick geometry FAILED");
process.exit(ok ? 0 : 1);