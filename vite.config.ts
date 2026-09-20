import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // Relative asset paths: work on Cloudflare (https://bassface.germain-louis-80.workers.dev/)
  // and when served locally from dist/ at any prefix.
  base: "./",
  plugins: [react()],
  build: {
    outDir: "dist",
    sourcemap: false,
  },
});
