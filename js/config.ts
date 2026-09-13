/**
 * Persistence for app configuration (client credentials / redirect URI)
 * and OAuth tokens. Everything lives in localStorage so no backend is needed.
 */

import type { TokenPayload, SCUser } from "./types.js";

const CONFIG_KEY = "playlist_updater.config";
const TOKENS_KEY = "playlist_updater.tokens";
const USER_KEY = "playlist_updater.user";

const CONFIG_DEFAULTS = {
  clientId: "",
  clientSecret: "",
  redirectUri: "",
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

  static load(): AppConfig {
    const stored = (readJson(CONFIG_KEY) ?? {}) as Partial<AppConfig>;
    const config = new AppConfig();
    config.clientId = stored.clientId ?? CONFIG_DEFAULTS.clientId;
    config.clientSecret = stored.clientSecret ?? CONFIG_DEFAULTS.clientSecret;
    config.redirectUri = stored.redirectUri ?? CONFIG_DEFAULTS.redirectUri;
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
