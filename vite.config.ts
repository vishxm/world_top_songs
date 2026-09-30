import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [tailwindcss(), reactRouter()],
  // Native tsconfig path resolution (replaces vite-tsconfig-paths):
  // honours the "~/*" alias from tsconfig.json.
  resolve: {
    tsconfigPaths: true,
  },
});
