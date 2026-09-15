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

/** Virtual id backing the liked-tracks view — never matches a real playlist. */
export const LIKED_PLAYLIST_ID = 0;

/** Header object of the liked-tracks view (no SoundCloud playlist behind it). */
const LIKED_PLAYLIST: Playlist = {
  id: LIKED_PLAYLIST_ID,
  title: "Liked tracks",
  permalink_url: "",
};

/** Whether the open view is the virtual liked-tracks view. */
export function isLikedView(): boolean {
  return getState().route.name === "liked";
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

/**
 * Open the liked-tracks view (route `#/liked`): a virtual playlist backed by
 * `GET /me/likes/tracks`, most recently liked first. Sounds can be dragged
 * into real playlists via the Reorganize sidebar exactly like in a playlist.
 */
export async function openLikedTracks(): Promise<void> {
  resetOrganizeSidebar();
  clearTrackState();
  // Keep the URL in sync without re-triggering route() (replaceState is silent).
  if (window.location.hash !== "#/liked") {
    history.replaceState(null, "", "#/liked");
  }
  setState({ route: { name: "liked", playlistId: null }, currentPlaylist: LIKED_PLAYLIST });
  clearStatus();

  showStatus("Loading liked tracks…");
  try {
    const pager = getState().api!.createLikedTracksPager();
    const firstPage = await pager.next();
    // A faster navigation may have opened another view meanwhile.
    if (getState().currentPlaylist?.id !== LIKED_PLAYLIST_ID) return;
    setState({
      trackPager: pager,
      tracks: firstPage ?? [],
      tracksLoaded: true,
      tracksError: "",
    });
    clearStatus();
  } catch (err) {
    setState({ tracksLoaded: true, tracksError: err.message });
    showStatus(`Could not load liked tracks: ${err.message}`, "error");
  }
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

/**
 * Fetch every remaining page of the playlist's track list (the infinite
 * scroll normally does this on approach). Returns the full track list; the
 * newly fetched pages land in the store, so the rows appear as usual. Used
 * by the batch analyzers (chroma key, BPM).
 */
export async function loadAllTracks(): Promise<Track[]> {
  let state = getState();
  let guard = 0;
  while (state.trackPager && !state.trackPager.done && guard < 100) {
    await loadMoreTracks();
    const after = getState();
    // A page load that failed (or fetched nothing new) must not loop forever.
    if (after.tracksLoadingMore || after.tracksError) break;
    if (after.tracks.length === state.tracks.length) break;
    state = after;
    guard += 1;
  }
  return getState().tracks;
}
