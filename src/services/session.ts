/**
 * Session lifecycle: OAuth callback handling, token refresh, loading the
 * user profile and their playlists, entering the app and signing out.
 */

import { TokenStore, UserStore } from "./config";
import { exchangeCode, refreshAccessToken, validateState } from "./oauth";
import { dbg } from "./debug";
import { clearStatus, getState, runtime, setState, showStatus, tokenSummary } from "./store";
import { route } from "./router";
import { stopPreview } from "./preview";
import { resetPlaylistView } from "./tracks";
import { resetOrganizeSidebar } from "./organize";
import { SoundCloudApi } from "./api";
import type { OAuthCallback } from "../services/types";

/** Refresh the access token when stale; throws when it cannot be restored. */
export async function ensureValidToken(): Promise<void> {
  if (runtime.tokens.isFresh()) return;
  if (!runtime.tokens.canRefresh()) {
    const reason = runtime.tokens.hasAccessToken()
      ? "no refresh token was issued for this session"
      : "no access token is stored";
    throw new Error(reason);
  }
  showStatus("Refreshing SoundCloud session…");
  const body = await refreshAccessToken({ refreshToken: runtime.tokens.refreshToken, config: runtime.config });
  if (!body.access_token) throw new Error("Refresh response missing access_token.");
  runtime.tokens.update(body);
  console.info("[session] refreshed token fields:", Object.keys(body));
}

/** Fetch the authenticated user's profile and cache it. */
export async function loadUser(): Promise<void> {
  const user = await getState().api!.me();
  setState({ user });
  UserStore.save(user);
}

/** Fetch all playlists of the user, then land on the list screen. */
export async function loadPlaylists(): Promise<void> {
  setState({ playlistsLoading: true });
  showStatus("Loading your playlists…");
  try {
    const playlists = await getState().api!.myPlaylists();
    setState({ playlists });
  } finally {
    setState({ playlistsLoading: false });
  }
  clearStatus();
}

/** Wire the API client, restore the session and land on the right screen. */
export async function enterApp(): Promise<void> {
  dbg(`[enterApp] ${tokenSummary()}`);
  setState({
    api: new SoundCloudApi({
      getConfig: () => runtime.config,
      getTokens: () => runtime.tokens,
      updateTokens: (body) => runtime.tokens.update(body),
    }),
  });

  try {
    await ensureValidToken();
    await loadUser();
    await loadPlaylists();
    // Route to the playlist detail when opened via a `#/playlist/<id>` deep link.
    route();
    dbg(`[enterApp] success — ${getState().playlists.length} playlists loaded`);
  } catch (err) {
    dbg(`[enterApp] failed: ${(err as Error).message} — ${tokenSummary()}`);
    // Keep the stored tokens for troubleshooting; never silently destroy the
    // session here (a transient error must not force a full reconnect).
    setState({ api: null });
    showStatus(`Could not restore your session: ${(err as Error).message}. Connect again.`, "error");
  }
}

/** Drop ?code&state from the address bar so a reload cannot re-exchange a used code. */
function removeCallbackFromUrl(): void {
  const url = new URL(window.location.href);
  url.search = "";
  history.replaceState(null, "", url);
}

/** OAuth redirect landed back on the page: validate + exchange the code. */
export async function handleOAuthCallback({ code, state: receivedState, error }: OAuthCallback): Promise<void> {
  if (error) {
    showStatus(`Authorization failed: ${error}`, "error");
    return;
  }
  if (!code) {
    showStatus("Authorization callback missing the code parameter.", "error");
    return;
  }
  if (!validateState(receivedState)) {
    showStatus("State mismatch — authorization aborted (possible CSRF). Try again.", "error");
    return;
  }

  showStatus("Exchanging the authorization code…");
  try {
    const body = await exchangeCode({ code, config: runtime.config });
    if (!body.access_token) {
      throw new Error(`No access_token in response: ${JSON.stringify(body)}`);
    }
    runtime.tokens.update(body);
    runtime.tokens.save();
    removeCallbackFromUrl();
    dbg(`[oauth] exchange 200 — at=${!!body.access_token} rt=${!!body.refresh_token} expires=${body.expires_in}`);
    await enterApp();
  } catch (err) {
    // The code is single-use regardless of exchange success: drop it from the
    // address bar so a reload cannot replay a dead code.
    removeCallbackFromUrl();
    showStatus(`Could not complete sign-in: ${(err as Error).message}`, "error");
  }
}

/** Forget tokens + data and return to the connect screen. */
export function signOut(): void {
  if (!confirm("Sign out and forget the stored SoundCloud token?")) return;
  runtime.tokens.clear();
  UserStore.clear();
  runtime.tokens = TokenStore.load();
  stopPreview();
  resetPlaylistView();
  resetOrganizeSidebar();
  history.replaceState(null, "", window.location.pathname);
  setState({
    api: null,
    user: null,
    playlists: [],
    playlistsLoading: false,
    currentPlaylist: null,
    undoEntry: null,
  });
  clearStatus();
}
