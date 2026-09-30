# Agent rules

React Router 7 (framework mode) + Vite 8 + React 19. Routes live in `app/routes/`
(`routes.ts` is the route manifest). Path alias: `~/` maps to `./app/`
(see `tsconfig.json` + `vite-tsconfig-paths` in `vite.config.ts`).

- `app/routes/api.charts.ts` is a resource route (exports `loader`, no UI).
  Server-only chart pipeline lives in `app/lib/` — never import it from components.
- `react-globe.gl` touches `window` at import time: keep the `lazy()` + mount-guard
  pattern in `app/components/GlobeView.tsx` so it never loads during SSR.
- Checks: `npm run typecheck` (typegen + tsc) and `npm run build`.
- Dev server: `npm run dev` (binds `--host` for LAN testing).

## The globe: two rules you must not break

These cost a day to find. Both are enforced by `scripts/globe-pick-check.mjs`.

1. **A polygon altitude of 0 is a bug, not a default.** three-globe builds polygon
   geometry at `GLOBE_RADIUS` and applies `polygonAltitude` as a uniform mesh scale
   of `1 + alt`. So `alt = 0` puts a cap *exactly coplanar* with the globe mesh:
   it z-fights, and the raycast becomes numerically unreliable, silently dropping
   a large random-looking share of countries from hover and click. Keep every cap
   lifted (`CAP_BASE` in `GlobeView.tsx`).

2. **Polygon prop accessors must be referentially stable.** three-globe re-digests
   and rebuilds the geometry of *every* polygon when a polygon prop's function
   identity changes. Keying `polygonAltitude`/`polygonCapColor` off hover state
   rebuilds ~270 caps per pointer move, and caps are still mid-rescale when the
   next raycast fires — which reads as "hovering picks the wrong country". Hover
   visuals are applied imperatively in `applyHoverVisuals()` instead.

Also: the globe sphere sits at radius 100 and caps are lifted above it, so the
sphere always wins a *nearest-hit* contest. `pointerEventsFilter` must keep
rejecting `globe`, or no country is ever hoverable.

## Map layers

The globe draws two layers, both generated — never hand-edit them:

- `public/country-caps.geojson` — interaction + fills. Pruned to the polygon parts
  that carry each country's visual mass (~266 parts) so draw calls stay low.
- `public/country-borders.geojson` — every 50m border merged into ONE
  MultiLineString, drawn as a single `LineSegments`. Full fidelity, 1 draw call.

Regenerate with `npm run map:layers` (after changing `world-50m-simple.geojson`).
Gate with `npm run check:map`. `app/lib/countryMeta.ts` is also generated — edit
the override tables in `scripts/build-country-meta.mjs` and re-run.

## Visual themes

`app/app.css` holds the token set. The header's theme button cycles
`<html data-theme>` across four directions; each only overrides CSS variables,
including a separate `--globe-*` set for canvas colours (three-globe needs
concrete colour strings, not `color-mix`). Add a direction there, not in JS.
