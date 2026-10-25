import { BufferGeometry, DoubleSide, Group, Mesh, MeshBasicMaterial } from "three";
import ConicPolygonGeometry from "three-conic-polygon-geometry";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

/**
 * The full-land hit layer.
 *
 * The caps three-globe draws are deliberately pruned to the polygon parts that
 * carry each country's visual mass: three-globe makes one Mesh+LineSegments pair
 * per part, and the 50m map has ~1650 of them, which is ~8200 draw calls and an
 * 18fps globe. That pruning is correct for *drawing* and fatal for *picking*:
 * Hawaii, the Canaries, the Azores, Jeju, the Galapagos and every Pacific group
 * are drawn as outlines but had no cap, so a click on them hit nothing.
 *
 * So picking gets its own layer, built from the full-fidelity ring grouping in
 * `country-borders.geojson` (see scripts/build-map-layers.mjs). It is one merged
 * mesh per country — never added to the scene, never drawn — and the raycaster is
 * pointed at it instead of at the caps. "Every drawn part of every country is
 * clickable" therefore holds by construction: the hit geometry is the border
 * layer's geometry.
 *
 * This module reads `window` indirectly (three-conic-polygon-geometry prefers a
 * global THREE at module scope), so it must only be imported on the client. The
 * app dynamic-imports it from an effect; the geometry gate shims `window` first.
 */

/** A ring as accepted by the tessellator — coordinates are only ever read. */
export type RingInput = readonly (readonly [number, number])[];

export interface HitPart {
  iso: string;
  /** Outer ring first, then holes. */
  rings: readonly RingInput[];
}

/**
 * Longest boundary edge before the ring is densified, in degrees.
 *
 * 2°, not the tessellator's own 5°: a chord that spans `d` degrees sinks
 * `R(1 - cos(d/2))` below the shell, and the border layer only sits 0.2 units
 * above the sphere. Measured on Greenland, the library's 5° spacing left
 * boundary triangles whose edge midpoints sagged a full unit — 0.6 below the
 * sphere — and a click in that coastal strip was rejected by the occluder.
 */
const MAX_EDGE_DEGREES = 2;

/**
 * Angular resolution of the interior triangulation, in degrees.
 *
 * Boundary densification alone is not enough: earcut only triangulates the
 * perimeter, so however fine the coastline is, a triangle can span the
 * country's whole interior. Measured on Greenland with `Infinity` here, the hit
 * surface sank 0.61 units below the sphere — deeper than the 0.4-unit lift — and
 * the occlusion rule rejected the entire interior. A finite resolution adds an
 * interior grid and Delaunay-triangulates it, which bounds the sag across the
 * middle of the country.
 */
const CURVATURE_DEGREES = 5;

/**
 * Make a ring's longitudes continuous.
 *
 * A country straddling the antimeridian (Russia, Fiji, New Zealand) is stored as
 * a ring that jumps from +179 to -179. Interpolating that in raw lng/lat would
 * draw the edge the long way around the planet; unrolling keeps it local. The
 * conic tessellator converts lng to an angle, so values outside [-180, 180] are
 * harmless.
 */
