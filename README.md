# World Top Songs — React Router 7 + Vite + react-globe.gl

Spin a 3D globe, click any country, and play its current Top 20 songs or videos. No accounts, no API keys, no billing.

## Stack

- **React Router 7** (framework mode, formerly Remix) + **Vite 8** + **React 19**
- **react-globe.gl** globe, client-only via `lazy()` + mount guard (never imported during SSR)
- **Tailwind CSS v4** via `@tailwindcss/vite`
- **Vercel** preset (`@vercel/react-router/vite`) — zero-config deploy

## How it works

- **Globe** (`app/routes/_index.tsx` + `app/components/`): rotate, zoom and
  click any country. The camera has one comfortable focus framing, so selecting
  a microstate never flies outward; Escape — or an empty tap on a wide layout —
  returns to world view while keeping the selection. `⌘K` opens the
  keyboard-complete picker, which matches names, ISO codes and common aliases
  and marks charted countries; Surprise me only lands on one of those.
- **Charts** (`GET /api/charts?country=XX`, `app/routes/api.charts.ts`):
  - 68 chart countries → official **YouTube weekly Top Songs + Top Videos**, 20
    per kind (rank, movement, weekly plays, exact chart week), keyless via
    charts.youtube.com's own web-client API. One request returns both kinds, so
    switching tabs is instant.
  - Every response carries the chart week, `source` (`live`/`stale`) and
    `fetchedAt`. An upstream failure serves the last good copy marked stale;
    with no last good copy the route returns an error. Nothing is fabricated or
    borrowed from another country.
  - Uncharted countries return an explicit `charted: false` payload, never a
    fallback list.
  - Cached in-process for eight hours and served with `Cache-Control` for the
    browser and CDN. `?refresh=1` bypasses the server cache, which is what the
    panel's retry uses. The browser keeps a bounded, eight-hour copy in
    `localStorage`, so a reload paints from storage before the network.
  - The selected country is `?c=XX` and the active tab is
    `?kind=songs|videos`; both survive reload and back/forward.
  - Hover is a prefetch signal: resting on a charted country for 150ms starts
    its request, so the click that follows renders from memory. The 100ms
    budget is measured against the production build.
- **Player**: embedded YouTube queue with auto-advance; unavailable videos are
  skipped. The queue is a session snapshot, so changing country or tab never
  interrupts playback.
- **Map data**: two build inputs under `data/maps/` produce the two runtime
  layers in `public/`. Natural Earth 50m with the Kashmir dispute drawn per the
  Survey-of-India claim (PoK + Aksai Chin in India). Pipeline:
  `scripts/build-world-map.mjs` (symmetric claim cut, rewinds boolean-op output
  to Natural Earth winding — inverted winding makes the triangulator fill the
  whole sphere) → `scripts/simplify-map.mjs` (61% fewer verts for the hover
  raycast) → `scripts/build-map-layers.mjs` (caps, borders and
  `app/lib/countryMeta.ts`). Gated by `scripts/map-check.mjs` (claim probes +
  zero overlap), `scripts/tri-check.mjs` (every piece triangulates to a local
  patch) and `scripts/map-layers-check.mjs` (part grouping + draw-call budget).

## Getting started

```bash
npm install
npm run dev        # binds LAN too (--host) for testing from other machines
```

Open http://localhost:5173 (React Router prints the URL; port differs from Next.js).

## Checks

```bash
npm run typecheck      # react-router typegen + tsc
npm run build
npm run check:map      # claim probes, triangulation, part grouping, draw-call budget
npm run check:store    # persisted chart store: TTL, corruption, eviction (no browser)
npm run check:prefetch # hover-prefetch rules behind an injected scheduler (no browser)
npm run check:focus    # camera framing and world-view transitions (no browser)
npm run check:pick     # ~415k-ray sweep of the picking rule (no browser)
npm run check:player   # playback with a fake IFrame API and stubbed charts (dev server)
npm run check:latency  # 100ms budget against the production build
npm run check:globe    # store, prefetch, focus, player, pick, browser gate, latency (dev server)
node --experimental-strip-types --no-warnings scripts/diff-check.mjs  # charts differ per country
node scripts/build-world-map.mjs                                       # regenerates the map, then:
node scripts/simplify-map.mjs && npm run check:map
```

