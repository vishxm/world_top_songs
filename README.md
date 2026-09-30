# World Top Songs — Remix + Vite + react-globe.gl

Spin a 3D globe, click any country, and play its current Top 10. No accounts, no API keys, no billing.

## Stack

- **React Router 7** (framework mode, formerly Remix) + **Vite 8** + **React 19**
- **react-globe.gl** globe, client-only via `lazy()` + mount guard (never imported during SSR)
- **Tailwind CSS v4** via `@tailwindcss/vite`
- **Vercel** preset (`@vercel/react-router/vite`) — zero-config deploy

## How it works

- **Globe** (`app/routes/_index.tsx` + `app/components/`): rotate / zoom / click any country.
  Search box doubles as a precise picker; 🎲 Surprise me jumps somewhere random.
- **Charts** (`GET /api/charts?country=XX&type=songs|videos`, `app/routes/api.charts.ts`):
  - 69 chart countries → official **YouTube weekly Top Songs + Top Videos** (rank movement,
    weekly plays, exact chart week), keyless via charts.youtube.com's own web-client API.
  - Other countries → **Spotify Weekly** (kworb aggregation) resolved to playable YouTube
    videos via keyless YouTube Music search (low-confidence matches skipped, never guessed).
  - Last resort → Global chart / baked-in seeds. Every response labels its
    `provider` (`youtube`/`spotify`) and `source` (`live`/`stale`/`seed`).
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
npm run check:map     # map layers: coverage, winding, no invented geometry, draw-call budget
npm run check:globe   # hover regression + draw calls (needs a dev server running)
node --experimental-strip-types --no-warnings scripts/diff-check.mjs  # charts differ per country
node scripts/build-world-map.mjs                                       # regenerates the map, then:
node scripts/simplify-map.mjs && npm run check:map
```

`npm run check:globe` is the gate for the country selector. It raycasts the globe
itself, then hovers every pixel it finds on a country cap and asserts the app
reports the same country. Run it after touching `GlobeView.tsx`, the map layers,
or anything that changes polygon altitudes.

## Map data

Three generated files, one pipeline. Never hand-edit any of them.

- `public/world-50m.geojson` — source of truth. Natural Earth 50m with the Kashmir
  dispute patched per the Survey-of-India claim.
- `public/world-50m-simple.geojson` — the render input (61% fewer vertices).
- `public/country-caps.geojson` + `public/country-borders.geojson` — the two
  layers the globe actually draws. Caps carry interaction and fills and are pruned
  to the parts carrying each country's visual mass; borders keep every 50m ring
  merged into a single object.

Splitting them is what makes the globe usable. As one map, three-globe built a
Mesh + LineSegments pair for each of ~1650 polygon parts — about **8200 draw calls
per frame and 18fps**. Two layers is ~540 draw calls, and it stays smooth.

```bash
npm run map:layers   # regenerate caps + borders + app/lib/countryMeta.ts
```

## Deploy (Vercel)

No env vars needed. `vercel` / `vercel --prod` from this directory, or import the repo in
the Vercel dashboard. Upstream chart endpoints are unofficial and keyless — the app degrades
gracefully (stale cache → seeds) if they change shape.
