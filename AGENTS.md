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
