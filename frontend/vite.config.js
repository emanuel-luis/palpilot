// PalPilot v2 frontend build config.
//
// This app is built once and the OUTPUT IS THE PRODUCT: a single, self-contained
// `coordinator/index.html` with all JS/CSS inlined (no separate asset files), so
// the coordinator Cloud Function can keep serving one static file exactly like it
// does today. `vite-plugin-singlefile` does the inlining; we just point `outDir`
// one level up from this package (`coordinator/frontend/` -> `coordinator/`) so
// the emitted `index.html` lands directly where `coordinator/main.py` reads it
// from, overwriting the previous build in place.
//
// `emptyOutDir: false` is required: outDir resolves OUTSIDE this package's root,
// and `coordinator/` holds files this build must never touch (main.py, main.tf
// references, requirements.txt, etc.) — Vite's default "empty the whole outDir"
// behavior would delete them.
//
// Build command (run from coordinator/frontend/):
//   npm ci
//   npm run build
// Result: coordinator/index.html is overwritten with the fresh single-file build.
// Nothing else in coordinator/ is touched. Nothing is deployed by this step —
// `terraform apply` (or the operator's normal coordinator deploy) picks it up
// like any other coordinator source change.
import { fileURLToPath, URL } from "node:url";

import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

export default defineConfig({
  plugins: [vue(), viteSingleFile()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  build: {
    // frontend/ lives OUTSIDE coordinator/ so the Cloud Function zip never sees
    // node_modules/source; the single-file build is emitted into coordinator/.
    outDir: "../coordinator",
    emptyOutDir: false,
    assetsInlineLimit: Number.POSITIVE_INFINITY,
    cssCodeSplit: false,
    chunkSizeWarningLimit: 4000,
  },
});
