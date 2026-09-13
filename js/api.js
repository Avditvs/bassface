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
    const response = await fetch(url, {
      headers: {
        accept: "application/json; charset=utf-8",
        authorization: `OAuth ${this.ctx.getTokens().accessToken}`,
      },
    });
    SoundCloudApi.logger?.(`[api] ${response.status} ${url}`);

    if (response.status === 401 && !retried && this.ctx.getTokens().canRefresh()) {
      await this.refreshOnce();
      return this.request(path, { retried: true });
    }
    if (!response.ok) {
      const body = await response.text();
      SoundCloudApi.logger?.(`[api] ${response.status} body: ${body.slice(0, 400)}`);
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
      href = page.next_href;
    }
    return tracks;
  }

  /**
   * Resolve + download a playable preview source for a track. Priority:
   *   1. full-length mp3 from `/tracks/:id/streams` (`http_mp3_128_url`),
   *   2. full-length mp3 via the HLS playlist (`hls_mp3_128_url`) — segments
   *      are fetched with auth and concatenated into one Blob,
   *   3. SoundCloud's ~30 s snippet (`preview_mp3_128_url`),
   *   4. legacy `stream_url` / first progressive transcoding URL (no Blob —
   *      played directly, may fail when it still requires auth).
   *
   * Every `/streams` URL lives on api.soundcloud.com and still requires the
   * `Authorization: OAuth` header, so it cannot be handed to a bare
   * `<audio src>` — hence the Blob downloads.
   *
   * Returns `{ blob, url, kind }` (`kind`: "full" | "snippet" | "legacy") or
   * null when no progressive stream is exposed (e.g. HLS-AAC-only tracks).
   */
  async previewSource(track, { onRaw = null, onError = null } = {}) {
    try {
      const streams = await this.request(`/tracks/${encodeURIComponent(track.id)}/streams`);
      if (onRaw) onRaw(streams);
      const candidates = [
        ["http_mp3_128_url", "full", true],
        ["hls_mp3_128_url", "full", false],
        ["preview_mp3_128_url", "snippet", true],
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
   * preview mid-track.
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
}