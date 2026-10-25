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

## The globe: seven rules you must not break

These each cost real debugging time. The combined runtime gate is
`npm run check:globe`: `check:store` (`scripts/chart-store-check.mjs` — no
browser, deterministic TTL/corruption cases), `check:pick`
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
   raycast (`enablePointerInteraction={false}`): the nearest hit on the full-land
   hit layer wins, and it counts only if it is nearer than `surfaceDistance()`. Only
   the hit meshes are raycast — including the 120k-vertex border layer and the
   graticules cost 2ms per pick against 0.09ms.

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
   ⌘K picker, the region rail, Surprise me or the back button left the previous
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
   sweeps ~415k rays at it with no browser at all, because each ray costs a
   microsecond instead of a pointer move plus a settled frame. Keeping
   `surfaceDistance`/`nearestUnoccluded` inline in the component made them testable
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

7. **Picking is against the full-land hit layer, never the pruned caps.** Caps are
   what three-globe draws, and they are deliberately pruned to the parts carrying
   each country's visual mass. That is correct for drawing and fatal for picking:
   Hawaii, the Canaries, the Azores, Jeju, the Galapagos and every Pacific group
   have no cap at all, so clicks on them hit nothing. `app/lib/hitLayer.ts` rebuilds
   every part with an ISO from `properties.parts` in the border layer into one
   merged mesh per country. The layer is never added to the scene, so it costs no
   draw calls; only its children are raycast. `check:pick` proves all 1,644 parts
   are reachable and that the named pruned islands genuinely are absent from the
   caps, so the test cannot pass for the wrong reason.

   Three invariants make that geometry honest:
   - **Boundary densification plus finite interior resolution.** A chord across a
     long edge sags below the shell. Densify to `MAX_EDGE_DEGREES = 2` *and* let
     the tessellator add an interior grid (`CURVATURE_DEGREES = 5`). Densify-only
     left Greenland's interior sagging 0.61 units — deeper than the 0.4-unit lift —
     so the occluder rejected the middle of whole countries.
   - **Rings stay closed.** `densify()` must keep the repeated first point. The
     library's interior-point filter hands the ring to turf/d3, which throw
     "First and last coordinates in a ring must be the same"; because that filter
     only runs for parts wider than the curvature resolution, 91 large parts
     silently vanished from an earlier hit layer. `buildHitLayer` logs every part
     the tessellator rejects.
   - **Altitude is `CAP_BASE` (0.004), never 0.** The hit surface must be the one
     the user sees, and the zero-altitude invariant applies to it too.

### Clicks and startup input

A click is not a drag. `CLICK_SLOP_PX = 10` and `CLICK_MAX_MS = 700`; movement
inside that budget is still a click. On release, the up position is picked first
and the down position is the fallback, so lifting off a pixel outside a small
country still selects what was aimed at. A real drag or a long press never
selects — it only re-picks hover after the camera settles. `onEmptyTap` is
reached only by a genuine tap that missed; the route splits it by layout: narrow
folds the sheet, wide returns to world view.

Input during startup is queued, not dropped. The stage owns `pointerdown` from
mount — before the canvas exists — so an early tap is seen. If the scene cannot
answer yet, the latest tap is stored as a world-space ray when the camera exists
(otherwise as NDC) and replayed exactly once when `interactive` becomes true.
`interactive = capsPainted && hitReady`; until then the loading copy stays up, but
it is `pointer-events-none`, so the stage still receives the tap.

Re-picks are driven by the canvas pointer *and* by the controls' `change` event.
Camera movement (inertia, zoom, auto-rotation, the flight to a selection) never
moves the pointer, so a pointer-only listener leaves the header naming a country
that has since slid away.

### Focus and world view

The camera has exactly two framings, in `app/lib/focus.ts`: one comfortable focus
(globe radius ≈54% of the stage height, capped inside the free stage left of the
rail) and one world view (whole globe, 92% of the free stage). The selected
country's `span` is not an input — it belongs to picking. The old span formula
clamped microstates to the *smallest* radius, which is the farthest camera, so
Singapore flew outward; a fixed focus cannot do that.

`resolveFocus(current, wanted, kind)` is the whole transition rule. `select` and
`recentre` take `min(current, wanted)`: closer or stay, never farther. `world`
and `layout` take `wanted` exactly. `GlobeView` reads `current` from the live
camera (`pointOfView()`), not from route state, because a drag, a wheel zoom or a
flight still in progress changes it without a render. The pure gate
`npm run check:focus` sweeps 320–2560px widths and 0–800px sheets and fails if
the clamp is removed; the browser gate proves the wiring on SG/HK/LU/SV.

