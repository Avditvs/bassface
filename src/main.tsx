/**
 * Bassface — entry point.
 * Connects to SoundCloud (OAuth 2.1 + PKCE, all client-side) and lists
 * the authenticated user's playlists.
 *
 * React shell: components/ + services/ (framework-agnostic logic).
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./components/App";
import { loadLocalConfig } from "./services/local-config";
import { runtime } from "./services/store";
import { initTheme } from "./services/theme";
import "./styles/base.css";
import "./styles/layout.css";
import "./styles/forms.css";
import "./styles/components.css";
import "./styles/playlists.css";
import "./styles/playlist-detail.css";
import "./styles/organize.css";
import "./styles/tracks.css";
import "./styles/player-bar.css";
import "./styles/home.css";
import "./styles/discover.css";
import "./styles/toasts.css";

const container = document.getElementById("root");
if (!container) throw new Error("Missing #root element");

// Pick dark/light before first paint to avoid a theme flash on load.
initTheme();

// The local dev config file must be applied before any OAuth/session logic
// reads runtime.config (fetch is a no-op off a loopback origin).
await loadLocalConfig(runtime.config);

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
