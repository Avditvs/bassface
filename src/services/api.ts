/**
 * Thin SoundCloud API client for browser use.
 * Uses the `Authorization: OAuth <token>` header and transparently
 * refreshes the access token once when a request comes back 401.
 * @see https://developers.soundcloud.com/docs/api/guide
 */

import { API_BASE_URL, refreshAccessToken } from "./oauth";
import { redactSecrets } from "./util";
import type {
  ApiContext, HlsSegment, HlsStream, Playlist, PreviewKind, PreviewSource, SCUser,
  Streams, Track,
} from "../services/types";

/** Upper bound on HLS segments concatenated into one preview blob (~10–20 min). */
const HLS_MAX_SEGMENTS = 120;

/** A playable audio source offered by `/tracks/:id/streams` or the track's
 *  transcodings: an HLS playlist or a direct progressive file, with the
 *  codec its bytes encode (only mp3/aac are playable AND decodable in every
 *  supported browser — opus/webm variants are skipped). */
interface StreamCandidate {
  url: string;
  mime: string;
  /** True when the URL is a progressive file (one request, whole track);
   *  false when it is an HLS playlist to fetch segment by segment. */
  direct: boolean;
}

/** Codec MIME for a transcode name/mime-type, or "" when unsupported. */
function codecMime(name: string): string {
  if (name.includes("mp3") || name.includes("mpeg")) return "audio/mpeg";
  if (name.includes("aac")) return "audio/aac";
  return ""; // opus/webm variants: skip (no reliable element/MSE playback)
}

/**
 * Playable audio sources of a `/streams` response, mp3 before aac and HLS
 * before direct within a codec (mp3 HLS, mp3 direct, aac HLS, aac direct).
 * Scanned generically over all `*_url` fields: SoundCloud adds transcode
 * tiers (e.g. `hls_aac_160_url`) without notice, and some tracks expose
 * only the AAC ones.
 */
