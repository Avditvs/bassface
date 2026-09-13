/**
 * SoundCloud OAuth 2.1 (authorization code + PKCE) — all client-side.
 *
 * Flow: build authorize URL -> user approves on SoundCloud ->
 * redirect back with ?code&state -> exchange for tokens ->
 * keep tokens fresh with the (single-use) refresh token.
 * @see https://developers.soundcloud.com/docs/api/guide#authentication
 */

import { base64UrlEncode, randomBytes, randomState, sha256Of } from "./util.js";
import type { TokenPayload } from "./types.js";
import type { AppConfig } from "./config.js";

export const AUTHORIZE_URL = "https://secure.soundcloud.com/authorize";
export const TOKEN_URL = "https://secure.soundcloud.com/oauth/token";
export const API_BASE_URL = "https://api.soundcloud.com";

const VERIFIER_KEY = "playlist_updater.code_verifier";
const STATE_KEY = "playlist_updater.state";

function newCodeVerifier(): string {
  return base64UrlEncode(randomBytes(32));
}

/** Build the SoundCloud authorization URL for the current browser tab. */
export async function buildAuthUrl(config: AppConfig): Promise<string> {
  const verifier = newCodeVerifier();
  const challenge = base64UrlEncode(await sha256Of(verifier));
  const state = randomState();

  // Keep PKCE + state in sessionStorage: they survive the redirect to
  // SoundCloud and back, without leaking into localStorage.
  sessionStorage.setItem(VERIFIER_KEY, verifier);
  sessionStorage.setItem(STATE_KEY, state);

  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.resolveRedirectUri(),
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });
  return `${AUTHORIZE_URL}?${params}`;
}

/** URL-encoded body shared by the token requests. */
function tokenBody(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

/** Exchange the authorization `code` for an access token. */
export async function exchangeCode({ code, config }: { code: string; config: AppConfig }): Promise<TokenPayload> {
  const params: Record<string, string> = {
    grant_type: "authorization_code",
    client_id: config.clientId,
    redirect_uri: config.resolveRedirectUri(),
    code_verifier: sessionStorage.getItem(VERIFIER_KEY) ?? "",
    code,
  };
  if (config.clientSecret) params.client_secret = config.clientSecret;

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      accept: "application/json; charset=utf-8",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: tokenBody(params),
  });
  if (!response.ok) {
    throw new Error(`Token exchange failed (${response.status}): ${await response.text()}`);
  }
  const body: TokenPayload = await response.json();
  console.info("[oauth] token exchange 200 — response fields:", Object.keys(body));
  sessionStorage.removeItem(VERIFIER_KEY);
  return body;
}

/** Obtain a new access token from the (single-use) refresh token. */
export async function refreshAccessToken({ refreshToken, config }: { refreshToken: string; config: AppConfig }): Promise<TokenPayload> {
  const params: Record<string, string> = {
    grant_type: "refresh_token",
    client_id: config.clientId,
    refresh_token: refreshToken,
  };
  if (config.clientSecret) params.client_secret = config.clientSecret;

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      accept: "application/json; charset=utf-8",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: tokenBody(params),
  });
  if (!response.ok) {
    throw new Error(`Token refresh failed (${response.status}): ${await response.text()}`);
  }
  return response.json();
}

/** Verify the OAuth `state` nonce received in the callback (CSRF protection). */
export function validateState(state: string | null): boolean {
  const expected = sessionStorage.getItem(STATE_KEY);
  sessionStorage.removeItem(STATE_KEY);
  return Boolean(expected) && state === expected;
}
