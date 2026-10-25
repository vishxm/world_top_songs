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
 * Altitude of the rendered country caps, in globe-radius units.
 *
 * THE INVARIANT: never 0. three-globe builds polygon geometry at GLOBE_RADIUS
 * and applies altitude as a uniform mesh scale of `1 + alt`, so an altitude of 0
 * puts the cap exactly coplanar with the globe mesh — it z-fights and the pick
 * becomes numerically unreliable, silently dropping countries from hover. This
 * is also high enough to sit clear of the border layer's radius.
 */
export const CAP_BASE = 0.004;

/**
 * Altitude of a selected cap. The lift is the selection's second signal: it
 * survives the region filter dimming the fill. Hover must never lift, because a
 * lift is a scale and therefore grows the cap's footprint over its neighbours.
 */
export const CAP_SELECTED = 0.03;

/**
 * Altitude of the full-land hit layer. The picking surface is independent of the
 * drawn caps (which are pruned); keeping it at the base cap altitude means a ray
 * resolves the same surface the user sees.
 */
export const HIT_ALTITUDE = CAP_BASE;

/**
 * Two co-located caps — an enclave and its host, a city-state and the country
 * around it — are at the same altitude, so their hit distances differ only by
 * tessellation sag (fractions of a unit). Inside this window the smaller country
 * wins; outside it the nearest hit wins. Without the window, clicking Lesotho
 * was a coin flip between Lesotho and South Africa, decided by triangle order.
 */
export const PICK_EPSILON = 0.5;

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

/**
 * The nearest unoccluded hit, with a size tiebreak for co-located caps.
 *
 * `firstUnoccluded` answers "is the frontmost thing in front of the planet?".
 * This adds the micro-state rule: among hits within `epsilon` of the frontmost
 * one — an enclave inside its host, a city-state inside its neighbour, two
 * islands whose caps overlap by a rounding error — the smallest country (by
 * `sizeOf`, the app's bbox span) wins. All caps in the hit layer share one
 * altitude, so "within epsilon" is exactly the set that is visually on top of
 * each other; a genuinely nearer surface is farther than that and still wins.
 *
 * `hits` must be sorted near→far, which `Raycaster.intersectObjects` guarantees.
 * Every candidate is still checked against the planet, so a ray cannot reach
 * through the globe into a tie on the far side.
 */
export function nearestUnoccluded<T extends { distance: number }>(
  hits: readonly T[],
  occluderDistance: number,
  epsilon: number,
  sizeOf: (hit: T) => number
): T | null {
  const first = firstUnoccluded(hits, occluderDistance);
  if (!first) return null;

  let best = first;
  let bestSize = sizeOf(first);
  for (let i = 1; i < hits.length; i++) {
    const hit = hits[i];
    // Sorted, so once the window closes no later hit can re-enter it.
    if (hit.distance - first.distance > epsilon) break;
    if (hit.distance >= occluderDistance) break;
    const size = sizeOf(hit);
    if (size < bestSize) {
      best = hit;
      bestSize = size;
    }
  }
  return best;
}
