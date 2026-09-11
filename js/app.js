/**
 * Playlist Updater — app controller.
 * Connects to SoundCloud (OAuth 2.1 + PKCE, all client-side) and lists
 * the authenticated user's playlists.
 */

import { AppConfig, TokenStore, UserStore } from "./config.js";
import { buildAuthUrl, exchangeCode, refreshAccessToken, validateState } from "./oauth.js";
import { SoundCloudApi } from "./api.js";
import { escapeHtml, formatCount, formatDate, playlistBucket } from "./util.js";

const TYPE_LABELS = { playlist: "Playlist", album: "Album", single: "Single" };

// ---------------------------------------------------------------------------
// Troubleshooting log (persistent ring buffer, shown on the connect screen)
// ---------------------------------------------------------------------------

const DEBUG_KEY = "playlist_updater.debug";

function readDebugLog() {
  try {
    return JSON.parse(localStorage.getItem(DEBUG_KEY)) ?? [];
  } catch {
    return [];
  }
}

function dbg(message) {
  const line = `${new Date().toISOString().slice(11, 19)} ${message}`;
  console.info(line);
  const log = readDebugLog();
  log.push(line);
  while (log.length > 60) log.shift();
  try {
    localStorage.setItem(DEBUG_KEY, JSON.stringify(log));
  } catch { /* non-fatal */ }
  renderDebugPanel();
}

function renderDebugPanel() {
  const panel = document.getElementById("debug-log");
  if (panel) panel.textContent = readDebugLog().join("\n") || "No events logged yet.";
}

function tokenSummary() {
  const t = state.tokens;
  return `at=${t.hasAccessToken()} rt=${t.canRefresh()} fresh=${t.isFresh()}`;
}

const state = {
  config: AppConfig.load(),
  tokens: TokenStore.load(),
  api: null,
  playlists: [],
  user: UserStore.load(),
};

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

const screens = {
  connect: document.getElementById("connect-screen"),
  playlists: document.getElementById("playlists-screen"),
};

function showScreen(name) {
  for (const screenKey of Object.keys(screens)) {
    screens[screenKey].hidden = screenKey !== name;
  }
}

function showStatus(message, kind = "") {
  const bar = document.getElementById("status-bar");
  bar.hidden = false;
  bar.className = kind ? `status-bar ${kind}` : "status-bar";
  bar.textContent = message;
}

function clearStatus() {
  document.getElementById("status-bar").hidden = true;
}

// ---------------------------------------------------------------------------
// Config form
// ---------------------------------------------------------------------------

function renderRedirectHint() {
  const hint = document.getElementById("redirect-hint");
  const resolved = state.config.redirectUri || state.config.resolveRedirectUri();
  if (state.config.redirectUri) {
    hint.textContent = "This exact URI (including trailing slash) must be registered as a redirect URI.";
  } else {
    hint.textContent = resolved
      ? `Registered redirect: ${resolved} — or enter another address above.`
      : "Serve this folder over http(s) (e.g. `python3 -m http.server 8080`) to enable the OAuth redirect.";
  }
}

function fillConfigForm() {
  document.getElementById("client-id").value = state.config.clientId;
  document.getElementById("client-secret").value = state.config.clientSecret;
  document.getElementById("redirect-uri").value = state.config.redirectUri;
  renderRedirectHint();
}

async function onConnectSubmit(event) {
  event.preventDefault();

  state.config.clientId = document.getElementById("client-id").value.trim();
  state.config.clientSecret = document.getElementById("client-secret").value.trim();
  state.config.redirectUri = document.getElementById("redirect-uri").value.trim();
  state.config.save();

  if (!state.config.clientId) {
    showStatus("A Client ID is required. Register an app on SoundCloud first.", "error");
    return;
  }
  if (!state.config.clientSecret) {
    showStatus("Heads up: SoundCloud treats apps as confidential clients — if the next step fails with \"invalid_client\", add your Client Secret and retry.");
  }
  const redirectUri = state.config.resolveRedirectUri();
  if (!redirectUri) {
    showStatus("OAuth needs an http(s) redirect URI. Serve the folder over http and reload.", "error");
    return;
  }
  if (!redirectUri.startsWith("http://") && !redirectUri.startsWith("https://")) {
    showStatus(`Invalid redirect URI: ${redirectUri}`, "error");
    return;
  }

  const button = document.getElementById("connect");
  button.disabled = true;
  button.textContent = "Redirecting to SoundCloud…";

  // Keep PKCE state in sessionStorage, then send the user to SoundCloud.
  const authUrl = await buildAuthUrl(state.config);
  window.location.href = authUrl;
}

