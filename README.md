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
npm run typecheck  # react-router typegen + tsc
npm run build
node --experimental-strip-types --no-warnings scripts/diff-check.mjs  # charts differ per country
node scripts/build-world-map.mjs                                       # regenerates the map, then:
node scripts/simplify-map.mjs && node scripts/map-check.mjs && node scripts/tri-check.mjs
```

## Deploy (Vercel)

No env vars needed. `vercel` / `vercel --prod` from this directory, or import the repo in
the Vercel dashboard. Upstream chart endpoints are unofficial and keyless — the app degrades
gracefully (stale cache → seeds) if they change shape.
