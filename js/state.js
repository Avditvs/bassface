/**
 * Central application state (a single mutable object shared by all modules)
 * plus the small pieces of metadata that travel with it.
 */

import { AppConfig, TokenStore, UserStore } from "./config.js";

/** Display labels for the playlist kinds SoundCloud exposes. */
export const TYPE_LABELS = { playlist: "Playlist", album: "Album", single: "Single" };

export const state = {
  config: AppConfig.load(),
  tokens: TokenStore.load(),
  api: null,
  playlists: [],
  tracks: [],
  tracksLoaded: false,
  tracksError: "",
  trackPager: null,
  tracksLoadingMore: false,
  currentPlaylist: null,
  preview: { trackId: null, playing: false, loading: false, objectUrl: null, mode: "start", blob: null, peakOffset: null, pendingSeekSec: null, originSec: null, jump: null, extending: false },
  waveforms: new Map(), // track id → loudness bars (empty array = unavailable)
  waveformInflight: new Map(), // track id → in-flight waveform load
  playlistsLoading: false,
  page: 1,
  pageSize: 24,
  user: UserStore.load(),
};

/** One-line token summary for the troubleshooting log. */
export function tokenSummary() {
  const t = state.tokens;
  return `at=${t.hasAccessToken()} rt=${t.canRefresh()} fresh=${t.isFresh()}`;
}
