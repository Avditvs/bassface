/**
 * Central application state.
 *
 * UI-driven data lives in an immutable snapshot consumed by React via
 * `useSyncExternalStore` (`useApp()`). Non-UI resources (persisted config,
 * tokens, waveform caches) stay in a plain mutable `runtime` object — they
 * never trigger renders directly.
 */

import { useSyncExternalStore } from "react";
import { AppConfig, TokenStore, UserStore } from "./config";
import type { SoundCloudApi } from "./api";
import type {
  ChromaAnalysis, Playlist, PreviewMode, SCUser, StatusKind, Track, TrackPager,
} from "../services/types";

/** Display labels for the playlist kinds SoundCloud exposes. */
export const TYPE_LABELS: Record<string, string> = {
  playlist: "Playlist",
  album: "Album",
  single: "Single",
};

/** The parsed location hash (see router.ts). */
export interface Route {
  name: "playlists" | "playlist";
  playlistId: string | null;
}

/** Status-bar message. */
export interface Status {
  kind: StatusKind;
  message: string;
}

/** Immutable UI state snapshot — replaces the old mutable `state.playlists`-style fields. */
export interface AppState {
  route: Route;
  status: Status | null;
  /** API client (null until signed in). */
  api: SoundCloudApi | null;
  user: SCUser | null;
  playlists: Playlist[];
  playlistsLoading: boolean;
  /** Playlist currently open (detail screen). */
  currentPlaylist: Playlist | null;
  tracks: Track[];
  tracksLoaded: boolean;
  tracksError: string;
  trackPager: TrackPager | null;
  tracksLoadingMore: boolean;
  /** Active preview — the identity fields that drive the track-row UI. */
  previewTrackId: number | null;
  previewPlaying: boolean;
  previewLoading: boolean;
  previewMode: PreviewMode;
  /** Most recent reversible organize action (toolbar Revert button). */
  undoEntry: { label: string } | null;
  /** track id → estimated key label ("Am", "C#", …) shown on the track row. */
  chromaKeys: Record<number, string>;
  /** Track whose chroma analysis is currently running. */
  chromaLoadingTrackId: number | null;
}

let state: AppState = {
  route: { name: "playlists", playlistId: null },
  status: null,
  api: null,
  user: UserStore.load(),
  playlists: [],
  playlistsLoading: false,
  currentPlaylist: null,
  tracks: [],
  tracksLoaded: false,
  tracksError: "",
  trackPager: null,
  tracksLoadingMore: false,
  previewTrackId: null,
  previewPlaying: false,
  previewLoading: false,
  previewMode: "start",
  undoEntry: null,
  chromaKeys: {},
  chromaLoadingTrackId: null,
};

const listeners = new Set<() => void>();

/** Current state snapshot (referentially stable between updates). */
export function getState(): AppState {
  return state;
}

/** Subscribe to state changes (React `useSyncExternalStore` compatible). */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** React hook: the whole app state snapshot. */
export function useApp(): AppState {
  return useSyncExternalStore(subscribe, getState);
}

/** Shallow-merge a patch into the state and notify the subscribers. */
export function setState(patch: Partial<AppState>): void {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
}

/**
 * Non-reactive resources: persisted credentials/tokens, the waveform cache
 * and the track-paging bookkeeping that never needs to re-render anything.
 */
export const runtime = {
  config: AppConfig.load(),
  tokens: TokenStore.load(),
  /** track id → loudness bars (empty array = unavailable) */
  waveforms: new Map<number, number[]>(),
  /** track id → in-flight waveform load */
  waveformInflight: new Map<number, Promise<number[] | undefined>>(),
  /** track id → chroma analysis (1–2 HLS segments, see services/chroma.ts) */
  chromas: new Map<number, ChromaAnalysis>(),
  /** track id → in-flight chroma analysis */
  chromaInflight: new Map<number, Promise<ChromaAnalysis>>(),
};

/** One-line token summary for the troubleshooting log. */
export function tokenSummary(): string {
  const t = runtime.tokens;
  return `at=${t.hasAccessToken()} rt=${t.canRefresh()} fresh=${t.isFresh()}`;
}

// --- Status bar (formerly screens.ts) ---------------------------------------

/** Show the message bar above the content; spinner while `kind` is loading. */
export function showStatus(message: string, kind: StatusKind = "loading"): void {
  setState({ status: { kind, message } });
}

export function clearStatus(): void {
  setState({ status: null });
}
