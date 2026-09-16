import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // Relative asset paths: work on GitHub Pages (https://avditvs.github.io/
  // bassface/) and when served locally from dist/ at any prefix.
  base: "./",
  plugins: [react()],
  build: {
    outDir: "dist",
    sourcemap: false,
  },
});
