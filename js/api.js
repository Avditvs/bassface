/**
 * Thin SoundCloud API client for browser use.
 * Uses the `Authorization: OAuth <token>` header and transparently
 * refreshes the access token once when a request comes back 401.
 * @see https://developers.soundcloud.com/docs/api/guide
 */

import { API_BASE_URL, refreshAccessToken } from "./oauth.js";

/** Upper bound on HLS segments concatenated into one preview blob (~10–20 min). */
const HLS_MAX_SEGMENTS = 120;

/**
 * Whether a failed response is SoundCloud's rate limit (HTTP 429, or the
 * legacy 403 body they sometimes send when the quota is exhausted).
 */
function isRateLimit(status, body) {
  return status === 429 || /rate limit/i.test(body);
}

/** Build a clear, actionable error for a rate-limited response. */
function rateLimitError(response) {
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
 * @param {object} ctx - runtime access to {getConfig, getTokens, updateTokens}.
 *   Passing the app context keeps this module free of UI/state dependencies.
 */
export class SoundCloudApi {
  /** Optional sink for request-level diagnostics (wired to the app's log). */
  static logger = null;

  constructor(ctx) {
    this.ctx = ctx;
  }

  async request(path, { retried = false } = {}) {
    const url = new URL(path.startsWith("http") ? path : `${API_BASE_URL}${path}`);
    // Fresh cache-buster per attempt: keeps the 401-retry from being served
    // CloudFront's cached error response instead of the re-issued request.
    url.searchParams.set("ts", Date.now());
    let response;
    try {
      response = await fetch(url, {
        headers: {
          accept: "application/json; charset=utf-8",
          authorization: `OAuth ${this.ctx.getTokens().accessToken}`,
        },
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
      return this.request(path, { retried: true });
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
  async refreshOnce() {
    const body = await refreshAccessToken({ refreshToken: this.ctx.getTokens().refreshToken, config: this.ctx.getConfig() });
    this.ctx.updateTokens(body);
  }

  /** The authenticated user's profile. */
  async me() {
    return this.request("/me");
  }

  /**
   * All playlists of the authenticated user, following SoundCloud's
   * `linked_partitioning` pagination via `next_href`.
   */
  async myPlaylists() {
    const playlists = [];
    let href = `${API_BASE_URL}/me/playlists?show_tracks=false&linked_partitioning=true&limit=50`;
    while (href) {
      const page = await this.request(href);
      playlists.push(...(page.collection ?? []));
      if (!page.next_href || page.next_href === href) break;
      href = page.next_href;
    }
    return playlists;
  }

  /**
   * The sounds inside one playlist (`show_tracks=true` embeds track objects
   * on each page, paginated via `next_href`).
   * @see https://developers.soundcloud.com/docs/api/guide#listen
   */
  async playlistTracks(id) {
    const tracks = [];
    let href = `${API_BASE_URL}/playlists/${encodeURIComponent(id)}?show_tracks=true&linked_partitioning=true&limit=50`;
    while (href) {
      const page = await this.request(href);
      tracks.push(...(page.tracks ?? page.collection ?? []));
      // Guard against a misbehaving API handing back the same page forever.
      if (!page.next_href || page.next_href === href) break;
      href = page.next_href;
    }
    return tracks;
  }

  /**
   * Resolve + download a playable preview source for a track. Priority
   * depends on the requested mode:
   *   mode "start" (simple play button — quick to load):
   *     1. SoundCloud's ~30 s snippet (`preview_mp3_128_url`),
   *     2. full-length mp3 via the HLS playlist (`hls_mp3_128_url`),
   *     3. full-length mp3 (`http_mp3_128_url`),
   *     4. legacy `stream_url` / progressive transcoding URL.
   *   mode "peak" (needs the full track to find the loudest part) —
   *   HLS preferred over the direct progressive mp3:
   *     1. full-length mp3 via the HLS playlist (`hls_mp3_128_url`) — segments
   *        are fetched with auth and concatenated into one Blob,
   *     2. full-length mp3 from `/tracks/:id/streams` (`http_mp3_128_url`),
   *     3. SoundCloud's ~30 s snippet (`preview_mp3_128_url`) — peak then
   *        starts at 0 (nothing to scan),
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
  async previewSource(track, { mode = "start", onRaw = null, onError = null } = {}) {
    try {
      const streams = await this.request(`/tracks/${encodeURIComponent(track.id)}/streams`);
      if (onRaw) onRaw(streams);
      const candidates = mode === "peak"
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
          const blob = direct ? await this.fetchAudioBlob(url) : await this.fetchHlsBlob(url);
          return { blob, url, kind };
        } catch (err) {
          SoundCloudApi.logger?.(`[api] ${key} download failed: ${err.message}`);
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
   * refreshing the token once when the request comes back 401.
   */
  async fetchAuthed(url) {
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
  async fetchAudioBlob(url) {
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
   * taken from the middle, keeping the download bounded while starting the
   * preview mid-track. (The peak preview uses {@link hlsSegments} instead,
   * keeping only the loudest segment.)
   */
  async fetchHlsBlob(m3u8Url) {
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
    SoundCloudApi.logger?.(`[api] hls: using ${chosen.length}/${segments.length} segments`);
    const parts = [];
    for (const segment of chosen) {
      parts.push(await this.fetchAudioBlob(new URL(segment, base).toString()));
    }
    return new Blob(parts, { type: "audio/mpeg" });
  }

  /**
   * Segment list of the track's HLS mp3 playlist: `[{url, duration}]`, in
   * order (cumulative start times follow from the durations). Returns null
   * when the track exposes no `hls_mp3_128_url` — callers fall back to the
   * progressive sources.
   */
  async hlsSegments(track, { onRaw = null, onError = null } = {}) {
    let streams;
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
    const segments = [];
    let duration = null;
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
  fetchSegment(url) {
    return this.fetchAudioBlob(url);
  }

  /**
   * Decode SoundCloud's classic waveform PNG into per-column loudness values:
   * each column's count of waveform pixels is proportional to the amplitude
   * there, which is all the coarse peak search needs.
   */
  async samplesFromWaveformPng(blob) {
    const bitmap = await createImageBitmap(blob);
    try {
      const { width, height } = bitmap;
      let ctx;
      if (typeof OffscreenCanvas !== "undefined") {
        ctx = new OffscreenCanvas(width, height).getContext("2d");
      } else {
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        ctx = canvas.getContext("2d");
      }
      ctx.drawImage(bitmap, 0, 0);
      const { data } = ctx.getImageData(0, 0, width, height);
      const samples = new Array(width);
      for (let x = 0; x < width; x += 1) {
        let count = 0;
        for (let y = 0; y < height; y += 1) {
          const offset = (y * width + x) * 4;
          if (data[offset + 3] > 0 && data[offset] < 200) count += 1; // waveform pixel
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
   * spanning the whole track, a few KB) — lets the peak search locate the
   * loudest region without downloading any audio. Returns the samples array
   * or null when unavailable. Public CDN file: no OAuth header needed (and
   * sending one could break CORS on that host).
   */
  async waveformSamples(track) {
    const log = (m) => SoundCloudApi.logger?.(`[api] waveform: ${m}`);
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