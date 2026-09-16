/**
 * Persistence for app configuration (client credentials / redirect URI)
 * and OAuth tokens. Everything lives in localStorage so no backend is needed.
 */

import type { BpmAnalysis, ChromaAnalysis, TokenPayload, SCUser } from "../services/types";

const CONFIG_KEY = "playlist_updater.config";
const TOKENS_KEY = "playlist_updater.tokens";
const USER_KEY = "playlist_updater.user";
const CHROMAS_KEY = "playlist_updater.chromas";
const BPMS_KEY = "playlist_updater.bpms";

const CONFIG_DEFAULTS = {
  clientId: "",
  clientSecret: "",
  redirectUri: "",
  tokenProxyUrl: "",
};

function readJson(key: string): any {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null");
  } catch {
    return null;
  }
}

/** Storage must never be fatal: a blocked/silent localStorage just warns. */
function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    console.warn(`[storage] could not persist ${key}:`, err);
  }
}

/**
 * App settings: SoundCloud client credentials and the registered redirect URI.
 * The redirect URI field is left empty when it matches the serving origin
 * (i.e. the app is opened via http(s), which is OAuth-compatible).
 */
export class AppConfig {
  clientId = CONFIG_DEFAULTS.clientId;
  clientSecret = CONFIG_DEFAULTS.clientSecret;
  redirectUri = CONFIG_DEFAULTS.redirectUri;
  /** Token proxy (see worker/): when set, token requests are routed through
   * it so the client secret is injected server-side and never reaches the
   * browser. Empty = talk to SoundCloud directly (secret sent inline). */
  tokenProxyUrl = CONFIG_DEFAULTS.tokenProxyUrl;

  static load(): AppConfig {
    const stored = (readJson(CONFIG_KEY) ?? {}) as Partial<AppConfig>;
    const config = new AppConfig();
    config.clientId = stored.clientId ?? CONFIG_DEFAULTS.clientId;
    config.clientSecret = stored.clientSecret ?? CONFIG_DEFAULTS.clientSecret;
    config.redirectUri = stored.redirectUri ?? CONFIG_DEFAULTS.redirectUri;
    config.tokenProxyUrl = stored.tokenProxyUrl ?? CONFIG_DEFAULTS.tokenProxyUrl;
    return config;
  }

  /** The redirect URI to use with SoundCloud (explicit or derived from the page URL). */
  resolveRedirectUri(): string {
    if (this.redirectUri) return this.redirectUri;
    if (window.location.protocol.startsWith("http")) {
      return `${window.location.origin}${window.location.pathname}`;
    }
    return "";
  }

  isComplete(): boolean {
    return Boolean(this.clientId && this.resolveRedirectUri());
  }

  save(): void {
    writeJson(CONFIG_KEY, { ...this });
  }

  clear(): void {
    localStorage.removeItem(CONFIG_KEY);
  }
}

/** Persisted token data (internal shape). */
interface TokenData {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
}

/** OAuth session tokens, with an expiry timestamp we can check. */
export class TokenStore {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;

  static load(): TokenStore {
    return new TokenStore((readJson(TOKENS_KEY) ?? {}) as TokenData);
  }

  constructor(data: TokenData) {
    this.accessToken = data.accessToken ?? "";
    this.refreshToken = data.refreshToken ?? "";
    this.expiresAt = data.expiresAt ?? 0;
  }

  hasAccessToken(): boolean {
    return Boolean(this.accessToken);
  }

  /** True when the access token should still be valid (with a 5 minute buffer). */
  isFresh(): boolean {
    return this.hasAccessToken() && Date.now() < this.expiresAt - 5 * 60 * 1000;
  }

  /** True when a refresh token is stored and may still be usable. */
  canRefresh(): boolean {
    return Boolean(this.refreshToken);
  }

  /**
   * Apply a token response. Accepts both snake_case (raw SoundCloud response:
   * access_token / refresh_token / expires_in) and camelCase (internal shape).
   */
  update(response: TokenPayload): void {
    const accessToken = response.accessToken ?? response.access_token;
    const refreshToken = response.refreshToken ?? response.refresh_token;
    const expiresIn = response.expiresIn ?? response.expires_in;
    if (accessToken) this.accessToken = accessToken;
    // Refresh tokens are single-use on SoundCloud: keep the newest one.
    if (refreshToken) this.refreshToken = refreshToken;
    // Fallback to 1h when the response omits expires_in (some responses do).
    this.expiresAt = Date.now() + (Number(expiresIn) || 3600) * 1000;
    this.save();
  }

  save(): void {
    writeJson(TOKENS_KEY, { ...this });
  }

  clear(): void {
    localStorage.removeItem(TOKENS_KEY);
  }
}

/** Cached `/me` profile so we can greet the user immediately after refresh. */
export class UserStore {
  static load(): SCUser | null {
    return readJson(USER_KEY);
  }

  static save(user: SCUser): void {
    writeJson(USER_KEY, user);
  }

  static clear(): void {
    localStorage.removeItem(USER_KEY);
  }
}

/**
 * Per-track chroma analyses (key estimations, see services/chroma.ts), keyed
 * by SoundCloud track id — stable across sessions, so a key computed once
 * never costs a second analysis. Deliberately kept on sign-out: it is
 * content-derived data, not user data.
 */
export const ChromaStore = {
  load(): Record<number, ChromaAnalysis> {
    return readJson(CHROMAS_KEY) ?? {};
  },

  save(trackId: number, analysis: ChromaAnalysis): void {
    const all = readJson(CHROMAS_KEY) ?? {};
    all[trackId] = analysis;
    writeJson(CHROMAS_KEY, all);
  },
};

/**
 * Per-track BPM analyses (tempo estimations, see services/bpm.ts), keyed by
 * SoundCloud track id — stable across sessions, like ChromaStore.
 */
export const BpmStore = {
  load(): Record<number, BpmAnalysis> {
    return readJson(BPMS_KEY) ?? {};
  },

  save(trackId: number, analysis: BpmAnalysis): void {
    const all = readJson(BPMS_KEY) ?? {};
    all[trackId] = analysis;
    writeJson(BPMS_KEY, all);
  },
};
