// TEMPORARY: one-file build with the mock backend baked in, for sharing a
// clickable preview. Not part of the deploy pipeline — the real build is
// vite.config.ts (multi-file, served by the coordinator).
import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  plugins: [react()],
  define: { "import.meta.env.VITE_MOCK": JSON.stringify("1") },
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  build: {
    outDir: ".preview",
    emptyOutDir: true,
    cssCodeSplit: false,
    assetsInlineLimit: 100000000,
    rollupOptions: { output: { inlineDynamicImports: true, manualChunks: undefined } },
  },
});
