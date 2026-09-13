/**
 * Shared domain types: the subset of the SoundCloud API the app consumes,
 * the internal runtime contracts (pager, preview sources, API context) and
 * the small union types used across modules.
 */

import type { AppConfig, TokenStore } from "./config";

/** Cached `/me` profile fields used by the UI. */
export interface SCUser {
  id?: number;
  username: string;
  avatar_url?: string | null;
}

/** A SoundCloud playlist (as returned by `/me/playlists`, `/playlists/:id`). */
export interface Playlist {
  id: number;
  title?: string;
  kind?: string;
  playlist_type?: string;
  sharing?: string;
  description?: string | null;
  artwork_url?: string | null;
  permalink_url: string;
  track_count?: number;
  likes_count?: number;
  last_modified?: string;
  created_at?: string;
  /** Only present on `GET /playlists/:id?show_tracks=true`. */
  tracks?: Track[];
}

/** A SoundCloud track/sound. */
export interface Track {
  id: number;
  title?: string;
  duration: number;
  artwork_url?: string | null;
  permalink_url: string;
  genre?: string | null;
  user?: { username?: string };
  playback_count?: number;
  likes_count?: number;
  favoritings_count?: number;
  stream_url?: string;
  waveform_url?: string;
  media?: {
    transcodings?: { url?: string; format?: { protocol?: string; mime_type?: string } }[];
  };
}

/** Token endpoint response: raw SoundCloud (snake_case) or internal shape. */
export interface TokenPayload {
  accessToken?: string;
  access_token?: string;
  refreshToken?: string;
  refresh_token?: string;
  expiresIn?: number | string;
  expires_in?: number | string;
}

/** `/tracks/:id/streams` response (all fields optional, probed dynamically). */
export interface Streams {
  hls_mp3_128_url?: string;
  http_mp3_128_url?: string;
  preview_mp3_128_url?: string;
  [key: string]: unknown;
}

/** One HLS mp3 segment with its declared duration (seconds). */
export interface HlsSegment {
  url: string;
  duration: number;
}

/** How a preview source was obtained. */
export type PreviewKind = "full" | "snippet" | "legacy";

/** The two user-facing preview modes. */
export type PreviewMode = "start" | "jump";

/** Streaming bookkeeping for jump previews (more segments stream in later). */
export interface JumpState {
  segments: HlsSegment[];
  /** Fetched blob parts — only on the Blob hot-swap path (empty when streamed). */
  parts: Blob[];
  nextIndex: number;
  lastIndex: number;
  /** True when segments stream into a MediaSource (no blob hot-swap). */
  streamed?: boolean;
  /** Live SourceBuffer/MediaSource of the streamed preview (null on the Blob path). */
  sourceBuffer?: SourceBuffer | null;
  mediaSource?: MediaSource | null;
}

/** A resolved, playable preview source. */
export interface PreviewSource {
  blob?: Blob;
  url: string;
  kind: PreviewKind;
  /** Whether the blob covers the whole track from position 0 (no truncation). */
  complete?: boolean;
  /** Track time (seconds) at which the blob audio begins. */
  originSec?: number;
  /** Seconds into the blob where a jump preview must seek. */
  seekOffset?: number;
  jump?: JumpState;
}

/** On-demand page loader over SoundCloud's `linked_partitioning` pagination. */
export interface TrackPager {
  /** Whether every page has been fetched. */
  readonly done: boolean;
  /** Fetch the next page; resolves to its tracks, or null when done. */
  next(): Promise<Track[] | null>;
}

/** Runtime access to config/tokens, injected into the API client. */
export interface ApiContext {
  getConfig: () => AppConfig;
  getTokens: () => TokenStore;
  updateTokens: (body: TokenPayload) => void;
}

/** The three app screens. */
export type ScreenName = "connect" | "playlists" | "playlist";

/** Playlist list sort orders. */
export type SortKey = "updated" | "name" | "tracks" | "likes";

/** Status bar kinds. */
export type StatusKind = "loading" | "info" | "success" | "error";

/** Preview state of the shared `<audio>` element (see state.js). */
export interface PreviewState {
  trackId: number | null;
  playing: boolean;
  loading: boolean;
  objectUrl: string | null;
  mode: PreviewMode;
  blob: Blob | null;
  pendingSeekSec: number | null;
  originSec: number | null;
  jump: JumpState | null;
  extending: boolean;
}

/** OAuth callback query parameters. */
export interface OAuthCallback {
  code: string | null;
  state: string | null;
  error: string | null;
}