function streamCandidates(streams: Streams): StreamCandidate[] {
  return Object.entries(streams)
    .filter(([key, value]) => typeof value === "string" && value.trim()
      && /^(hls|http)_(mp3|aac)_/.test(key) && key.endsWith("_url"))
    .map(([key, value]) => ({
      key,
      url: (value as string).trim(),
      mime: codecMime(key),
      direct: key.startsWith("http_"),
    }))
    // HLS before direct (bounded download), mp3 before aac (universally
    // playable/decodable).
    .sort((a, b) => (a.direct ? 1 : 0) - (b.direct ? 1 : 0)
      || (a.key.includes("_mp3") ? 0 : 1) - (b.key.includes("_mp3") ? 0 : 1))
    .map(({ url, mime, direct }) => ({ url, mime, direct }));
}

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
    return this.trackPagerOver(`${API_BASE_URL}/playlists/${encodeURIComponent(id)}/tracks?linked_partitioning=true&limit=${pageSize}`);
  }

  /**
   * On-demand page loader for the authenticated user's liked (favorited)
   * tracks, paginated exactly like the playlist-tracks endpoint. Known
   * SoundCloud quirk: on this endpoint each track's `created_at` field is
   * the date the like was made, not the track's upload date — the UI uses
   * it to show when a sound was liked. The endpoint returns the tracks
   * most recently liked first.
   */
  createLikedTracksPager({ pageSize = 50 }: { pageSize?: number } = {}): TrackPagerLike {
    return this.trackPagerOver(`${API_BASE_URL}/me/likes/tracks?linked_partitioning=true&limit=${pageSize}`);
  }

  /** Shared `linked_partitioning` walker for track collections. */
  private trackPagerOver(initialHref: string): TrackPagerLike {
    const api = this; // the pager object itself has no request()
    let href: string | null = initialHref;
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
   * Resolve + download a playable preview source for a track, always the
   * full-length audio when one exists:
   *   1. full-length sources from `/tracks/:id/streams` — scanned generically
   *      over all `hls_*` / `http_*` mp3 & aac fields (mp3 preferred, then
   *      aac: newer tracks sometimes only expose AAC HLS),
   *   2. full-length audio via the track's HLS transcodings (`media
   *      .transcodings` with `protocol: "hls"` — what the SoundCloud web
   *      player resolves itself; some tracks expose no `/streams` fields at
   *      all),
   *   3. the ~30 s `preview_mp3_128_url` snippet — last resort for tracks
   *      that expose no full-length source at all (`complete: false`),
   *   4. legacy `stream_url` / first progressive transcoding URL (no Blob —
   *      played directly, may fail when it still requires auth).
   *
   * Every `/streams` URL lives on api.soundcloud.com and still requires the
   * `Authorization: OAuth` header, so it cannot be handed to a bare
   * `<audio src>` — hence the Blob downloads.
   *
   * Returns `{ blob, url, kind }` (`kind`: "full" | "legacy") or null when
   * no playable source is exposed.
   */
  async previewSource(
    track: Track,
    { onRaw = null, onError = null }: {
      onRaw?: ((streams: Streams) => void) | null;
      onError?: ((err: unknown) => void) | null;
    } = {},
  ): Promise<PreviewSource | null> {
    try {
      const streams: Streams = await this.request(`/tracks/${encodeURIComponent(track.id)}/streams`);
      if (onRaw) onRaw(streams);
      for (const candidate of streamCandidates(streams)) {
        try {
          if (candidate.direct) {
            const blob = await this.fetchAudioBlob(candidate.url);
            // A direct file is the whole track, so a jump preview can simply
            // seek inside the Blob.
            return { blob, url: candidate.url, kind: "full", complete: true };
          }
          const { blob, complete } = await this.fetchHls(candidate.url, candidate.mime);
          return { blob, url: candidate.url, kind: "full", complete };
        } catch (err) {
          SoundCloudApi.logger?.(`[api] stream candidate failed: ${err.message}`);
        }
      }
      // No usable /streams entry: resolve the track's own HLS transcodings.
      for (const resolved of await this.resolveHlsTranscodings(track)) {
        try {
          const { blob, complete } = await this.fetchHls(resolved.m3u8, resolved.mime);
          return { blob, url: resolved.m3u8, kind: "full", complete };
        } catch (err) {
          SoundCloudApi.logger?.(`[api] hls transcoding download failed: ${err.message}`);
        }
      }
      // Last resort: the ~30 s preview snippet — the only thing some tracks
      // expose. complete:false marks it as not covering the whole track.
      const previewUrl = typeof streams.preview_mp3_128_url === "string" ? streams.preview_mp3_128_url.trim() : "";
      if (previewUrl) {
        try {
          const blob = await this.fetchAudioBlob(previewUrl);
          SoundCloudApi.logger?.(`[api] no full-length source — falling back to the ~30 s preview snippet`);
          return { blob, url: previewUrl, kind: "full", complete: false };
        } catch (err) {
          SoundCloudApi.logger?.(`[api] preview snippet download failed: ${err.message}`);
        }
      }
      return null; // no playable source exposed
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
   * Download an HLS playlist and return its audio as one playable Blob.
   * Playlists longer than {@link HLS_MAX_SEGMENTS} are truncated to segments
   * taken from the middle, keeping the download bounded — `complete` reports
   * whether the Blob covers the whole track from position 0.
   */
  async fetchHls(m3u8Url: string, mime = "audio/mpeg"): Promise<{ blob: Blob; complete: boolean }> {
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
    return { blob: new Blob(parts, { type: mime }), complete };
  }

  /**
   * The track's HLS transcodings (the URLs the SoundCloud web player itself
   * resolves), resolved to actual m3u8 playlists, mp3 preferred over aac.
   * Each transcoding URL is an api.soundcloud.com endpoint returning
   * `{ url: "<m3u8>" }`. Unusable codecs (opus/webm) are skipped.
   */
  private async resolveHlsTranscodings(track: Track): Promise<{ m3u8: string; mime: string }[]> {
    const ordered = (track.media?.transcodings ?? [])
      .filter((t) => t.format?.protocol === "hls" && typeof t.url === "string" && t.url.trim())
      .map((t) => ({ url: t.url!.trim(), mime: codecMime(t.format?.mime_type ?? "") }))
      .filter((t) => t.mime)
      .sort((a, b) => (a.mime === "audio/mpeg" ? 0 : 1) - (b.mime === "audio/mpeg" ? 0 : 1));
    const resolved: { m3u8: string; mime: string }[] = [];
    for (const transcoding of ordered) {
      try {
        const json = await this.request(transcoding.url);
        if (typeof json?.url === "string" && json.url.trim()) {
          resolved.push({ m3u8: json.url.trim(), mime: transcoding.mime });
        }
      } catch (err) {
        SoundCloudApi.logger?.(`[api] hls transcoding resolve failed: ${err.message}`);
      }
    }
    return resolved;
  }

  /**
   * Segment list of the track's best HLS audio playlist: the mp3 transcode
   * when offered, the AAC one otherwise, and finally the track's HLS
   * transcodings when `/streams` exposes no playlist at all. Returns null
   * when no playable HLS playlist exists — callers fall back to the
   * progressive sources.
   */
  async hlsStream(
    track: Track,
    { onRaw = null, onError = null }: {
      onRaw?: ((streams: Streams) => void) | null;
      onError?: ((err: unknown) => void) | null;
    } = {},
  ): Promise<HlsStream | null> {
    try {
      const streams: Streams = await this.request(`/tracks/${encodeURIComponent(track.id)}/streams`);
      if (onRaw) onRaw(streams);
      for (const candidate of streamCandidates(streams).filter((c) => !c.direct)) {
        try {
          const stream = await this.fetchM3u8(candidate.url, candidate.mime);
          if (stream) return stream;
        } catch (err) {
          SoundCloudApi.logger?.(`[api] hls playlist ${candidate.url} failed: ${err.message}`);
        }
      }
    } catch (err) {
      if (onError) onError(err);
      /* fall through to the transcodings */
    }
    for (const resolved of await this.resolveHlsTranscodings(track)) {
      try {
        const stream = await this.fetchM3u8(resolved.m3u8, resolved.mime);
        if (stream) return stream;
      } catch (err) {
        SoundCloudApi.logger?.(`[api] hls transcoding playlist failed: ${err.message}`);
      }
    }
    return null;
  }

  /** Fetch an HLS playlist and parse its segments with their durations.
   *  Returns null when the playlist contains no segments. */
  private async fetchM3u8(m3u8Url: string, mime: string): Promise<HlsStream | null> {
    const response = await this.fetchAuthed(m3u8Url);
    if (!response.ok) {
      throw new Error(`SoundCloud HLS error (${response.status})`);
    }
    const base = new URL(response.url || m3u8Url);
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
    return segments.length > 0 ? { mime, segments } : null;
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
