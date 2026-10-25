/**
 * Camera framing for the globe — pure layout maths, no React and no three.
 *
 * The old rule derived the focus altitude from the selected country's angular
 * span and clamped it between a "minimum" and "maximum" screen radius. The clamp
 * was inverted for microstates: a tiny span resolved to the *smallest* radius,
 * which is the *farthest* camera, so selecting Singapore flew outward. The rule
 * also meant every country got a different framing, and the camera's distance
 * depended on a number that only picking should care about.
 *
 * Here there are exactly two framings:
 *
 *   - `focusAltitude` — one comfortable size for any country. A country is
 *     centred, and its neighbours stay on screen because the whole visible cap is
 *     wider than one country.
 *   - `worldAltitude` — the whole globe, used by Escape and by an empty tap.
 *
 * `resolveFocus` is the only transition rule: a selection may move closer or
 * stay, never farther. That makes "selecting never zooms out" true by
 * construction, without a table of special cases.
 */

/** three-globe's fixed vertical field of view, in degrees. */
const FOV_DEGREES = 50;
const FOV_TAN = Math.tan((FOV_DEGREES / 2) * (Math.PI / 180));

/** The chart rail's width and its gutter — the space the globe cannot use. */
export const PANEL_WIDTH = 384;
export const GUTTER = 48;
/** Vertical space the header occupies on narrow screens. Matches Header.tsx's
 *  two-row mobile layout and the camera offset in `_index.tsx`. */
export const HEADER_CLEARANCE = 118;

export type FocusLayout = {
  width: number;
  height: number;
  isWide: boolean;
  /** Resolved `--sheet-h` in px. Ignored on wide layouts, which have a rail. */
  sheetPx: number;
};

/**
 * How the camera may move.
 *
 * - `select` / `recentre` — a user chose a country (or pressed it again): move
 *   closer if the current camera is farther, otherwise stay where the user put it.
 * - `world` — Escape or an empty tap: the whole globe, exactly.
 * - `layout` — the sheet folded or the viewport changed: re-frame to the size the
 *   new layout wants, even if that means moving out.
 */
export type FocusKind = "select" | "recentre" | "world" | "layout";

/** Distance used before the stage has been measured. */
const UNMEASURED_ALTITUDE = 2.5;

/**
 * Altitude that makes a sphere of radius `screenRadius` px on a viewport
 * `viewportH` px tall.
 *
 * Solved from the projection rather than approximated: the sphere's angular
 * radius is `asin(1 / (1 + altitude))` and its screen radius is
 * `f * tan(angle)`, with `f = viewportH / (2 * tan(fov / 2))`. Inverting that
 * keeps the framing correct at every viewport height, which the old linear
 * approximation did not — it drew a globe noticeably larger than the radius it
 * asked for.
 */
export function altitudeForScreenRadius(viewportH: number, screenRadius: number): number {
  if (!(viewportH > 0) || !(screenRadius > 0)) return UNMEASURED_ALTITUDE;
  const focal = viewportH / (2 * FOV_TAN);
  return Math.sqrt(focal * focal + screenRadius * screenRadius) / screenRadius - 1;
}

const finite = (n: number) => Number.isFinite(n) && n > 0;

/**
 * One comfortable focus framing. The globe's radius is about 54% of the stage
 * height, capped so it keeps a little margin inside the free stage left of the
 * rail. The visible cap is far wider than any country, so neighbours stay on
 * screen while the selection is centred.
 *
 * Narrow layouts cannot zoom in: the globe already shares the viewport with the
 * header and the sheet. There, focus and world are deliberately the same.
 */
export function focusAltitude(layout: FocusLayout): number {
  const { width, height, isWide } = layout;
  if (!isWide) return worldAltitude(layout);
  if (!finite(width) || !finite(height)) return UNMEASURED_ALTITUDE;
  const stageWidth = Math.max(1, width - (PANEL_WIDTH + GUTTER));
  const radius = Math.max(1, Math.min(stageWidth * 0.6, height * 0.54));
  return altitudeForScreenRadius(height, radius);
}

/**
 * The whole globe, with room around it: 92% of the smaller of the free stage's
 * width and the viewport height. On a narrow layout the sphere is fitted to the
 * clear band above the sheet instead, using the resolved `--sheet-h` the rest of
 * the layout already reads.
 */
export function worldAltitude(layout: FocusLayout): number {
  const { width, height, isWide, sheetPx } = layout;
  if (!finite(width) || !finite(height)) return UNMEASURED_ALTITUDE;
  if (!isWide) {
    const sheet = Number.isFinite(sheetPx) && sheetPx > 0 ? sheetPx : 0;
    const clearBand = Math.max(0, height - sheet - HEADER_CLEARANCE);
    const radius = Math.max(1, Math.min(width * 0.47, clearBand * 0.5));
    return altitudeForScreenRadius(height, radius);
  }
  const stageWidth = Math.max(1, width - (PANEL_WIDTH + GUTTER));
  const radius = Math.max(1, Math.min(stageWidth * 0.46, height * 0.46));
  return altitudeForScreenRadius(height, radius);
}

/**
 * Resolve a requested framing against where the camera actually is.
 *
 * `current` is read from the live camera, not remembered by the route: a drag,
 * a wheel zoom or an in-flight flight all change it without a render, and a
 * remembered number would be stale exactly when it matters.
 */
export function resolveFocus(current: number, wanted: number, kind: FocusKind): number {
  if (!Number.isFinite(wanted) || wanted < 0) {
    return Number.isFinite(current) && current > 0 ? current : UNMEASURED_ALTITUDE;
  }
  if (!Number.isFinite(current) || current <= 0) return wanted;
  return kind === "select" || kind === "recentre" ? Math.min(current, wanted) : wanted;
}