Escape returns to world view and keeps `?c=` and the ring. A dialog owns Escape
instead: the picker closes, an open video collapses (`data-video-open` is the
route's guard), and neither also resets the camera. A wide empty tap does the same
as Escape; a narrow one still folds the sheet, because #14's tap contract takes
precedence there and Escape remains the narrow world-view escape hatch.

`worldView` is route state, not just a one-shot camera command: after Escape, a
resize or a sheet re-frame must stay at the world altitude, so the layout branch
reads `worldView` and emits `kind: 'world'`. Any selection clears it. Re-pressing
the selected country changes no URL, so `select` bumps a recentre counter; the
focus effect uses that counter as an input, otherwise the same-ISO click would be
short-circuited and do nothing.

## Charts

One request carries both kinds. `/api/charts?country=XX` returns `songs` and
`videos` in the same payload, because the upstream fetch already produces both and
splitting them costs a round trip every time the user changes tab. `useChart` is
therefore keyed by country alone; the active tab (`?kind=songs|videos`) is a
render-time choice over data already in memory. Adding `kind` to the hook's
dependency list, or restoring a per-kind request, reintroduces the latency this
contract exists to remove.

The URL owns the tab as well as the country: clicking a tab updates `kind`, and a
reload lands on the same list. The tab is not chart data, so it never appears in
the API payload, and an unknown or absent kind falls back to songs without
discarding the selection.

Selection is validated against `COUNTRY_META` — the generated set the caps layer
is built from — not against the loaded map. `?c=` resolves on the first render, so
`useChart` starts in the same commit as the map fetches instead of after both
GeoJSON downloads and parses. A first visit with no `?c=` bootstraps from the
hydrated stored country (falling back to the first charted ISO) as soon as
localStorage has been read. The map-backed record is only needed for the camera
anchor and span; name, region and the chart request never wait for it.

Charts persist in `localStorage`, one entry per country *and* kind
(`wts.chart.v1:<ISO>:songs|videos`), so the payload's two lists survive a reload
independently. `useChart` reads them in a layout effect: on a reload the server
HTML is the skeleton and the cached rows must land before the next paint. Entries
expire after eight hours by their own `savedAt`, a half-written pair is unusable,
and anything unparseable, wrongly shaped or expired is deleted and refetched —
storage is user-writable and throws in private mode, so it is never trusted and
never allowed to throw into a render. The store keeps a bounded number of
countries, evicting the oldest. `scripts/chart-store-check.mjs` covers all of it;
the browser gate proves a reload renders with zero chart requests.

Chart data is never fabricated. An uncharted country returns `charted: false`
with a reason; an upstream failure returns the last good copy marked `stale`, and
only returns a visible error when there is no last good copy. Retry sends
`?refresh=1`, which must bypass both the server's fresh tier and the browser
cache — a retry answered by the cache that held the failure is not a retry.

An uncharted country is a valid answer, not an error. The panel names the
country, prints the payload's reason (falling back to the shared
`NO_CHART_REASON` while the request is in flight, so it never waits behind a
skeleton) and offers the picker already filtered to charted countries. That
filter is requested through `PickerRequest` from the route — the picker is not
duplicated in the panel. A chart payload is only rendered when its `country`
matches the selection, so no response can appear under another country's
heading. `/api/charts?country=AD` returning exactly
`{charted, country, reason}` is asserted over HTTP by the browser gate.

Hover is a prefetch signal. Resting on a charted country for
`HOVER_PREFETCH_MS` (150ms) starts its chart request, so the click that follows
finds the payload in memory and renders a list instead of a skeleton. The rules
live in `app/lib/chartPrefetch.ts` behind an injected scheduler, and
`scripts/chart-prefetch-check.mjs` proves them without a browser (`npm run
check:prefetch`, part of `check:globe`).

- **Rest, not presence.** The wait restarts on every `pointermove`, not when the
  hovered ISO changes. Keying it to the country would prefetch Russia once the
  pointer had spent 150ms crossing it, and a sweep across the globe would issue a
  request for everything it touched.
- **Only charted countries.** Coverage is static, so an uncharted hover issues
  nothing; the answer would be a no-chart payload nobody asked for.
- **Leaving cancels, clicking adopts.** A speculative flight is cancelled when the
  pointer moves to another country, and the browser gate sees that as a failed
  request, not an inferred one. Once `useChart` asks for the same country it takes
  ownership, so a hover that ends while the selected country loads (the pointer
  leaving the canvas) cannot kill the request the panel is showing.
