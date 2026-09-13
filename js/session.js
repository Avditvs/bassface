/**
 * Session lifecycle: OAuth callback handling, token refresh, loading the
 * user profile and their playlists, entering the app and signing out.
 */

import { TokenStore, UserStore } from "./config.js";
import { exchangeCode, refreshAccessToken, validateState } from "./oauth.js";
import { dbg } from "./debug.js";
import { tokenSummary, state } from "./state.js";
import { showScreen, showStatus, clearStatus } from "./screens.js";
import { route } from "./router.js";
import { forgetTrackSentinel } from "./tracks.js";
import { stopPreview } from "./preview.js";
import { renderUser, renderPlaylistControls, renderPlaylists } from "./render.js";
import { SoundCloudApi } from "./api.js";

/** Refresh the access token when stale; throws when it cannot be restored. */
export async function ensureValidToken() {
  if (state.tokens.isFresh()) return;
  if (!state.tokens.canRefresh()) {
    const reason = state.tokens.hasAccessToken()
      ? "no refresh token was issued for this session"
      : "no access token is stored";
    throw new Error(reason);
  }
  showStatus("Refreshing SoundCloud session…");
  const body = await refreshAccessToken({ refreshToken: state.tokens.refreshToken, config: state.config });
  if (!body.access_token) throw new Error("Refresh response missing access_token.");
  state.tokens.update(body);
  console.info("[session] refreshed token fields:", Object.keys(body));
}

/** Fetch the authenticated user's profile and cache it. */
export async function loadUser() {
  state.user = await state.api.me();
  UserStore.save(state.user);
  renderUser();
}

/** Fetch all playlists of the user, then render the list screen. */
export async function loadPlaylists() {
  state.playlistsLoading = true;
  showScreen("playlists");
  renderPlaylists();
  showStatus("Loading your playlists…");
  try {
    state.playlists = await state.api.myPlaylists();
  } finally {
    state.playlistsLoading = false;
  }
  state.page = 1;
  clearStatus();
  renderPlaylistControls();
  renderPlaylists();
}

/** Wire the API client, restore the session and land on the right screen. */
export async function enterApp() {
  dbg(`[enterApp] ${tokenSummary()}`);
  state.api = new SoundCloudApi({
    getConfig: () => state.config,
    getTokens: () => state.tokens,
    updateTokens: (body) => state.tokens.update(body),
  });

  try {
    await ensureValidToken();
    await loadUser();
    await loadPlaylists();
    // Route to the playlist detail when opened via a `#/playlist/<id>` deep link.
    route();
    dbg(`[enterApp] success — ${state.playlists.length} playlists loaded`);
  } catch (err) {
    dbg(`[enterApp] failed: ${err.message} — ${tokenSummary()}`);
    // Keep the stored tokens for troubleshooting; never silently destroy the
    // session here (a transient error must not force a full reconnect).
    showScreen("connect");
    showStatus(`Could not restore your session: ${err.message}. Connect again.`, "error");
  }
}

/** Drop ?code&state from the address bar so a reload cannot re-exchange a used code. */
function removeCallbackFromUrl() {
  const url = new URL(window.location.href);
  url.search = "";
  history.replaceState(null, "", url);
}

/** OAuth redirect landed back on the page: validate + exchange the code. */
export async function handleOAuthCallback({ code, state: receivedState, error }) {
  if (error) {
    showScreen("connect");
    showStatus(`Authorization failed: ${error}`, "error");
    return;
  }
  if (!code) {
    showScreen("connect");
    showStatus("Authorization callback missing the code parameter.", "error");
    return;
  }
  if (!validateState(receivedState)) {
    showScreen("connect");
    showStatus("State mismatch — authorization aborted (possible CSRF). Try again.", "error");
    return;
  }

  showStatus("Exchanging the authorization code…");
  try {
    const body = await exchangeCode({ code, config: state.config });
    if (!body.access_token) {
      throw new Error(`No access_token in response: ${JSON.stringify(body)}`);
    }
    state.tokens.update(body);
    state.tokens.save();
    removeCallbackFromUrl();
    dbg(`[oauth] exchange 200 — at=${!!body.access_token} rt=${!!body.refresh_token} expires=${body.expires_in}`);
    await enterApp();
  } catch (err) {
    // The code is single-use regardless of exchange success: drop it from the
    // address bar so a reload cannot replay a dead code.
    removeCallbackFromUrl();
    showScreen("connect");
    showStatus(`Could not complete sign-in: ${err.message}`, "error");
  }
}

/** Forget tokens + data and return to the connect screen. */
export function signOut() {
  if (!confirm("Sign out and forget the stored SoundCloud token?")) return;
  state.tokens.clear();
  UserStore.clear();
  state.tokens = TokenStore.load();
  state.user = null;
  state.playlists = [];
  forgetTrackSentinel();
  state.trackPager = null;
  document.getElementById("user-area").hidden = true;
  stopPreview();
  history.replaceState(null, "", window.location.pathname);
  clearStatus();
  showScreen("connect");
}