`npm run check:globe` is the end-to-end gate. The no-browser checks run first:
`check:store` covers TTL, corruption and eviction in the persisted chart store;
`check:prefetch` proves debounce-on-rest, charted-only, cancel-on-leave and
adopt-on-click with an injected scheduler; `check:focus` sweeps the camera rule
across 320–2560px widths and 0–800px sheets; `check:pick` raycasts the full-land
picking geometry and checks every source part against an independent
point-in-polygon oracle. `check:player` then drives the transport in a browser
with deterministic doubles. The browser half (`scripts/globe-pick-check.mjs`)
proves the runtime wiring: hover reaches
the header, ocean stays silent, pruned islands such as Hawaii and the Canaries
are clickable, shaky clicks fall back to the press position, drags do not
select, and a tap during startup is queued until the scene is ready. It also
calls `/api/charts` over HTTP and asserts the contract (20 songs and 20 videos
in one response, cache headers, stale-on-failure, a clear error with no last
good copy, an explicit no-chart payload, no seeded data), then checks the panel,
its provenance line, instant tab switching, error/retry recovery, and the
no-chart notice — including that it renders no chart and that its action opens
the picker filtered to charted countries. A resting hover is then shown to
prefetch, with the click that follows costing no request and no skeleton, an
uncharted hover issuing nothing, a move away aborting the request in flight, and
a drag never being mistaken for a hover. On a phone viewport the chart is a
bottom sheet: the chevron folds it to a peek bar and the peek reopens it, every
selection path unfolds it, a tap on open sky folds it, the peek answers for
loading, the chart week and "no official chart", folding hands focus to the peek
and reopening hands it back, and a wide layout has no fold at all. It then
checks layout coherence (a phone's first paint with scripting disabled is
already the settled sheet, the sheet/rail/camera all read one `--sheet-h`, 768px
is a sheet rather than a rail with the wrong reserve, and the player docks
inside the sheet without covering the list or the rail) and focus/world view
(selecting from a closer camera never moves outward, Escape and a wide empty tap
return to the world altitude, pressing the selected country recentres it, and a
resize after Escape does not re-focus the country). Run it after touching
`GlobeView.tsx`, `hitLayer.ts`, the map layers, `api.charts.ts`,
`chartPrefetch.ts`, `chartClient.ts`, `useChart.ts`, `ChartPanel.tsx`,
`ChartPeek.tsx`, `_index.tsx`, `app.css`, or anything that changes polygon
altitudes.

`npm run check:latency` builds the app and serves `build/` with
`react-router-serve` on an ephemeral port, so the 100ms budget is measured in
the environment the product runs in rather than in Vite's development build. It
is the last step of `check:globe`.

`npm run check:player` is the playback gate. It replaces the YouTube IFrame API
and the chart route with deterministic doubles, so it asserts the actual calls —
`loadVideoById`, `setVolume` on the API's 0–100 scale, `seekTo`, `pauseVideo` —
rather than inferring them from a live embed. A queue snapshotted from one list
must survive a tab switch and a country switch without reloading or destroying
the player, the active row is matched by video id across a different list at a
different index, pressing that row pauses and resumes without reloading, a
blocked autoplay exposes a tap that unlocks audio, Media Session `play`/`pause`/
`stop` are commands rather than toggles, and the measured player height drives
the folded sheet and the rail clearance. It runs before the browser gate in
`check:globe`.

## Map data

Two build inputs and three generated runtime artifacts. Never hand-edit any of
them.

- `data/maps/world-50m.geojson` — source of truth. Natural Earth 50m with the
  Kashmir dispute patched per the Survey-of-India claim. Build input only; it is
  not served.
- `data/maps/world-50m-simple.geojson` — the simplified render map (61% fewer
  vertices). Build input only.
- `public/country-caps.geojson` + `public/country-borders.geojson` — the two
  layers the globe draws. Caps are visual only: fills, hover and the selection
  ring, pruned to the parts carrying each country's visual mass. Borders keep
  every 50m ring merged into a single object and also carry `properties.parts`,
  which groups those rings back into polygons. `app/lib/hitLayer.ts` rebuilds
  that full land set at runtime as one invisible mesh per country for picking,
  so a part the caps pruned — Hawaii, the Canaries, the Azores, Jeju, the
  Galapagos — is still clickable without costing a draw call.
- `app/lib/countryMeta.ts` — generated display names, regions and spans, also
  produced by `map:layers`.

Splitting them is what makes the globe usable. As one map, three-globe built a
Mesh + LineSegments pair for each of ~1650 polygon parts — about **8200 draw
calls per frame and 18fps**. Two layers is ~540 draw calls, and it stays smooth.

```bash
npm run map:layers   # regenerate caps + borders + app/lib/countryMeta.ts
```

## Deploy (Vercel)

No env vars needed. `vercel` / `vercel --prod` from this directory, or import the repo in
the Vercel dashboard. Upstream chart endpoints are unofficial and keyless — the app serves the
last good chart marked stale if they change shape, and never fabricates data.
