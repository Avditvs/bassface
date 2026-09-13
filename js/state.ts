/**
 * Central application state (a single mutable object shared by all modules)
 * plus the small pieces of metadata that travel with it.
 */

import { AppConfig, TokenStore, UserStore } from "./config.js";
import type { SoundCloudApi } from "./api.js";
import type {
  Playlist, PreviewState, SCUser, Track, TrackPager,
} from "./types.js";

/** Display labels for the playlist kinds SoundCloud exposes. */
export const TYPE_LABELS: Record<string, string> = {
  playlist: "Playlist",
  album: "Album",
  single: "Single",
};

/** Shape of the shared mutable state object. */
export interface AppState {
  config: AppConfig;
  tokens: TokenStore;
  api: SoundCloudApi | null;
  playlists: Playlist[];
  tracks: Track[];
  tracksLoaded: boolean;
  tracksError: string;
  trackPager: TrackPager | null;
  tracksLoadingMore: boolean;
  currentPlaylist: Playlist | null;
  preview: PreviewState;
  /** track id → loudness bars (empty array = unavailable) */
  waveforms: Map<number, number[]>;
  /** track id → in-flight waveform load */
  waveformInflight: Map<number, Promise<number[] | undefined>>;
  playlistsLoading: boolean;
  page: number;
  pageSize: number;
  user: SCUser | null;
}

export const state: AppState = {
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
  preview: {
    trackId: null, playing: false, loading: false, objectUrl: null, mode: "start",
    blob: null, peakOffset: null, pendingSeekSec: null, originSec: null, jump: null, extending: false,
  },
  waveforms: new Map(),
  waveformInflight: new Map(),
  playlistsLoading: false,
  page: 1,
  pageSize: 24,
  user: UserStore.load(),
};

/** One-line token summary for the troubleshooting log. */
export function tokenSummary(): string {
  const t = state.tokens;
  return `at=${t.hasAccessToken()} rt=${t.canRefresh()} fresh=${t.isFresh()}`;
}
