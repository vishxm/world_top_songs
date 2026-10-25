# World Top Songs — Remix + Vite + react-globe.gl

Spin a 3D globe, click any country, and play its current Top 20 songs or videos. No accounts, no API keys, no billing.

## Stack

- **React Router 7** (framework mode, formerly Remix) + **Vite 8** + **React 19**
- **react-globe.gl** globe, client-only via `lazy()` + mount guard (never imported during SSR)
- **Tailwind CSS v4** via `@tailwindcss/vite`
- **Vercel** preset (`@vercel/react-router/vite`) — zero-config deploy

## How it works

- **Globe** (`app/routes/_index.tsx` + `app/components/`): rotate / zoom / click any country.
  Search box doubles as a precise picker; 🎲 Surprise me jumps somewhere random.
- **Charts** (`GET /api/charts?country=XX`, `app/routes/api.charts.ts`):
  - 69 chart countries → official **YouTube weekly Top Songs + Top Videos**, 20 per kind
    (rank, movement, weekly plays, exact chart week), keyless via charts.youtube.com's own
    web-client API. One request returns both kinds, so switching tabs is instant.
  - Every response carries the chart week, `source` (`live`/`stale`) and `fetchedAt`.
    An upstream failure serves the last good copy marked stale; with no last good copy the
    route returns an error. Nothing is fabricated or borrowed from another country.
  - Uncharted countries return an explicit `charted: false` payload, never a fallback list.
  - Cached in-process for eight hours and served with `Cache-Control` for the browser and
    CDN. `?refresh=1` bypasses the server cache, which is what the panel's retry uses.
  - The active tab is `?kind=songs|videos` in the URL, separate from the chart payload.
- **Player**: embedded YouTube queue with auto-advance; unavailable videos are skipped.
- **Map data**: `public/world-50m-simple.geojson` (what the globe renders) —
  Natural Earth 50m with the Kashmir dispute drawn per the Survey-of-India
  claim (PoK + Aksai Chin in India). Pipeline: `scripts/build-world-map.mjs`
  (symmetric claim cut, rewinds boolean-op output to Natural Earth winding —
  inverted winding makes the triangulator fill the whole sphere) →
  `scripts/simplify-map.mjs` (61% fewer verts for hover raycast) →
  gated by `scripts/map-check.mjs` (claim probes + zero overlap) and
  `scripts/tri-check.mjs` (every piece triangulates to a local patch).
  `public/world-50m.geojson` is the full-res intermediate.

## Getting started

```bash
npm install
npm run dev        # binds LAN too (--host) for testing from other machines
```

Open http://localhost:5173 (React Router prints the URL; port differs from Next.js).

## Checks

```bash
npm run typecheck     # react-router typegen + tsc
npm run build
npm run check:map     # map layers: coverage, winding, part grouping, draw-call budget
npm run check:globe   # chart store + prefetch + playback rules, pick geometry, then the browser gate (needs a dev server)
npm run check:player  # playback core with a fake IFrame API and stubbed charts (needs a dev server)
node --experimental-strip-types --no-warnings scripts/diff-check.mjs  # charts differ per country
node scripts/build-world-map.mjs                                       # regenerates the map, then:
node scripts/simplify-map.mjs && npm run check:map
```

`npm run check:globe` is the gate for the country selector and the chart
surface, in three parts. `check:store` and `check:prefetch` run the chart cache
and the hover-prefetch rules with no browser at all: TTL and corruption cases in
the persisted store, and the debounce-on-rest, charted-only, cancel-on-leave,
adopt-on-click rules driven by an injected scheduler. `check:pick` raycasts the
full-land picking geometry with
no browser and checks every source part against an independent point-in-polygon
oracle. The browser half (`scripts/globe-pick-check.mjs`) then proves the runtime
wiring: hover reaches the header, ocean stays silent, pruned islands such as
Hawaii and the Canaries are clickable, shaky clicks fall back to the press
position, drags do not select, and a tap during startup is queued until the scene
is ready. It also calls `/api/charts` over HTTP and asserts the contract (20
songs and 20 videos in one response, cache headers, stale-on-failure, a clear
error with no last good copy, an explicit no-chart payload, no seeded data),
then checks the panel, its provenance line, instant tab switching, error/retry
recovery, and the no-chart notice — including that it renders no chart and that
its action opens the picker filtered to charted countries. A resting hover is
then shown to prefetch, with the click that follows costing no request and no
skeleton, an uncharted hover issuing nothing, a move away aborting the request in
flight, and a drag never being mistaken for a hover. On a phone viewport the chart
is a bottom sheet: the chevron folds it to a peek bar and the peek reopens it,
every selection path unfolds it, a tap on open sky folds it, the peek answers for
loading, the chart week and "no official chart", folding hands focus to the peek
and reopening hands it back, and a wide layout has no fold at all. It then checks
layout coherence: a phone's first paint (with scripting disabled) is already the
settled sheet, the sheet/rail/camera all read one `--sheet-h`, folding re-frames
the globe by half the height it gives back, 768px is a sheet rather than a rail
with the wrong reserve, and the player docks inside the sheet without covering
the list or the rail. Run it after touching `GlobeView.tsx`, `hitLayer.ts`, the map
layers, `api.charts.ts`, `chartPrefetch.ts`, `chartClient.ts`, `useChart.ts`,
`ChartPanel.tsx`, `ChartPeek.tsx`, `_index.tsx`, `app.css`, or anything that
changes polygon altitudes.

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

Three generated files, one pipeline. Never hand-edit any of them.

- `public/world-50m.geojson` — source of truth. Natural Earth 50m with the Kashmir
  dispute patched per the Survey-of-India claim.
- `public/world-50m-simple.geojson` — the render input (61% fewer vertices).
- `public/country-caps.geojson` + `public/country-borders.geojson` — the two
  layers the globe draws. Caps are visual only now: fills, hover and the selection
  ring, pruned to the parts carrying each country's visual mass. Borders keep every
  50m ring merged into a single object and also carry `properties.parts`, which
  groups those rings back into polygons. `app/lib/hitLayer.ts` rebuilds that full
  land set at runtime as one invisible mesh per country for picking, so a part the
  caps pruned — Hawaii, the Canaries, the Azores, Jeju, the Galapagos — is still
  clickable without costing a draw call.

Splitting them is what makes the globe usable. As one map, three-globe built a
Mesh + LineSegments pair for each of ~1650 polygon parts — about **8200 draw calls
per frame and 18fps**. Two layers is ~540 draw calls, and it stays smooth.

```bash
npm run map:layers   # regenerate caps + borders + app/lib/countryMeta.ts
```

## Deploy (Vercel)

No env vars needed. `vercel` / `vercel --prod` from this directory, or import the repo in
the Vercel dashboard. Upstream chart endpoints are unofficial and keyless — the app serves the
last good chart marked stale if they change shape, and never fabricates data.
