/**
 * Screen switching and the shared status bar.
 */

import { escapeHtml } from "./util.js";

const screens = {
  connect: document.getElementById("connect-screen"),
  playlists: document.getElementById("playlists-screen"),
  playlist: document.getElementById("playlist-screen"),
};

/** Show exactly one of the three app screens (`connect`|`playlists`|`playlist`). */
export function showScreen(name) {
  for (const screenKey of Object.keys(screens)) {
    screens[screenKey].hidden = screenKey !== name;
  }
}

/** Message bar above the content: a spinner while loading, colour by kind. */
export function showStatus(message, kind = "loading") {
  const bar = document.getElementById("status-bar");
  bar.hidden = false;
  bar.className = kind ? `status-bar ${kind}` : "status-bar";
  bar.innerHTML = kind === "loading"
    ? `<span class="spinner" aria-hidden="true"></span>${escapeHtml(message)}`
    : escapeHtml(message);
}

export function clearStatus() {
  document.getElementById("status-bar").hidden = true;
}
