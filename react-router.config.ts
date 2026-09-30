import type { Config } from "@react-router/dev/config";
import { vercelPreset } from "@vercel/react-router/vite";

// Vercel sets VERCEL=1 at build time: only then do we need the adapter
// preset (it reshapes the server output into functions). Local builds stay
// standard so `npm run start` works with react-router-serve.
export default {
  ssr: true,
  presets: process.env.VERCEL ? [vercelPreset()] : [],
  // Opt into React Router v8 behaviors early so the future-flag warnings
  // stay silent (verified: typecheck + build + live API all green).
  future: {
    v8_middleware: true,
    v8_splitRouteModules: true,
    v8_viteEnvironmentApi: true,
    v8_passThroughRequests: true,
    v8_trailingSlashAwareDataRequests: true,
  },
} satisfies Config;
