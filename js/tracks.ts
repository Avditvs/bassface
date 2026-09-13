/**
 * Playlist detail view: open a playlist, page through its tracks and manage
 * the infinite-scroll sentinel that fetches the next page on approach.
 */

import { dbg } from "./debug.js";
import { state } from "./state.js";
import { showScreen, showStatus, clearStatus } from "./screens.js";
import { stopPreview } from "./preview.js";
import { renderPlaylistHeader, renderTrackList } from "./render.js";
import { renderOrganizeSidebar, resetOrganizeSidebar } from "./organize.js";
import { el } from "./util.js";

let trackSentinelObserver: IntersectionObserver | null = null;

/** The playlist id encoded in the URL hash, or null when no playlist is open. */
export function playlistIdFromHash(): string | null {
  const match = window.location.hash.match(/^#\/playlist\/(.+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

/** Open a playlist (by numeric id) and fetch + render its tracks. */
export async function openPlaylist(id: string | number): Promise<void> {
  const playlist = state.playlists.find((p) => String(p.id) === String(id));
  if (!playlist) {
    showStatus("That playlist is no longer in your list.", "error");
    history.replaceState(null, "", window.location.pathname);
    showScreen("playlists");
    return;
  }

  state.currentPlaylist = playlist;
  state.tracks = [];
  state.tracksLoaded = false;
  state.tracksError = "";
  state.trackPager = null;
  state.tracksLoadingMore = false;
  stopPreview();
  forgetTrackSentinel();
  // Keep the URL in sync without re-triggering route() (replaceState is silent).
  if (playlistIdFromHash() !== String(id)) {
    history.replaceState(null, "", `#/playlist/${id}`);
  }

  showScreen("playlist");
  el("remove-zone").hidden = false;
  renderPlaylistHeader();
  renderTrackList();
  renderOrganizeSidebar();
  clearStatus();

  showStatus("Loading tracks…");
  try {
    const pager = state.api!.createPlaylistTracksPager(id);
    const firstPage = await pager.next();
    // A faster navigation may have opened another playlist meanwhile.
    if (String(state.currentPlaylist?.id) !== String(id)) return;
    state.trackPager = pager;
    state.tracks = firstPage ?? [];
    state.tracksLoaded = true;
    clearStatus();
  } catch (err) {
    state.tracksLoaded = true;
    state.tracksError = err.message;
    showStatus(`Could not load the track list: ${err.message}`, "error");
  }
  renderTrackList();
}

/** Clear the track view (leaving the playlist screen / navigating away). */
export function resetPlaylistView(): void {
  stopPreview();
  forgetTrackSentinel();
  resetOrganizeSidebar();
  el("remove-zone").hidden = true;
  state.currentPlaylist = null;
  state.tracks = [];
  state.tracksLoaded = false;
  state.tracksError = "";
  state.trackPager = null;
  state.tracksLoadingMore = false;
}

/** Fetch the next track page and append it to the rendered list. */
async function loadMoreTracks(): Promise<void> {
  const pager = state.trackPager;
  if (!pager || pager.done || state.tracksLoadingMore || state.tracksError) return;
  state.tracksLoadingMore = true;
  try {
    const batch = await pager.next();
    if (batch) state.tracks.push(...batch);
  } catch (err) {
    dbg(`[tracks] load-more failed: ${err.message}`);
    showStatus(`Could not load more tracks: ${err.message}`, "error");
  } finally {
    state.tracksLoadingMore = false;
  }
  renderTrackList();
}

/** Watch the sentinel row at the end of the list; fetches when it nears view. */
export function observeTrackSentinel(): void {
  const sentinel = document.getElementById("track-sentinel");
  if (!sentinel) return;
  if (!trackSentinelObserver) {
    trackSentinelObserver = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loadMoreTracks();
      },
      { rootMargin: "600px 0px" }, // start fetching before the user arrives
    );
  }
  trackSentinelObserver.disconnect();
  trackSentinelObserver.observe(sentinel);
}

/** Drop the sentinel observer (leaving a playlist / clearing the view). */
export function forgetTrackSentinel(): void {
  trackSentinelObserver?.disconnect();
}
