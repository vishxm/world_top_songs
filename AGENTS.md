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

## The globe: four rules you must not break

These each cost real debugging time. All are enforced by
`npm run check:globe` (`scripts/globe-pick-check.mjs`).

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

3. **Never re-enable three-render-objects' pointer interaction.** The globe sphere
   sits at radius 100 and the caps are lifted above it, so the sphere is always the
   nearest hit. `hoverFilter` receives the hit *object* but never the hit
   *distance*, and returns the first hit that passes — so the only way to reach a
   country is to reject the sphere, and once it is rejected the scan runs on into
   caps on the **far side of the planet**. It reported Tanzania for pixels over
   Brazil, with no highlight drawn anywhere. `GlobeView.tsx` therefore runs its own
   raycast (`enablePointerInteraction={false}`): nearest cap wins, and a cap counts
   only if it is nearer than `surfaceDistance()`. Only caps are raycast — including
   the 120k-vertex border layer and the graticules cost 2ms per pick against 0.09ms.

   `surfaceDistance()` solves the sphere analytically and returns `Infinity` when
   the ray misses it, *not* a small number. The caps are lifted, so a sliver of
   every cap lies outside the planet's silhouette and is legitimately visible
   against the sky; a ray that misses the sphere has nothing in front of it, and
   whatever cap it hits is a near-limb one. Returning a near distance there drops
   a band of countries around the limb (Germany, the UK, France, Algeria, Brazil)
   from hover. It cannot let a far-side cap through, because a ray that reaches
   one has passed through the globe and so always has an occluder in front of it.

4. **Hover must not change geometry.** Because altitude is a *scale*, lifting a cap
   grows it outward, and a 2% lift is several pixels of apparent size: the hovered
   country bleeds over its neighbours and captures the cursor from them. Only the
   selection lifts (`CAP_SELECTED`); hover is signalled by colour alone, so the two
   states must differ in hue, not just opacity.

Re-picks are driven by the canvas pointer *and* by the controls' `change` event.
Camera movement (inertia, zoom, auto-rotation, the flight to a selection) never
moves the pointer, so a pointer-only listener leaves the header naming a country
that has since slid away.

## Player

Playback is session state, not chart state. The queue is a snapshot taken when the
user pressed play and lives in the route, so switching country or tab never
interrupts audio; the chart panel is told what is playing by `videoId`, never by
index, because the two lists stop corresponding the moment either changes. The
player is a sibling of the panel for the same reason — rendering it inside
`data && ...` tore down the iframe on every country switch.

The IFrame API's volume is **0–100**. `setVolume(0.8)` is 0.8%, not 80%; that was
the "player is inaudible" bug. `DEFAULT_VOLUME = 100`, and `syncAudio()` re-asserts
mute/volume on every player state change, because Chrome and Safari block audible
autoplay and YouTube responds by starting muted and *staying* that way.

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

All four directions use the same night texture, which constrains the globe tokens
in every theme: `--globe-border` must be *light* or it disappears into the dark
limb, and `--globe-cap-hover` must differ in hue from `--globe-cap-selected`
because hover no longer lifts the cap.
