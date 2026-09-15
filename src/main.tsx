/**
 * Playlist Updater — entry point.
 * Connects to SoundCloud (OAuth 2.1 + PKCE, all client-side) and lists
 * the authenticated user's playlists.
 *
 * React shell: components/ + services/ (framework-agnostic logic).
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./components/App";
import "./styles/base.css";
import "./styles/layout.css";
import "./styles/forms.css";
import "./styles/components.css";
import "./styles/playlists.css";
import "./styles/playlist-detail.css";
import "./styles/organize.css";
import "./styles/tracks.css";
import "./styles/player-bar.css";
import "./styles/debug.css";

const container = document.getElementById("root");
if (!container) throw new Error("Missing #root element");

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