- **A moving camera is not a hover.** Drag inertia, zoom and the flight to a
  selection glide under a resting pointer and look exactly like a deliberate
  hover. `GlobeView` reports `onMotionChange`; the route disables the prefetcher
  until the camera has been still for `MOTION_SETTLE_MS`.

`useChart` never aborts on a country change: the request is shared with the
prefetcher and its payload is worth keeping, so a generation counter drops a late
answer for the previous country instead. `app/lib/chartClient.ts` owns the single
`fetch`, the single persisted store and the bounded in-memory cache (64
payloads), so the panel and the prefetcher cannot disagree about what is in
flight. The browser gate's timed clicks run with the renderer paused: headless
Chromium rasterises this scene on the CPU at ~50ms a frame, and the selection
update is a transition, so the rasteriser alone added 150-280ms to the number the
check reports.

## Player

Playback is session state, not chart state. The queue is a snapshot taken when the
user pressed play and lives in the route, so switching country or tab never
interrupts audio; the chart panel is told what is playing by `videoId`, never by
index, because the two lists stop corresponding the moment either changes. The
player is a sibling of the panel for the same reason — rendering it inside
`data && ...` tore down the iframe on every country switch.

Pressing the row that is already playing is a transport action, not a second
play. The route compares the clicked row's `videoId` with the active one and calls
`NowPlaying`'s handle (exposed through `handleRef`) directly: routing it through
`activeIndex` made it a dead click while paused, and a restart from zero when it
was not. The call has to stay inside the click handler, because that gesture is
what lets `syncAudio()` unmute.

`--player-h` is measured from the mounted card by a `ResizeObserver`, not trusted
from the fallback in `app.css`. Opening the video or showing the autoplay notice
makes the card taller than that fallback, and the folded `--sheet-h` and the
rail's clearance are both derived from it; the CSS value only covers the first
frame after the player appears.

The IFrame API's volume is **0–100**. `setVolume(0.8)` is 0.8%, not 80%; that was
the "player is inaudible" bug. `DEFAULT_VOLUME = 100`, and `syncAudio()` re-asserts
mute/volume on every player state change, because Chrome and Safari block audible
autoplay and YouTube responds by starting muted and *staying* that way. Dragging
the slider to zero mutes instead of playing at 0%, and unmuting at zero restores
the last audible level. The slider expands on `focus-within` as well as hover, so
it is reachable on a touch screen.

The scrubber's fill and buffered bars are driven by direct DOM writes, never by
React state — eight re-renders a second to move a bar is what makes a player feel
cheap. But they must **not** also carry a Tailwind `scale-*` class: in v4 that
compiles to the standalone `scale` property, which *composes* with an inline
`transform` instead of being replaced by it, so `scale-x-0` held both bars at zero
width while the time label, `aria-valuetext` and click-to-seek all carried on
working — a progress bar that silently rendered nothing. v3 wrote both to
`transform`, so this only broke on the v4 upgrade. Set the initial `scaleX(0)`
inline and leave the scale utilities off these elements. While a pointer owns the
thumb the 120ms poll stops writing the range and its text, and `seekToFraction`
paints both immediately; otherwise the thumb jumps back to the player's position
on the next tick.

The MacBook transport keys (F7/F8/F9, Touch Bar, Control Centre) arrive as **Media
Session actions, not `keydown` events**. Nothing about them works until the page
installs `navigator.mediaSession` handlers and sets `metadata` — which is why they
did nothing at all. Register the handlers once and read the transport through a
ref, or they get re-registered on every track change. `play`, `pause` and `stop`
are commands, not toggles: the old code routed all three through `toggle`, so Stop
on a paused track started it and Play paused it. `nexttrack`/`previoustrack` walk
the same snapshot queue as the buttons; they are the hardware path, not a second
one.

Player startup is bounded at both waits. An ad blocker leaves the `iframe_api`
request to fail and `onYouTubeIframeAPIReady` never fires, so `loadApi()` rejects
on the script's `error` event as well as after `PLAYER_TIMEOUT_MS`; a script that
loads but whose player never reports `onReady` rejects on the same clock. Either
way the card shows a message and a **Try again**, and the transport controls are
disabled rather than silently dead. Retry increments `attempt`, which is a
dependency of both the API load and player construction: the old player is
destroyed and a new one is built even though the video id is unchanged. A failed
`iframe_api` script is removed when it fails, or retry would wait on the same dead
request forever.

