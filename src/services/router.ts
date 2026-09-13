/**
 * Hash routing: `#/playlists` and `#/playlist/<id>` drive which screen is
 * shown, so browser back/forward keep working. The parsed route lives in the
 * central store; the `App` component reacts to it (see App.tsx).
 */

import { getState, setState } from "./store";
import type { Route } from "./store";
import { openPlaylist, resetPlaylistView } from "./tracks";

/** Parse the current location hash into a route. */
export function parseHash(): Route {
  const match = window.location.hash.match(/^#\/playlist\/(.+)$/);
  if (match) return { name: "playlist", playlistId: decodeURIComponent(match[1]) };
  return { name: "playlists", playlistId: null };
}

/** Re-read the hash into the store and open/reset the playlist view. */
export function route(): void {
  const parsed = parseHash();
  setState({ route: parsed });
  if (!getState().api) return; // not signed in: leave the screen alone

  if (parsed.name === "playlist" && parsed.playlistId) {
    if (String(getState().currentPlaylist?.id) === parsed.playlistId) {
      // Same playlist already open (browser back/forward): state is current.
      return;
    }
    void openPlaylist(parsed.playlistId);
    return;
  }
  resetPlaylistView();
}

/** Navigate back to the playlist list (keeps the hash in sync). */
export function goBackToPlaylists(): void {
  window.location.hash = "#/playlists";
}

/** Navigate to a playlist detail page. */
export function navigateToPlaylist(id: string | number): void {
  window.location.hash = `#/playlist/${id}`;
}
