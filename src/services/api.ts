/**
 * Thin SoundCloud API client for browser use.
 * Uses the `Authorization: OAuth <token>` header and transparently
 * refreshes the access token once when a request comes back 401.
 * @see https://developers.soundcloud.com/docs/api/guide
 */

import { API_BASE_URL, refreshAccessToken } from "./oauth";
import { redactSecrets } from "./util";
import type {
  ApiContext, HlsSegment, Playlist, PreviewKind, PreviewSource, SCUser,
  Streams, Track,
} from "../services/types";

/** Upper bound on HLS segments concatenated into one preview blob (~10–20 min). */
const HLS_MAX_SEGMENTS = 120;

/**
 * Whether a failed response is SoundCloud's rate limit (HTTP 429, or the
 * legacy 403 body they sometimes send when the quota is exhausted).
 */
function isRateLimit(status: number, body: string): boolean {
  return status === 429 || /rate limit/i.test(body);
}

/** Build a clear, actionable error for a rate-limited response. */
function rateLimitError(response: Response): Error {
  const retryAfter = Number(response.headers.get("retry-after"));
  const wait = Number.isFinite(retryAfter) && retryAfter > 0
    ? ` Try again in about ${retryAfter} second${retryAfter === 1 ? "" : "s"}.`
    : " Wait a few minutes before retrying.";
  return new Error(`SoundCloud rate limit exceeded — you sent too many requests.${wait}`);
}

/** Hard cap on a single API request: a stalled connection must never leave a
 *  spinner running forever (a pending fetch otherwise never settles). */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Whether the OAuth `Authorization` header may be sent to this URL. Tokens
 * are only ever attached for SoundCloud-controlled hosts: anything coming
 * back from API/HLS responses pointing elsewhere is treated as untrusted so
 * a compromised/misconfigured stream URL cannot leak the bearer token.
 */
function isTokenSafeUrl(url: string | URL): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "soundcloud.com"
      || host.endsWith(".soundcloud.com")
      || host.endsWith(".sndcdn.com");
  } catch {
    return false;
  }
}

export class SoundCloudApi {
  /** Optional sink for request-level diagnostics (wired to the app's log). */
  static logger: ((message: string) => void) | null = null;

  private ctx: ApiContext;

  constructor(ctx: ApiContext) {
    this.ctx = ctx;
  }

