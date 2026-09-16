import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // GitHub Pages serves the site at https://avditvs.github.io/bassface/,
  // so asset paths must be prefixed with the repo name.
  base: "/bassface/",
  plugins: [react()],
  build: {
    outDir: "dist",
    sourcemap: false,
  },
});