// ---------------------------------------------------------------------------
// OAuth callback handling
// ---------------------------------------------------------------------------

async function handleOAuthCallback({ code, state: receivedState, error }) {
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

/** Drop ?code&state from the address bar so a reload cannot re-exchange a used code. */
function removeCallbackFromUrl() {
  const url = new URL(window.location.href);
  url.search = "";
  history.replaceState(null, "", url);
}

// ---------------------------------------------------------------------------
// Session: refresh, profile, playlists
// ---------------------------------------------------------------------------

async function ensureValidToken() {
  if (state.tokens.isFresh()) return;
  if (!state.tokens.canRefresh()) {
    const reason = state.tokens.hasAccessToken()
      ? "no refresh token was issued for this session"
      : "no access token is stored";
    throw new Error(reason);
  }
  showStatus("Refreshing SoundCloud session…");
  const body = await exchangeRefresh();
  state.tokens.update(body);
  console.info("[session] refreshed token fields:", Object.keys(body));
}

async function exchangeRefresh() {
  const body = await refreshAccessToken({ refreshToken: state.tokens.refreshToken, config: state.config });
  if (!body.access_token) throw new Error("Refresh response missing access_token.");
  return body;
}

async function loadUser() {
  state.user = await state.api.me();
  UserStore.save(state.user);
  renderUser();
}

async function loadPlaylists() {
  showStatus("Loading your playlists…");
  const playlists = await state.api.myPlaylists();
  state.playlists = playlists;
  clearStatus();
  renderPlaylistControls();
  renderPlaylists();
}

async function enterApp() {
  dbg(`[enterApp] ${tokenSummary()}`);
  showScreen("playlists");
  state.api = new SoundCloudApi({
    getConfig: () => state.config,
    getTokens: () => state.tokens,
    updateTokens: (body) => state.tokens.update(body),
  });

  try {
    await ensureValidToken();
    await loadUser();
    await loadPlaylists();
    dbg(`[enterApp] success — ${state.playlists.length} playlists loaded`);
  } catch (err) {
    dbg(`[enterApp] failed: ${err.message} — ${tokenSummary()}`);
    // Keep the stored tokens for troubleshooting; never silently destroy the
    // session here (a transient error must not force a full reconnect).
    showScreen("connect");
    showStatus(`Could not restore your session: ${err.message}. Connect again.`, "error");
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderUser() {
  if (!state.user) return;
  document.getElementById("user-area").hidden = false;
  const avatar = document.getElementById("user-avatar");
  if (state.user.avatar_url) avatar.src = state.user.avatar_url;
  document.getElementById("user-name").textContent = state.user.username;
}

function renderPlaylistControls() {
  const select = document.getElementById("type-filter");
  const types = [...new Set(state.playlists.map(playlistBucket))].sort();
  select.innerHTML = `<option value="">All types</option>` +
    types.map((type) => `<option value="${escapeHtml(type)}">${escapeHtml(TYPE_LABELS[type] ?? type)}</option>`).join("");
}

function visiblePlaylists() {
  const query = document.getElementById("search").value.trim().toLowerCase();
  const type = document.getElementById("type-filter").value;
  const sort = document.getElementById("sort").value;

  const playlists = state.playlists.filter((playlist) => {
    const matchesQuery = !query || playlist.title?.toLowerCase().includes(query);
    const matchesType = !type || playlistBucket(playlist) === type;
    return matchesQuery && matchesType;
  });

  const by = {
    updated: (a, b) => new Date(b.last_modified ?? b.created_at) - new Date(a.last_modified ?? a.created_at),
    name: (a, b) => (a.title ?? "").localeCompare(b.title ?? ""),
    tracks: (a, b) => (b.track_count ?? 0) - (a.track_count ?? 0),
    likes: (a, b) => (b.likes_count ?? 0) - (a.likes_count ?? 0),
  }[sort] ?? (() => 0);

  return playlists.sort(by);
}

function renderPlaylists() {
  const list = document.getElementById("playlist-list");
  const visible = visiblePlaylists();
  document.getElementById("summary").textContent =
    `${visible.length} playlist${visible.length === 1 ? "" : "s"} · ${state.playlists.length} total`;

  if (visible.length === 0) {
    list.innerHTML = `<li class="empty-state">No playlists match your filters.`;
    return;
  }

  list.innerHTML = visible.map(cardFor).join("");
}

function cardFor(playlist) {
  const type = playlistBucket(playlist);
  const typeLabel = TYPE_LABELS[type] ?? type;

  const artwork = playlist.artwork_url
    ? `<div class="artwork"><img src="${escapeHtml(playlist.artwork_url)}" alt="" loading="lazy" /></div>`
    : `<div class="artwork-placeholder">${escapeHtml((playlist.title ?? "?").trim().charAt(0).toUpperCase() || "♪")}</div>`;

  const badges = [`<span class="badge type-${escapeHtml(type)}">${escapeHtml(typeLabel)}</span>`];
  if (playlist.sharing === "private") {
    badges.push(`<span class="badge type-private">Private</span>`);
  }

  const updatedAt = playlist.last_modified ?? playlist.created_at;
  const metaLines = [
    `<span>${formatCount(playlist.track_count ?? 0)} tracks</span>`,
    `<span>${formatCount(playlist.likes_count)} likes</span>`,
    updatedAt ? `<span>Updated ${formatDate(updatedAt)}</span>` : "",
  ].filter(Boolean).join("");

  const description = playlist.description
    ? `<p class="muted card-desc">${escapeHtml(playlist.description.length > 120 ? playlist.description.slice(0, 120) + "…" : playlist.description)}</p>`
    : "";

  return `<li>
    ${artwork}
    <div class="card-body">
      <h3 class="card-title" title="${escapeHtml(playlist.title)}">${escapeHtml(playlist.title)}</h3>
      <div class="badges">${badges.join("")}</div>
      ${description}
      <div class="meta">${metaLines}</div>
      <div class="card-actions">
        <a href="${escapeHtml(playlist.permalink_url)}" target="_blank" rel="noreferrer">Open on SoundCloud →</a>
      </div>
    </div>
  </li>`;
}

// ---------------------------------------------------------------------------
// Sign out
// ---------------------------------------------------------------------------

function signOut() {
  if (!confirm("Sign out and forget the stored SoundCloud token?")) return;
  state.tokens.clear();
  UserStore.clear();
  state.tokens = TokenStore.load();
  state.user = null;
  state.playlists = [];
  document.getElementById("user-area").hidden = true;
  clearStatus();
  showScreen("connect");
}

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

function initListeners() {
  document.getElementById("config-form").addEventListener("submit", onConnectSubmit);
  document.getElementById("sign-out").addEventListener("click", signOut);
  document.getElementById("search").addEventListener("input", renderPlaylists);
  document.getElementById("type-filter").addEventListener("change", renderPlaylists);
  document.getElementById("sort").addEventListener("change", renderPlaylists);
}

function init() {
  initListeners();
  fillConfigForm();
  renderDebugPanel();

  // Surface unexpected runtime errors in the on-page log as well.
  window.addEventListener("error", (event) => dbg(`[page error] ${event.message}`));
  window.addEventListener("unhandledrejection", (event) => dbg(`[page rejection] ${event.reason?.message ?? event.reason}`));

  const query = new URLSearchParams(window.location.search);
  const callback = { code: query.get("code"), state: query.get("state"), error: query.get("error") };

  if (callback.code || callback.error) {
    dbg(`[init] callback present — code=${Boolean(callback.code)} error=${callback.error ?? ""} ${tokenSummary()}`);
    void handleOAuthCallback(callback);
    return;
    // eslint-disable-next-line no-unreachable
  }

  dbg(`[init] no callback — ${tokenSummary()} configComplete=${state.config.isComplete()}`);
  if (state.config.isComplete() && state.tokens.hasAccessToken()) {
    if (state.tokens.isFresh() || state.tokens.canRefresh()) {
      void enterApp();
    } else {
      showScreen("connect");
      showStatus("Your stored session expired and cannot be restored — please connect again.", "error");
    }
  } else if (state.config.isComplete()) {
    showStatus("Not connected yet — click “Connect with SoundCloud” to sign in.");
    showScreen("connect");
  } else {
    showScreen("connect");
  }
}

init();