function unroll(ring: RingInput): RingInput {
  if (ring.length === 0) return [];
  const out: [number, number][] = [[ring[0][0], ring[0][1]]];
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
 * Insert points along long edges so the tessellator never has to make a chord
 * deeper than `MAX_EDGE_DEGREES`.
 *
 * The ring must stay CLOSED (last point repeats the first). The library's
 * interior-point filter hands the ring to turf/d3, which throw
 * "First and last coordinates in a ring must be the same" otherwise; because the
 * filter only runs for parts wider than the curvature resolution, the failure
 * hit large countries only — 91 parts silently vanished from the hit layer, with
 * no error anywhere. Keep the closing point.
 */
function densify(ring: RingInput): RingInput {
  if (ring.length < 2) return ring.map(([lng, lat]) => [lng, lat]);
  const out: [number, number][] = [[ring[0][0], ring[0][1]]];
  for (let i = 1; i < ring.length; i++) {
    const [ax, ay] = ring[i - 1];
    const [bx, by] = ring[i];
    const steps = Math.ceil(Math.hypot(bx - ax, by - ay) / MAX_EDGE_DEGREES);
    for (let k = 1; k < steps; k++) {
      out.push([ax + ((bx - ax) * k) / steps, ay + ((by - ay) * k) / steps]);
    }
    out.push([bx, by]);
  }
  // GeoJSON rings are closed, but a hand-built or cropped ring may not be. The
  // tessellator's point-in-polygon filter requires it.
  const first = out[0];
  const last = out[out.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) out.push([first[0], first[1]]);
  return out;
}

/**
 * One polygon part, tessellated on the globe.
 *
 * `closedTop` gives the cap a filled top; sides are not needed and would triple
 * the triangle count for a surface the pointer can never approach from below.
 * Returns null for a ring set the tessellator rejects (degenerate slivers), which
 * the caller skips rather than letting one bad island take the whole pickup down.
 */
export function buildPartGeometry(rings: readonly RingInput[], radius: number): BufferGeometry | null {
  if (rings.length === 0) return null;
  try {
    const geometry = new ConicPolygonGeometry(
      // The library types its input as mutable, but it only ever reads it.
      rings.map((ring) => densify(unroll(ring))) as unknown as number[][][],
      0,
      radius,
      false,
      true,
      false,
      CURVATURE_DEGREES
    );
    if (!geometry.attributes.position || geometry.attributes.position.count === 0) {
      geometry.dispose();
      return null;
    }
    return geometry;
  } catch {
    return null;
  }
}

export interface HitLayerOptions {
  /** three-globe's radius, in scene units. */
  radius: number;
  /** Lift above the sphere, in globe radii. Must be > 0 — see the cap invariant. */
  altitude: number;
}

/**
 * Merge each country's parts into one mesh.
 *
 * One mesh per country rather than one per part: a ray is tested against ~236
 * bounding spheres instead of ~1644, and a hit identifies the country directly
 * instead of walking up to a datum. The meshes are never rendered, so they cost
 * no draw calls and need no material budget — a single shared material is enough
 * for the raycaster.
 */
export function buildHitLayer(parts: readonly HitPart[], { radius, altitude }: HitLayerOptions): Group {
  const byIso = new Map<string, BufferGeometry[]>();
  let skipped = 0;
  for (const part of parts) {
    const geometry = buildPartGeometry(part.rings, radius);
    if (!geometry) {
      skipped++;
      continue;
    }
    const list = byIso.get(part.iso);
    if (list) list.push(geometry);
    else byIso.set(part.iso, [geometry]);
  }
  // A skipped part is land the pointer cannot reach, which is the whole bug this
  // layer exists to fix — so never let it be silent. The geometry gate asserts
  // this is 0; the log catches a real build in the wild.
  if (skipped > 0) console.warn(`hit layer skipped ${skipped} polygon part(s)`);

  const root = new Group();
  root.name = "country-hit-layer";
  const material = new MeshBasicMaterial({ side: DoubleSide });
  const scale = 1 + altitude;

  for (const [iso, geometries] of byIso) {
    const merged = geometries.length === 1 ? geometries[0] : mergeGeometries(geometries, false);
    if (geometries.length > 1) for (const geometry of geometries) geometry.dispose();
    if (!merged) continue;
    merged.computeBoundingSphere();
    const mesh = new Mesh(merged, material);
    mesh.name = `hit:${iso}`;
    mesh.userData.iso = iso;
    mesh.scale.setScalar(scale);
    root.add(mesh);
  }

  root.updateMatrixWorld(true);
  return root;
}

/** Release every geometry and the shared material. Safe to call twice. */
export function disposeHitLayer(root: Group | null): void {
  if (!root) return;
  const materials = new Set<MeshBasicMaterial>();
  for (const child of root.children) {
    const mesh = child as Mesh;
    mesh.geometry?.dispose();
    if (mesh.material instanceof MeshBasicMaterial) materials.add(mesh.material);
  }
  for (const material of materials) material.dispose();
  root.clear();
}
