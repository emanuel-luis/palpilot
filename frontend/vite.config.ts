// PalPilot v3 frontend build config.
//
// Emits ONE self-contained `coordinator/index.html` with every JS/CSS asset
// inlined — the coordinator Cloud Function serves that single file at whatever
// path it's mounted on. `emptyOutDir: false` is required because outDir points
// OUTSIDE this package's root at the coordinator/ directory that also holds
// main.py / requirements.txt — Vite's default "empty the whole outDir" would
// wipe them.
//
// Build:  cd frontend && npm ci && npm run build
// Result: coordinator/index.html is overwritten in place. Nothing else moves.
import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

export default defineConfig({
  base: "./",
  plugins: [react(), viteSingleFile()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  build: {
    outDir: "../coordinator",
    emptyOutDir: false,
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
    chunkSizeWarningLimit: 4000,
  },
  server: {
    port: 5173,
  },
});
