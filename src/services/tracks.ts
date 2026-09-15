/**
 * Playlist detail view: open a playlist, page through its tracks and manage
 * the infinite-scroll sentinel that fetches the next page on approach.
 * Rendering is React's job; this module only updates the store.
 */

import { dbg } from "./debug";
import { clearStatus, getState, setState, showStatus } from "./store";
import { resetOrganizeSidebar } from "./organize";
import type { Playlist, Track } from "../services/types";

/** The playlist id encoded in the URL hash, or null when no playlist is open. */
export function playlistIdFromHash(): string | null {
  const match = window.location.hash.match(/^#\/playlist\/(.+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

/** Replace the track list state wholesale (e.g. after an undo snapshot). */
export function replaceTracks(tracks: Track[], currentPlaylist: Playlist): void {
  setState({
    tracks,
    tracksLoaded: true,
    tracksError: "",
    currentPlaylist,
    trackPager: {
      done: true,
      next: () => Promise.resolve(null),
    },
  });
}

/** Reset the track-view state fields (shared by open/reset paths). */
function clearTrackState(): void {
  setState({
    tracks: [],
    tracksLoaded: false,
    tracksError: "",
    trackPager: null,
    tracksLoadingMore: false,
  });
}

/** Open a playlist (by numeric id) and fetch its tracks. */
export async function openPlaylist(id: string | number): Promise<void> {
  const playlist = getState().playlists.find((p) => String(p.id) === String(id));
  if (!playlist) {
    showStatus("That playlist is no longer in your list.", "error");
    history.replaceState(null, "", window.location.pathname);
    setState({ route: { name: "playlists", playlistId: null } });
    return;
  }

  // Playback continues across navigation: the shared audio element and the
  // active track live at the shell level (see App.tsx / PlayerBar).
  resetOrganizeSidebar();
  clearTrackState();
  // Keep the URL in sync without re-triggering route() (replaceState is silent).
  if (playlistIdFromHash() !== String(id)) {
    history.replaceState(null, "", `#/playlist/${id}`);
  }
  setState({ route: { name: "playlist", playlistId: String(id) }, currentPlaylist: playlist });
  clearStatus();

  showStatus("Loading tracks…");
  try {
    const pager = getState().api!.createPlaylistTracksPager(id);
    const firstPage = await pager.next();
    // A faster navigation may have opened another playlist meanwhile.
    if (String(getState().currentPlaylist?.id) !== String(id)) return;
    setState({
      trackPager: pager,
      tracks: firstPage ?? [],
      tracksLoaded: true,
      tracksError: "",
    });
    clearStatus();
  } catch (err) {
    setState({ tracksLoaded: true, tracksError: err.message });
    showStatus(`Could not load the track list: ${err.message}`, "error");
  }
}

/** Clear the track view (leaving the playlist screen / navigating away). */
export function resetPlaylistView(): void {
  resetOrganizeSidebar();
  setState({
    currentPlaylist: null,
    route: { name: "playlists", playlistId: null },
  });
  clearTrackState();
}

/** Fetch the next track page and append it to the rendered list. */
export async function loadMoreTracks(): Promise<void> {
  const state = getState();
  const pager = state.trackPager;
  if (!pager || pager.done || state.tracksLoadingMore || state.tracksError) return;
  setState({ tracksLoadingMore: true });
  try {
    const batch = await pager.next();
    if (batch) setState({ tracks: [...getState().tracks, ...batch] });
  } catch (err) {
    dbg(`[tracks] load-more failed: ${err.message}`);
    showStatus(`Could not load more tracks: ${err.message}`, "error");
  } finally {
    setState({ tracksLoadingMore: false });
  }
}