A video the IFrame API rejects calls `onTrackError`; the route owns the queue, so
it owns the skipping. It records the failed video id, advances to the next entry
in the snapshot that has not failed, and only reports `queueError` once every
entry has been tried. That is what stops the old `load → error → load` loop: skip
while something is untried, stop with an explanation when nothing is. A deliberate
new play clears the failed set, and the queue retry resets it before asking the
player to rebuild. Broken tracks stay skipped only within a queue; they are not
remembered across one.

`npm run check:player` covers all of the above in a browser with the IFrame API
and the chart route doubled, so it needs no network: exact
`loadVideoById`/`setVolume`/`seekTo` calls, tab and country changes that must not
reload or destroy the player, the same-row transport, the autoplay tap,
idempotent Media Session commands, the OS next/previous keys, a broken track being
skipped, an all-unplayable queue stopping after one pass, a blocked API and a
startup that never becomes ready both failing inside the bound with a working
retry, and the sheet/rail geometry with a measured player.

## Routing and recovery

The URL is the source of truth for selection. `?c=XX` holds the map ISO, user
selections push a history entry, and back/forward re-derive the selection from
the URL rather than keeping a second copy in state. A country tap therefore
survives reload and is shareable.

Not every URL is trustworthy, so there are three distinct cases:

- **No `c` at all** is the intentional empty stage after `closePanel`. It must not
  be auto-filled.
- **No `c` on first load** bootstraps the stored country, then the first charted
  country, with `replace` so the bootstrap does not become a history entry.
- **`?c=` present but blank or unknown** is a bad link. Once the map is available
  it recovers to the stored/first country with `replace` and shows an inline
  notice in the chart panel. A bad URL must never leave a bare globe. Lower-case
  and whitespace-padded codes are the same selection and are canonicalised in
  place.

Unknown routes are a catch-all `routes/not-found.tsx`, not the root boundary. The
root `ErrorBoundary` in `root.tsx` catches render/loader/action failures. Both
render `RecoveryScreen`; the root boundary sits inside `Layout`, so it must not
render `<html>` or `<head>`. Full-document navigations in the browser gate use a
clean page after the player tests, because a YouTube iframe teardown can log
console noise that has nothing to do with routing.

## Layout

The chart panel is a full-height right rail at `lg` (1024px) and above, so
anything else pinned to the bottom-left must be capped at its left edge. The
region rail was pinned to `sm:left-5` with no right bound, which put its last four
chips *under* the panel — and because the panel is a later sibling with a higher
`z-index`, those chips were not merely covered but unclickable: `elementFromPoint`
over them returned the chart's metadata line. Any viewport narrower than about
1128px with a country selected hit this. The rail's right bound is now `lg:` only,
because below that the panel is a bottom sheet rather than a rail.

`sm` is not the layout breakpoint and must not be used as one. It is still right
for control sizing (the wordmark, the picker shortcut), but the rail, the sheet,
the header's panel inset and `isWide` all switch at `lg`. They used to disagree:
JS called everything under 1024px narrow while CSS turned the panel into a
full-height rail at 640px, so a tablet got a phone's camera framing and a sheet's
`--sheet-h` beside a desktop rail. The 768px gate case exists to keep them equal.

Verify clickability with a real `page.mouse.click` at the element's coordinates, not
`element.click()` in `evaluate` — the latter dispatches straight at the element and
bypasses hit-testing entirely, so it happily "passes" a button no pointer can reach.

### The sheet height is CSS, and everything reads it

`--sheet-h` in `app.css` is the one number the narrow layout is built from: the
chart sheet is exactly that tall, the region rail clears it, and `_index.tsx` reads
the *resolved* px value back to offset the globe's camera and frame its altitude.
`@property --sheet-h` registers it as a `<length>`, so `getComputedStyle` returns
pixels rather than the `48vh` token. Nothing may hardcode a second sheet height.

It lives in CSS rather than an inline style because the first paint is the
server's HTML. An inline value can only be measured after hydration, so a phone
first showed a zero-height sheet and a bottom-pinned rail, then snapped. CSS knows
the viewport before JavaScript does, and `48vh` is deliberate rather than `48dvh`:
the fixed stage is sized by the layout viewport, and a sheet that chased the mobile
URL bar would re-frame the globe while the user was reading.

The route starts `isWide: false` and measures in a layout effect, so hydrated
markup matches the server at every width; the visual layout never waits on that
state because the responsive classes and the variable are CSS. Behaviour — fold
availability, `onEmptyTap` — is what waits for the measurement. The chevron is
`lg:hidden` as well, because the server HTML is mobile-first and a wide no-JS or
pre-hydration paint must not show a control it cannot honour.

