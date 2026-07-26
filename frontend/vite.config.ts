// PalPilot console build config.
//
// Emits a MULTI-FILE build: `coordinator/index.html` plus hashed chunks under
// `coordinator/assets/`. The coordinator (now a Cloud Run container, see
// coordinator/Dockerfile) serves assets/ immutably and falls back to index.html
// for client-side routes, which is what makes route-level code splitting and
// lazy loading possible — the single-file build could not split at all.
//
// `emptyOutDir: false` is required because outDir points OUTSIDE this package at
// the coordinator/ directory that also holds main.py / requirements.txt; Vite's
// default "empty the whole outDir" would wipe them. Stale hashed assets are
// cleared by the `prebuild` script instead (see package.json).
//
// `base: "/"` because Cloud Run serves the service at the origin root. If it is
// ever mounted under a path prefix, set VITE_BASE and VITE_API_BASE to match.
//
// Build:  cd frontend && npm ci && npm run build
import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  base: process.env.VITE_BASE || "/",
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  build: {
    outDir: "../coordinator",
    emptyOutDir: false,
    assetsDir: "assets",
    sourcemap: false,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        // Split the heavy, rarely-changing libraries out of the app chunk so a
        // console deploy doesn't invalidate ~250kB of vendor code in every cache.
        //
        // Deliberately NO catch-all "vendor" bucket: a catch-all swept up modules
        // that vendor-react depends on, producing `Circular chunk: vendor ->
        // vendor-react -> vendor`. Chunk cycles can break module init order at
        // runtime, so anything not named here is left to Rollup's own grouping.
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (id.includes("recharts") || id.includes("/d3-")) return "vendor-charts";
          if (id.includes("framer-motion")) return "vendor-motion";
          if (id.includes("@radix-ui")) return "vendor-radix";
          if (id.includes("@tanstack")) return "vendor-query";
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return "vendor-react";
          return undefined;
        },
      },
    },
  },
  server: {
    host: "::",
    port: 8080,
    allowedHosts: true,
  },
});
