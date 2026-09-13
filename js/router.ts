/**
 * Hash routing: `#/playlists` and `#/playlist/<id>` drive which screen is
 * shown, so browser back/forward keep working without a framework.
 */

import { state } from "./state.js";
import { showScreen } from "./screens.js";
import { openPlaylist, resetPlaylistView, playlistIdFromHash } from "./tracks.js";
import { renderPlaylist } from "./render.js";

/** Decide which content to show from the current URL hash. */
export function route(): void {
  if (!state.api) return; // not signed in: leave the screen alone
  const id = playlistIdFromHash();
  if (id) {
    if (String(state.currentPlaylist?.id) === id) {
      // Same playlist already open (browser back/forward): redraw from state.
      renderPlaylist();
    } else {
      void openPlaylist(id);
    }
    return;
  }
  resetPlaylistView();
  showScreen("playlists");
}

/** Navigate back to the playlist list (keeps the hash in sync). */
export function goBackToPlaylists(): void {
  window.location.hash = "#/playlists";
}