Fold and unfold hand focus to the control that replaces the one you pressed: the
chevron to the peek bar, the peek bar back to the chevron. Each unmounts on its own
action, so without the handover a keyboard user is dropped on `<body>` and has to
tab back to the panel they were using. Only those two do it — a selection or an
empty tap leaves focus where the user put it.

Three consequences worth keeping:

- **With nothing selected it still reserves the full `48vh`.** No sheet is on
  screen, but the globe is framed against that reservation, so collapsing it to
  the peek bar silently moved it on a first visit before the bootstrap had picked
  a country.
- **The player is inside the sheet, not under it.** The dock is one flex column at
  a fixed `--sheet-h`: the chart takes the flexible space and the player keeps its
  natural height, so playing a song shortens the list instead of pushing the sheet
  over the rail. With no selection the player still docks, and the rail clears its
  measured height (`--player-h`) rather than sitting under it.
- **`globeOffset` is gone, replaced by an imperative tween.** As a prop,
  three-globe applies it on the frame it changes, which turned a fold into a ~200px
  jump; and because the route re-renders on every globe hover, a fresh array each
  time re-wrote the camera's view offset on every pointer move. `offset` is
  memoised and `GlobeView` eases `camera.setViewOffset` over `OFFSET_TWEEN_MS`.
  The *first* write is not a move and must not be tweened: the camera has simply
  never been offset, so tweening out of that start slides the globe across the
  screen on every load, and skipping the write leaves it centred under the panel.

A tap that hits a country always unfolds, on every path — globe, picker and Surprise
me all go through `select`. Left folded, that tap lights the country up and appears
to do nothing, because the list it asked for is hidden.

## Announcements

Hover is announced by its own sr-only live region in the header, never by the
visible readout. The readout falls back to the standing hint the moment the
pointer leaves land, so making the paragraph itself the live region meant every
crossing of water announced "Drag to spin · select a country · ⌘K to search" —
ocean hover was not silent — and land hover arrived wrapped in visual chrome
("MX · Mexico select"). The live region holds the country name, and empties
without speaking when the pointer is over water. `globe-pick-check.mjs` reads
hover from the visible ISO and the announcement from `header p [aria-live]`, so
both halves have to keep working together. Selection and chart state have their
own sr-only live region in the route.

## Map layers

The globe draws two layers, both generated — never hand-edit them:

- `public/country-caps.geojson` — **visual only** now. Fills, hover and the
  selection ring, pruned to the polygon parts that carry each country's visual
  mass (~266 parts) so draw calls stay low. A pruned part is still clickable,
  because picking does not use this layer.
- `public/country-borders.geojson` — every 50m border merged into ONE
  MultiLineString, drawn as a single `LineSegments`. Full fidelity, 1 draw call.
  Its `properties.parts` groups ring indices back into polygons (`{ iso, rings }`,
  first ring outer, rest holes), which is the only full-fidelity land geometry and
  therefore what `app/lib/hitLayer.ts` rebuilds for picking. Units with no ISO —
  Kosovo, Somaliland, N. Cyprus, Siachen — stay drawn but ungrouped, so they are
  deliberately unselectable rather than silently assigned to a neighbour.

Regenerate with `npm run map:layers` (after changing `world-50m-simple.geojson`).
Gate with `npm run check:map`; it asserts the part grouping reconstructs every
selectable source polygon exactly, that no-ISO rings stay ungrouped, and that the
named pruned islands are present in the land grouping but absent from the caps.
`app/lib/countryMeta.ts` is also generated — edit the override tables in
`scripts/build-country-meta.mjs` and re-run.

## Design system

`app/app.css` holds the whole token set: one theme, warm charcoal and bone with a
single brass accent, Fraunces for names, Inter for controls and numbers, a small
fixed type scale, three radii, two shadows and motion tokens. There is no theme
switcher and no `<html data-theme>` handoff; the shell boots straight into these
values, so there is no theme flash.

Canvas colours are the one exception. three-globe needs concrete colour strings,
not `color-mix`, so `--globe-*` lives in the same file and
`app/hooks/useGlobePalette.ts` reads it once. Keep `--globe-border` *light* so it
reads against the sphere, and keep `--globe-cap-hover` a different hue from
`--globe-cap-selected` because hover does not lift the cap.

Colour and motion carry state only — hover, selection, playback, movement. The
equaliser is the only looping animation left. Surfaces are solid, never frosted;
a new component should use `.surface`, `.btn`, `.chip`, `.kbd` and `.eyebrow`
rather than composing its own radius, shadow or type size.

## Agent skills

### Issue tracker

Issues and specs live as GitHub issues, managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles map 1:1 to label strings. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` at the repo root, decisions under `docs/adr/`. See `docs/agents/domain.md`.
