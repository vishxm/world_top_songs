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

## The globe: six rules you must not break

These each cost real debugging time. All are enforced by
`npm run check:globe`, which is two gates: `check:pick`
(`scripts/globe-pick-geometry.mjs` — no browser, ~600k rays) for the picking rule
itself, and `globe-pick-check.mjs` for the wiring that only exists at runtime.

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

5. **Every input that changes the cap styling must be a repaint dependency.** All
   styling funnels through `applyHoverVisuals()`, and the effect that calls it
   lists `selectedIso` explicitly. It used to list only its own callback, so the
   repaint fired when the *hover* changed and at no other time. Selecting from the
   ⌘K palette, the region rail, Surprise me or the back button left the previous
   country lit and the new one unlit until the pointer next moved — the pointer
   being off the canvas is precisely the case that had no repaint. `hoverIso` is
   deliberately *not* a dependency: hover is applied synchronously inside the
   pointer handler so the cap is correct before the next pick reads geometry.

   The region filter has to be handled in `applyHoverVisuals` as well as in
   `getCapColor`, because `getCapColor` only runs inside a re-digest and changing
   the region alters no polygon prop's identity, so it never re-digests. Colour
   precedence is selection, then hover, then in/out of region; the lift marks the
   selection independently, so a selected country outside the active region stays
   findable.

6. **The picking rule lives in `app/lib/pick.ts`, and it stays there.** `check:pick`
   sweeps ~600k rays at it with no browser at all, because each ray costs a
   microsecond instead of a pointer move plus a settled frame. Keeping
   `surfaceDistance`/`firstUnoccluded` inline in the component made them testable
   only through the UI, which is why the browser gate took 25+ minutes and could
   only afford a few hundred samples.

   The gate's oracle is deliberately *not* a second raycast: it solves where the ray
   meets the sphere, converts to lat/lng, and runs point-in-polygon on the GeoJSON.
   Asserting a raycast against a raycast proves nothing.

   Two traps in that oracle, both of which look exactly like the picking rule being
   catastrophically broken:
   - `toCartesian` uses `theta = 90 - lng`, so the inverse is `90 - atan2(z, x)`.
     Forgetting the 90° rotates the oracle a quarter-turn off the caps.
   - three-globe swaps x and z relative to the textbook spherical convention, so
     both the camera position and the surface normal are derived from
     `toCartesian` itself. `setFromSphericalCoords` and a hand-written normal both
     land in the other convention.

   Limb rays (incidence < `MIN_INCIDENCE`) are counted and reported, not asserted:
   the caps are a lifted shell whose silhouette does not line up with the sphere's,
   so a surface point solved from a grazing ray legitimately disagrees about which
   sliver of which country is under the pixel. Rays that miss the planet are never
   asserted silent either — a sliver of every near-limb country is correctly
   visible against the sky, which is what the `Infinity` in `surfaceDistance` is for.

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

The scrubber's fill and buffered bars are driven by direct DOM writes, never by
React state — eight re-renders a second to move a bar is what makes a player feel
cheap. But they must **not** also carry a Tailwind `scale-*` class: in v4 that
compiles to the standalone `scale` property, which *composes* with an inline
`transform` instead of being replaced by it, so `scale-x-0` held both bars at zero
width while the time label, `aria-valuetext` and click-to-seek all carried on
working — a progress bar that silently rendered nothing. v3 wrote both to
`transform`, so this only broke on the v4 upgrade. Set the initial `scaleX(0)`
inline and leave the scale utilities off these elements.

The MacBook transport keys (F7/F8/F9, Touch Bar, Control Centre) arrive as **Media
Session actions, not `keydown` events**. Nothing about them works until the page
installs `navigator.mediaSession` handlers and sets `metadata` — which is why they
did nothing at all. Register the handlers once and read `toggle`/`step` through a
ref, or they get re-registered on every track change.

## Layout

The chart panel is full-height on the right at `sm` and above, so anything else
pinned to the bottom-left must be capped at its left edge. The region rail was
pinned to `sm:left-5` with no right bound, which put its last four chips *under*
the panel — and because the panel is a later sibling with a higher `z-index`, those
chips were not merely covered but unclickable: `elementFromPoint` over them
returned the chart's metadata line. Any viewport narrower than about 1128px with a
country selected hit this.

Verify clickability with a real `page.mouse.click` at the element's coordinates, not
`element.click()` in `evaluate` — the latter dispatches straight at the element and
bypasses hit-testing entirely, so it happily "passes" a button no pointer can reach.

### The sheet folds on narrow layouts, and the globe's framing follows it

Below `sm` the chart is a bottom sheet covering half the screen, so seeing the globe
meant closing the chart and losing the selection. It now *folds* instead, to a peek
bar: via the chevron in the panel header, via a tap on the globe that hits no
country (`onEmptyTap` — a tap that already had nothing else to do), and back open
from the peek bar. Folding is not closing: `?c=` stays, the ring stays on the globe,
and the audio keeps playing. Wide layouts have a rail rather than a sheet, so
`setFolded` short-circuits on `isWide` and the chevron is not rendered at all.

`sheetReserve` in `_index.tsx` is the sheet's height in px, and it is the *only*
number the globe offset, the camera altitude and the chrome offsets are derived
from — the rail and the hint read it back out of a `--sheet-h` custom property on
`<main>`, because `bottom-[calc(48vh+1.25rem)]` is simply the wrong number once the
sheet can be 56px tall, and Tailwind cannot compute one class from another. Two
consequences worth keeping:

- **With nothing selected it still reserves the full `48vh`.** No sheet is on
  screen, but the globe and the hint are framed against that reservation, so
  collapsing it to the peek bar silently moved both on a first visit before the
  bootstrap had picked a country.
- **`globeOffset` is gone, replaced by an imperative tween.** As a prop,
  three-globe applies it on the frame it changes, which turned a fold into a ~200px
  jump; and because the route re-renders on every globe hover, a fresh array each
  time re-wrote the camera's view offset on every pointer move. `offset` is
  memoised and `GlobeView` eases `camera.setViewOffset` over `OFFSET_TWEEN_MS`.
  The *first* write is not a move and must not be tweened: the camera has simply
  never been offset, so tweening out of that start slides the globe across the
  screen on every load, and skipping the write leaves it centred under the panel.

A tap that hits a country always unfolds, on every path — globe, palette and Surprise
me all go through `select`. Left folded, that tap lights the country up and appears
to do nothing, because the list it asked for is hidden.

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
