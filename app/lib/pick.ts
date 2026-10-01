import type { Ray } from "three";

/**
 * The globe's picking rule, with no React and no three-globe in it.
 *
 * This lives apart from GlobeView on purpose. The rule is the part that has
 * actually shipped bugs — twice — so it has to be testable on its own, and the
 * only way to test it *thoroughly* is without a browser: every assertion through
 * the real UI costs a synthetic pointer move and a settled frame, which is why
 * the browser gate could only ever afford a few hundred samples and took minutes.
 * Here it is a pure function, so `scripts/globe-pick-node.mjs` can throw tens of
 * thousands of rays at it in about a second and check every one against an
 * independent point-in-polygon oracle.
 *
 * See GlobeView for the plumbing that feeds it a ray, and AGENTS.md for why the
 * library's own pointer handling cannot express this.
 */

/** three-globe builds everything at this radius; altitudes are `1 + alt` scales. */
export const GLOBE_RADIUS = 100;

/**
 * Distance from the ray origin to where it meets the globe's own surface, or
 * `Infinity` if it never does.
 *
 * The planet is the occluder for everything behind it, so "is this cap visible?"
 * reduces to a scalar comparison. Solving `|o + t·d| = R` directly is both exact
 * and free — raycasting the sphere mesh instead drags the 120k-segment border
 * layer and the graticule grid through the loop, which cost 2ms per pick against
 * 0.09ms for the caps alone.
 *
 * `Infinity` and not a small number when the ray misses. The caps are lifted
 * above the sphere, so a sliver of every cap sits *outside* the planet's
 * silhouette and is genuinely visible against the sky there; a ray that misses
 * the sphere has no occluder in front of it, so whatever cap it does hit is a
 * near-limb cap and must be pickable. Returning a near distance instead dropped
 * a band of countries around the limb (Germany, the UK, France, Algeria, Brazil)
 * from hover entirely. Note this cannot let a far-side cap through: any ray that
 * reaches one has passed through the globe, so it always has an occluder in front
 * of it.
 */
export function surfaceDistance(ray: Ray, radius: number = GLOBE_RADIUS): number {
  const o = ray.origin;
  const d = ray.direction;
  const b = o.dot(d);
  const c = o.dot(o) - radius * radius;
  const disc = b * b - c;
  return disc < 0 ? Infinity : -b - Math.sqrt(disc);
}

/**
 * The nearest hit, but only if nothing opaque is in front of it.
 *
 * `hits` must already be sorted near→far, which is what a three.js Raycaster
 * guarantees. Taking only `hits[0]` rather than scanning for the first passing
 * hit is the whole point: scanning is what let the library report countries on
 * the far side of the planet, because the globe sphere is *nearer* than every
 * lifted cap, so rejecting the sphere — the only option its filter allowed — sent
 * the search onward through the hidden hemisphere.
 *
 * `occluderDistance` is `surfaceDistance(...)`, or `Infinity` when the ray misses
 * the planet entirely, in which case any cap it reaches is legitimately visible.
 */
export function firstUnoccluded<T extends { distance: number }>(
  hits: readonly T[],
  occluderDistance: number
): T | null {
  const hit = hits[0];
  if (!hit) return null;
  return hit.distance < occluderDistance ? hit : null;
}