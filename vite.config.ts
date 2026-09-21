import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// Canonical public URL — single source of truth for social-preview meta tags
// (og:url / og:image need absolute URLs; see index.html %SITE_URL% usage).
const SITE_URL = "https://bassface.louis-germain.fr";

/** Replace %SITE_URL% placeholders in index.html (applies in dev and build). */
function siteUrl(): Plugin {
  return {
    name: "site-url",
    transformIndexHtml(html) {
      return html.replaceAll("%SITE_URL%", SITE_URL);
    },
  };
}

export default defineConfig({
  // Relative asset paths: work on Cloudflare (https://bassface.louis-germain.fr)
  // and when served locally from dist/ at any prefix.
  base: "./",
  plugins: [react(), siteUrl()],
  build: {
    outDir: "dist",
    sourcemap: false,
  },
});
