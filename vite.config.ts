import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

// `vite build --mode preview-single` emits one self-contained HTML file (no backend),
// used for quick static previews. Normal builds are a regular SPA for Vercel.
export default defineConfig(({ mode }) => ({
  plugins: [react(), ...(mode === "preview-single" ? [viteSingleFile()] : [])],
  build: mode === "preview-single" ? { outDir: "dist-preview" } : {},
}));
