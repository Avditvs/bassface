/**
 * Thin SoundCloud API client for browser use.
 * Uses the `Authorization: OAuth <token>` header and transparently
 * refreshes the access token once when a request comes back 401.
 * @see https://developers.soundcloud.com/docs/api/guide
 */

import { API_BASE_URL, refreshAccessToken } from "./oauth.js";

/**
 * @param {object} ctx - runtime access to {getConfig, getTokens, updateTokens}.
 *   Passing the app context keeps this module free of UI/state dependencies.
 */
export class SoundCloudApi {
  constructor(ctx) {
    this.ctx = ctx;
  }

  async request(path, { retried = false } = {}) {
    const url = path.startsWith("http") ? path : `${API_BASE_URL}${path}`;
    const response = await fetch(url, {
      headers: {
        accept: "application/json; charset=utf-8",
        authorization: `OAuth ${this.ctx.getTokens().accessToken}`,
      },
    });
    console.info(`[api] ${response.status} ${url}`);

    if (response.status === 401 && !retried && this.ctx.getTokens().canRefresh()) {
      await this.refreshOnce();
      return this.request(path, { retried: true });
    }
    if (!response.ok) {
      throw new Error(`SoundCloud API error (${response.status}): ${await response.text()}`);
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
}