  async request(path: string, { retried = false, method = "GET", body = null }: { retried?: boolean; method?: string; body?: unknown } = {}): Promise<any> {
    const url = new URL(path.startsWith("http") ? path : `${API_BASE_URL}${path}`);
    // Fresh cache-buster per attempt: keeps the 401-retry from being served
    // CloudFront's cached error response instead of the re-issued request.
    url.searchParams.set("ts", String(Date.now()));
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          accept: "application/json; charset=utf-8",
          ...(body !== null ? { "content-type": "application/json" } : {}),
          authorization: `OAuth ${this.ctx.getTokens().accessToken}`,
        },
        body: body !== null ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      if (err.name === "TimeoutError" || err.name === "AbortError") {
        throw new Error(`SoundCloud API request timed out after ${REQUEST_TIMEOUT_MS / 1000} s: ${url.pathname}`);
      }
      throw err;
    }
    SoundCloudApi.logger?.(`[api] ${response.status} ${url}`);

    if (response.status === 401 && !retried && this.ctx.getTokens().canRefresh()) {
      await this.refreshOnce();
      return this.request(path, { retried: true, method, body });
    }
    if (!response.ok) {
      const body = await response.text();
      SoundCloudApi.logger?.(`[api] ${response.status} body: ${body.slice(0, 400)}`);
      if (isRateLimit(response.status, body)) throw rateLimitError(response);
      throw new Error(`SoundCloud API error (${response.status}): ${body}`);
    }
    return response.json();
  }

  /** Refresh the stored token once, then retry the failed request. */
  async refreshOnce(): Promise<void> {
    const body = await refreshAccessToken({ refreshToken: this.ctx.getTokens().refreshToken, config: this.ctx.getConfig() });
    this.ctx.updateTokens(body);
  }

  /** The authenticated user's profile. */
  async me(): Promise<SCUser> {
    return this.request("/me");
  }

  /**
   * All playlists of the authenticated user, following SoundCloud's
   * `linked_partitioning` pagination via `next_href`.
   */
  async myPlaylists(): Promise<Playlist[]> {
    const playlists: Playlist[] = [];
    let href: string | null = `${API_BASE_URL}/me/playlists?show_tracks=false&linked_partitioning=true&limit=50`;
    while (href) {
      const page = await this.request(href);
      playlists.push(...(page.collection ?? []));
      if (!page.next_href || page.next_href === href) break;
      href = page.next_href;
    }
    return playlists;
  }

  /**
   * Create a new, empty playlist with the given title. Same root `playlist`
   * wrapping as the PUT in `updatePlaylistTracks`. Returns the new playlist.
   */
  async createPlaylist(title: string): Promise<Playlist> {
    return this.request("/playlists", {
      method: "POST",
      body: { playlist: { title, tracks: [] } },
    });
  }

  /**
   * One playlist, with its tracks (needed to edit the track list: the PUT
   * endpoint replaces the whole list, so callers must read before writing).
   */
  async getPlaylist(id: number | string): Promise<Playlist> {
    return this.request(`/playlists/${encodeURIComponent(id)}?show_tracks=true`);
  }

  /**
   * Replace a playlist's track list with the given track ids. SoundCloud's
   * `PUT /playlists/:id` overwrites the whole list, hence the read-modify-write
   * pattern in the callers. Per the OpenAPI spec the JSON body is wrapped in a
   * root `playlist` object and each track is identified by its urn
   * (`soundcloud:tracks:<id>`). Returns the updated playlist.
   */
  async updatePlaylistTracks(id: number | string, trackIds: number[]): Promise<Playlist> {
    return this.request(`/playlists/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: {
        playlist: {
          tracks: trackIds.map((trackId) => ({ urn: `soundcloud:tracks:${trackId}` })),
        },
      },
    });
  }

  /**
   * On-demand page loader for the sounds inside one playlist (SoundCloud's
   * `linked_partitioning` pagination): `next()` fetches one page and returns
   * its tracks (null once the end is reached, `done` reports that state).
   * Lets the UI load the first page immediately and the rest while scrolling.
   * @see https://developers.soundcloud.com/docs/api/guide#listen
   */
  createPlaylistTracksPager(id: number | string, { pageSize = 50 }: { pageSize?: number } = {}): TrackPagerLike {
    const api = this; // the pager object itself has no request()
    let href: string | null = `${API_BASE_URL}/playlists/${encodeURIComponent(id)}/tracks?linked_partitioning=true&limit=${pageSize}`;
    return {
      /** Whether every page has been fetched. */
      get done(): boolean {
        return href === null;
      },
      /** Fetch the next page; resolves to its tracks, or null when done. */
      async next(): Promise<Track[] | null> {
        if (href === null) return null;
        const current: string = href;
        const page = await api.request(current);
        href = page.next_href && page.next_href !== current ? page.next_href : null;
        return page.collection ?? [];
      },
    };
  }

  /**
   * Resolve + download a playable preview source for a track. Priority
   * depends on the requested mode:
   *   mode "start" (simple play button — quick to load):
   *     1. SoundCloud's ~30 s snippet (`preview_mp3_128_url`),
   *     2. full-length mp3 via the HLS playlist (`hls_mp3_128_url`),
   *     3. full-length mp3 (`http_mp3_128_url`),
   *     4. legacy `stream_url` / progressive transcoding URL.
   *   mode "full" (needs the whole track, e.g. a waveform jump) —
   *   HLS preferred over the direct progressive mp3:
   *     1. full-length mp3 via the HLS playlist (`hls_mp3_128_url`) — segments
   *        are fetched with auth and concatenated into one Blob,
   *     2. full-length mp3 from `/tracks/:id/streams` (`http_mp3_128_url`),
   *     3. SoundCloud's ~30 s snippet (`preview_mp3_128_url`) — the caller
   *        then plays from 0 (not the requested position),
   *     4. legacy `stream_url` / first progressive transcoding URL (no Blob —
   *        played directly, may fail when it still requires auth).
   *
   * Every `/streams` URL lives on api.soundcloud.com and still requires the
   * `Authorization: OAuth` header, so it cannot be handed to a bare
   * `<audio src>` — hence the Blob downloads.
   *
   * Returns `{ blob, url, kind }` (`kind`: "full" | "snippet" | "legacy") or
   * null when no progressive stream is exposed (e.g. HLS-AAC-only tracks).
   */
  async previewSource(
    track: Track,
    { mode = "start", onRaw = null, onError = null }: {
      mode?: "start" | "full";
      onRaw?: ((streams: Streams) => void) | null;
      onError?: ((err: unknown) => void) | null;
    } = {},
  ): Promise<PreviewSource | null> {
    try {
      const streams: Streams = await this.request(`/tracks/${encodeURIComponent(track.id)}/streams`);
      if (onRaw) onRaw(streams);
      const candidates: [keyof Streams, PreviewKind, boolean][] = mode === "full"
        ? [
            ["hls_mp3_128_url", "full", false],
            ["http_mp3_128_url", "full", true],
            ["preview_mp3_128_url", "snippet", true],
          ]
        : [
            ["preview_mp3_128_url", "snippet", true],
            ["hls_mp3_128_url", "full", false],
            ["http_mp3_128_url", "full", true],
          ];
      for (const [key, kind, direct] of candidates) {
        const value = streams[key];
        if (typeof value !== "string" || !value.trim()) continue;
        const url = value.trim();
        try {
          if (direct) {
            const blob = await this.fetchAudioBlob(url);
            // A direct mp3 (or the untruncated HLS playlist, below) is the
            // whole track, so a jump preview can simply seek inside the Blob.
            return { blob, url, kind, complete: kind === "full" };
          }
          const { blob, complete } = await this.fetchHls(url);
          return { blob, url, kind, complete: kind === "full" && complete };
        } catch (err) {
          SoundCloudApi.logger?.(`[api] ${String(key)} download failed: ${err.message}`);
        }
      }
      return null; // no progressive variant offered (incl. HLS-AAC-only tracks)
    } catch (err) {
      if (onError) onError(err);
      /* fall through to the embedded stream_url / transcoding approach */
    }

    if (typeof track.stream_url === "string" && track.stream_url.trim()) {
      return { url: track.stream_url.trim(), kind: "legacy" };
    }

    const transcoding = (track.media?.transcodings ?? []).find(
      (entry) => entry.format?.protocol === "progressive",
    );
    if (!transcoding?.url) return null;

    const response = await this.fetchAuthed(transcoding.url);
    if (!response.ok) {
      throw new Error(`SoundCloud stream error (${response.status})`);
    }
    return { url: response.url, kind: "legacy" };
  }

  /**
   * Fetch a URL with the current bearer token (redirects followed),
   * refreshing the token once when the request comes back 401. The header is
   * only attached when the URL points at a SoundCloud-controlled host — see
   * {@link isTokenSafeUrl}.
   */
  async fetchAuthed(url: string): Promise<Response> {
    if (!isTokenSafeUrl(url)) {
      SoundCloudApi.logger?.(`[api] refusing to send OAuth token to non-SoundCloud host: ${redactSecrets(url)}`);
      throw new Error("Refusing to send the OAuth token to a non-SoundCloud host");
    }
    let response = await fetch(url, {
      headers: {
        authorization: `OAuth ${this.ctx.getTokens().accessToken}`,
      },
    });
    if (response.status === 401 && this.ctx.getTokens().canRefresh()) {
      await this.refreshOnce();
      response = await fetch(url, {
        headers: {
          authorization: `OAuth ${this.ctx.getTokens().accessToken}`,
        },
      });
    }
    return response;
  }

  /**
   * Download an authenticated audio URL into a Blob so it can be played in
   * a bare `<audio>` element via an object URL.
   */
  async fetchAudioBlob(url: string): Promise<Blob> {
    const response = await this.fetchAuthed(url);
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      SoundCloudApi.logger?.(`[api] stream ${response.status} body: ${body.slice(0, 400)}`);
      throw new Error(`SoundCloud stream error (${response.status})`);
    }
    return response.blob();
  }

  /**
   * Download an HLS mp3 playlist and return its audio as one playable Blob.
   * Playlists longer than {@link HLS_MAX_SEGMENTS} are truncated to segments
   * taken from the middle, keeping the download bounded — `complete` reports
   * whether the Blob covers the whole track from position 0.
   */
  async fetchHls(m3u8Url: string): Promise<{ blob: Blob; complete: boolean }> {
    const response = await this.fetchAuthed(m3u8Url);
    if (!response.ok) {
      throw new Error(`SoundCloud HLS error (${response.status})`);
    }
    const base = new URL(response.url || m3u8Url);
    const segments = (await response.text())
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
    if (segments.length === 0) {
      throw new Error("HLS playlist contained no segments");
    }
    const chosen = segments.length <= HLS_MAX_SEGMENTS
      ? segments
      : segments.slice(
          Math.floor((segments.length - HLS_MAX_SEGMENTS) / 2),
          Math.floor((segments.length - HLS_MAX_SEGMENTS) / 2) + HLS_MAX_SEGMENTS,
        );
    const complete = chosen.length === segments.length;
    SoundCloudApi.logger?.(`[api] hls: using ${chosen.length}/${segments.length} segments`);
    const parts: Blob[] = [];
    for (const segment of chosen) {
      parts.push(await this.fetchAudioBlob(new URL(segment, base).toString()));
    }
    return { blob: new Blob(parts, { type: "audio/mpeg" }), complete };
  }

  /**
   * Segment list of the track's HLS mp3 playlist: `[{url, duration}]`, in
   * order (cumulative start times follow from the durations). Returns null
   * when the track exposes no `hls_mp3_128_url` — callers fall back to the
   * progressive sources.
   */
  async hlsSegments(
    track: Track,
    { onRaw = null, onError = null }: {
      onRaw?: ((streams: Streams) => void) | null;
      onError?: ((err: unknown) => void) | null;
    } = {},
  ): Promise<HlsSegment[] | null> {
    let streams: Streams;
    try {
      streams = await this.request(`/tracks/${encodeURIComponent(track.id)}/streams`);
      if (onRaw) onRaw(streams);
    } catch (err) {
      if (onError) onError(err);
      return null;
    }
    const m3u8 = streams.hls_mp3_128_url;
    if (typeof m3u8 !== "string" || !m3u8.trim()) return null;
    const response = await this.fetchAuthed(m3u8.trim());
    if (!response.ok) {
      throw new Error(`SoundCloud HLS error (${response.status})`);
    }
    const base = new URL(response.url || m3u8);
    const segments: HlsSegment[] = [];
    let duration: number | null = null;
    for (const line of (await response.text()).split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("#EXTINF:")) {
        duration = Number.parseFloat(trimmed.slice(8)) || 0;
      } else if (trimmed && !trimmed.startsWith("#")) {
        segments.push({ url: new URL(trimmed, base).toString(), duration: duration ?? 0 });
        duration = null;
      }
    }
    return segments.length > 0 ? segments : null;
  }

  /** One HLS segment, authenticated, as a Blob. */
  fetchSegment(url: string): Promise<Blob> {
    return this.fetchAudioBlob(url);
  }

  /**
   * Decode SoundCloud's classic waveform PNG into per-column loudness values:
   * each column's count of waveform pixels is proportional to the amplitude
   * there, which is what the waveform display plots per column.
   *
   * The image is a transparent-background PNG whose waveform pixels are light
   * grey (rgb(239,239,239)) — so the threshold must stay above 239 to count
   * them while still ignoring an opaque white background, should one appear.
   */
  async samplesFromWaveformPng(blob: Blob): Promise<number[]> {
    const bitmap = await createImageBitmap(blob);
    try {
      const { width, height } = bitmap;
      let ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
      if (typeof OffscreenCanvas !== "undefined") {
        ctx = new OffscreenCanvas(width, height).getContext("2d")!;
      } else {
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        ctx = canvas.getContext("2d")!;
      }
      ctx.drawImage(bitmap, 0, 0);
      const { data } = ctx.getImageData(0, 0, width, height);
      const samples = new Array<number>(width);
      for (let x = 0; x < width; x += 1) {
        let count = 0;
        for (let y = 0; y < height; y += 1) {
          const offset = (y * width + x) * 4;
          if (data[offset + 3] > 0 && data[offset] < 250) count += 1; // waveform pixel
        }
        samples[x] = count;
      }
      return samples;
    } finally {
      bitmap.close?.();
    }
  }

  /**
   * Loudness samples from the track's waveform metadata (~1500 values
   * spanning the whole track, a few KB) — what the waveform display renders
   * as bars. Returns the samples array
   * or null when unavailable. Public CDN file: no OAuth header needed (and
   * sending one could break CORS on that host).
   */
  async waveformSamples(track: Track): Promise<number[] | null> {
    const log = (m: string) => SoundCloudApi.logger?.(`[api] waveform: ${m}`);
    if (typeof track.waveform_url !== "string" || !track.waveform_url.trim()) {
      log(`track ${track.id} has no waveform_url — fields: ${Object.keys(track).join(",")}`);
      return null;
    }
    log(`fetching ${track.waveform_url}`);
    try {
      const response = await fetch(track.waveform_url.trim());
      if (!response.ok) {
        log(`HTTP ${response.status}`);
        return null;
      }
      const blob = await response.blob();
      // Sniff the payload: SoundCloud serves JSON waveforms for some tracks
      // and the classic waveform PNG for others.
      const probe = await blob.slice(0, 8).text();
      if (probe.startsWith("{")) {
        const data = JSON.parse(await blob.text());
        if (Array.isArray(data?.samples) && data.samples.length > 1) return data.samples;
        log(`unexpected JSON payload — keys: ${Object.keys(data ?? {}).join(",")}`);
        return null;
      }
      const samples = await this.samplesFromWaveformPng(blob);
      if (samples && samples.length > 1) {
        log(`decoded waveform image: ${samples.length} columns`);
        return samples;
      }
      return null;
    } catch (err) {
      log(`fetch/decode failed: ${err.message}`);
      return null;
    }
  }
}

/** Local structural type (defined here to keep types.ts free of API details). */
interface TrackPagerLike {
  readonly done: boolean;
  next(): Promise<Track[] | null>;
}
