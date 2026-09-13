/**
 * Playlist Updater — app controller.
 * Connects to SoundCloud (OAuth 2.1 + PKCE, all client-side) and lists
 * the authenticated user's playlists.
 */

import { AppConfig, TokenStore, UserStore } from "./config.js";
import { buildAuthUrl, exchangeCode, refreshAccessToken, validateState } from "./oauth.js";
import { SoundCloudApi } from "./api.js";
import { escapeHtml, formatCount, formatDate, formatDuration, playlistBucket } from "./util.js";

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
  tracks: [],
  tracksLoaded: false,
  tracksError: "",
  currentPlaylist: null,
  preview: { trackId: null, playing: false, loading: false, objectUrl: null, mode: "start", blob: null, peakOffset: null },
  playlistsLoading: false,
  user: UserStore.load(),
};

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

const screens = {
  connect: document.getElementById("connect-screen"),
  playlists: document.getElementById("playlists-screen"),
  playlist: document.getElementById("playlist-screen"),
};

function showScreen(name) {
  for (const screenKey of Object.keys(screens)) {
    screens[screenKey].hidden = screenKey !== name;
  }
}

function showStatus(message, kind = "loading") {
  const bar = document.getElementById("status-bar");
  bar.hidden = false;
  bar.className = kind ? `status-bar ${kind}` : "status-bar";
  bar.innerHTML = kind === "loading"
    ? `<span class="spinner" aria-hidden="true"></span>${escapeHtml(message)}`
    : escapeHtml(message);
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
    showStatus("Heads up: SoundCloud treats apps as confidential clients — if the next step fails with \"invalid_client\", add your Client Secret and retry.", "info");
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
  state.playlistsLoading = true;
  showScreen("playlists");
  renderPlaylists();
  showStatus("Loading your playlists…");
  try {
    state.playlists = await state.api.myPlaylists();
  } finally {
    state.playlistsLoading = false;
  }
  clearStatus();
  renderPlaylistControls();
  renderPlaylists();
}

async function enterApp() {
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

// ---------------------------------------------------------------------------
// Playlist detail (navigates via `#/playlist/<id>` for back/forward support)
// ---------------------------------------------------------------------------

/** The playlist id encoded in the URL hash, or null when no playlist is open. */
function playlistIdFromHash() {
  const match = window.location.hash.match(/^#\/playlist\/(.+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

/** Decide which content to show from the current URL hash. */
function route() {
  if (!state.api) return; // not signed in: leave the screen alone
  const id = playlistIdFromHash();
  if (id) {
    if (String(state.currentPlaylist?.id) === id) {
      // Same playlist already open (browser back/forward): redraw from state.
      renderPlaylist();
    } else {
      void openPlaylist(id);
    }
    return;
  }
  resetPlaylistView();
  showScreen("playlists");
}

function resetPlaylistView() {
  stopPreview();
  state.currentPlaylist = null;
  state.tracks = [];
  state.tracksLoaded = false;
  state.tracksError = "";
}

/** Open a playlist (by numeric id) and fetch + render its tracks. */
async function openPlaylist(id) {
  const playlist = state.playlists.find((p) => String(p.id) === String(id));
  if (!playlist) {
    showStatus("That playlist is no longer in your list.", "error");
    history.replaceState(null, "", window.location.pathname);
    showScreen("playlists");
    return;
  }

  state.currentPlaylist = playlist;
  state.tracks = [];
  state.tracksLoaded = false;
  state.tracksError = "";
  stopPreview();
  // Keep the URL in sync without re-triggering route() (replaceState is silent).
  if (playlistIdFromHash() !== String(id)) {
    history.replaceState(null, "", `#/playlist/${id}`);
  }

  showScreen("playlist");
  renderPlaylistHeader();
  renderTrackList();
  clearStatus();

  showStatus("Loading tracks…");
  try {
    state.tracks = await state.api.playlistTracks(id);
    state.tracksLoaded = true;
    clearStatus();
  } catch (err) {
    state.tracksLoaded = true;
    state.tracksError = err.message;
    showStatus(`Could not load the track list: ${err.message}`, "error");
  }
  renderTrackList();
}

function goBackToPlaylists() {
  window.location.hash = "#/playlists";
}

// ---------------------------------------------------------------------------
// Track preview (one hidden <audio>, play/pause per row)
// ---------------------------------------------------------------------------

/** Skip the (expensive) loudness decode on very long tracks. */
const PEAK_SCAN_MAX_MS = 8 * 60 * 1000;

/**
 * Glyphs + classes for the two preview buttons of a track row. The button
 * matching the active preview's mode shows ▶/⏸; the other one is inert.
 */
function previewButtonFor(track, mode) {
  const p = state.preview;
  const isMine = p.trackId === track.id;
  const isActive = isMine && !p.loading && p.mode === mode;
  const glyph = isActive && p.playing ? "⏸" : mode === "peak" ? "⏫" : "▶";
  const isLoading = isMine && p.loading && p.mode === mode;
  const classes = ["track-preview", isMine && p.mode === mode ? "is-active" : "", isLoading ? "is-loading" : ""].filter(Boolean).join(" ");
  const content = isLoading ? `<span class="spinner" aria-hidden="true"></span>` : glyph;
  const label = mode === "peak" ? "Play from the loudest part" : "Play from the start";
  return `<button class="${classes}" type="button" data-preview-track="${track.id}" data-preview-mode="${mode}" title="${label}" aria-label="${label} of ${escapeHtml(track.title ?? "track")}">${content}</button>`;
}

async function togglePreview(trackId, mode = "start") {
  const p = state.preview;
  const audio = document.getElementById("preview-audio");

  if (p.trackId === trackId && !p.loading) {
    if (mode === p.mode) {
      // Same button: pause / resume.
      if (p.playing) {
        audio.pause();
        p.playing = false;
      } else {
        p.playing = true;
        try {
          await audio.play();
        } catch {
          p.playing = false; // playback blocked (e.g. autoplay policy)
        }
      }
      renderTrackList();
      return;
    }
    // Other button on the active row: jump within the already-loaded audio.
    p.mode = mode;
    p.playing = false;
    p.loading = true;
    renderTrackList();
    const offset = mode === "peak" ? (await ensurePeakOffset(trackId)) ?? 0 : 0;
    p.loading = false;
    if (offset > 0) audio.currentTime = offset;
    p.playing = true;
    try {
      await audio.play();
    } catch {
      p.playing = false; // playback blocked (e.g. autoplay policy)
    }
    renderTrackList();
    return;
  }
  if (p.trackId !== null) stopPreview();

  const track = state.tracks.find((t) => t.id === trackId);
  if (!track) return;

  p.trackId = trackId;
  p.mode = mode;
  p.blob = null;
  p.peakOffset = null;
  p.loading = true;
  renderTrackList();
  showStatus(`Loading preview of “${track.title}”…`);

  try {
    const source = await state.api.previewSource(track, {
      onRaw: (streams) => dbg(`[preview] streams raw: ${JSON.stringify(streams).slice(0, 800)}`),
      onError: (err) => dbg(`[preview] streams failed: ${err.message}`),
    });
    if (!source || (!source.blob && !source.url)) throw new Error("this track has no playable preview");

    // Stream URLs live on api.soundcloud.com and require the OAuth header,
    // which a bare <audio> cannot send — play from a downloaded Blob (full
    // track, direct mp3 or concatenated HLS) whenever possible.
    let src;
    if (source.blob) {
      src = URL.createObjectURL(source.blob);
      dbg(`[preview] downloaded ${source.blob.size} bytes (${source.kind}) from ${source.url}`);
    } else {
      src = source.url;
      dbg(`[preview] no blob (${source.kind}) — trying direct src: ${source.url}`);
    }

    revokePreviewObjectUrl();
    p.objectUrl = source.blob ? src : null;
    p.blob = source.blob ?? null;
    p.peakOffset = null;
    audio.src = src;
    p.loading = false;
    await waitForMetadata(audio);
    if (p.trackId !== trackId) return; // user switched away while loading

    // "Peak" starts full-length previews at their loudest window; anything
    // else (and any non-full source) simply starts at the beginning.
    let offset = 0;
    if (p.mode === "peak") {
      if (source.kind === "full") {
        offset = (await ensurePeakOffset(trackId)) ?? 0;
      } else {
        dbg(`[preview] peak unavailable for ${source.kind} source — starting at 0`);
      }
    }
    if (p.trackId !== trackId) return; // user switched away during the scan
    if (offset > 0) {
      audio.currentTime = offset;
      dbg(`[preview] starting at ${offset.toFixed(1)} s`);
    }
    clearStatus();
    try {
      await audio.play();
    } catch {
      /* blocked: the button stays visible, retry on next click */
    }
    p.playing = !audio.paused;
  } catch (err) {
    p.trackId = null;
    p.loading = false;
    dbg(`[preview] failed: ${err.message}`);
    showStatus(`Preview failed: ${err.message}`, "error");
  }
  renderTrackList();
}

/** Seconds offset of the loudest window for the loaded preview, cached. */
async function ensurePeakOffset(trackId) {
  const p = state.preview;
  if (p.trackId !== trackId) return null; // switched away meanwhile
  if (p.peakOffset !== null || !p.blob) return p.peakOffset;
  const track = state.tracks.find((t) => t.id === trackId);
  p.peakOffset = track ? await loudestOffsetSeconds(p.blob, track) : null;
  return p.peakOffset;
}

/** Resolve when the element has metadata; rejects when loading errors out. */
function waitForMetadata(audio) {
  if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) return Promise.resolve();
  return new Promise((resolve, reject) => {
    audio.addEventListener("loadedmetadata", resolve, { once: true });
    audio.addEventListener("error", () => reject(new Error("the audio element could not load the stream")), { once: true });
  });
}

/**
 * Seconds offset of the loudest 1-second window in a downloaded mp3 blob
 * (cheap RMS scan over one channel). Returns null when the track is too
 * long to decode comfortably or the decode fails.
 */
async function loudestOffsetSeconds(blob, track) {
  if ((track.duration ?? 0) > PEAK_SCAN_MAX_MS) return null;
  let context;
  try {
    context = new AudioContext();
    const buffer = await context.decodeAudioData(await blob.arrayBuffer());
    const samples = buffer.getChannelData(0);
    const windowSize = buffer.sampleRate;
    const stride = Math.max(1, Math.floor(windowSize / 500));
    let peakOffset = 0;
    let peakRms = -1;
    for (let start = 0; start + windowSize <= samples.length; start += windowSize) {
      let sumSquares = 0;
      let count = 0;
      for (let i = start; i < start + windowSize; i += stride) {
        sumSquares += samples[i] * samples[i];
        count += 1;
      }
      const rms = sumSquares / Math.max(1, count);
      if (rms > peakRms) {
        peakRms = rms;
        peakOffset = start / buffer.sampleRate;
      }
    }
    return peakOffset;
  } catch {
    return null; // start from the beginning instead
  } finally {
    context?.close();
  }
}

/** Free the blob backing the current preview, if any. */
function revokePreviewObjectUrl() {
  if (state.preview.objectUrl) {
    URL.revokeObjectURL(state.preview.objectUrl);
    state.preview.objectUrl = null;
  }
}

function stopPreview() {
  const audio = document.getElementById("preview-audio");
  audio.pause();
  audio.removeAttribute("src");
  audio.load(); // reset the element so the emptied src cannot fire error events
  revokePreviewObjectUrl();
  state.preview.trackId = null;
  state.preview.playing = false;
  state.preview.loading = false;
  state.preview.mode = "start";
  state.preview.blob = null;
  state.preview.peakOffset = null;
}

function updatePreviewTime() {
  const p = state.preview;
  if (p.trackId === null) return;
  const audio = document.getElementById("preview-audio");
  const span = document.querySelector(`[data-track-time="${p.trackId}"]`);
  if (!span) return;
  const current = Number.isFinite(audio.currentTime) ? audio.currentTime * 1000 : 0;
  const total = Number.isFinite(audio.duration) ? audio.duration * 1000 : 0;
  // Keep the baked-in duration until metadata has loaded (total > 0).
  if (total <= 0) return;
  span.textContent = `${formatDuration(current)} / ${formatDuration(total)}`;
  span.classList.toggle("is-live", p.playing);
}

function onTrackListClick(event) {
  const button = event.target.closest("[data-preview-track]");
  if (button) {
    void togglePreview(Number(button.dataset.previewTrack), button.dataset.previewMode ?? "start");
  }
}

function onPreviewEnded() {
  state.preview.playing = false;
  renderTrackList();
}

function onPreviewError() {
  const src = document.getElementById("preview-audio").src;
  dbg(`[preview] audio error on ${src.slice(0, 140)}${src.length > 140 ? "…" : ""}`);
  if (state.preview.trackId === null) return;
  stopPreview();
  showStatus("Preview failed to load — this track may only offer HLS streaming, which this browser cannot play directly.", "error");
  renderTrackList();
}

/** Cards are clickable, except the external SoundCloud links. */
function onPlaylistListClick(event) {
  if (event.target.closest("a")) return;
  const card = event.target.closest("li[data-playlist-id]");
  if (card) window.location.hash = `#/playlist/${card.dataset.playlistId}`;
}

function renderPlaylist() {
  if (!state.currentPlaylist) return;
  renderPlaylistHeader();
  renderTrackList();
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

  if (state.playlistsLoading) {
    list.innerHTML = `<li class="empty-state"><span class="spinner" aria-hidden="true"></span>Loading your playlists…</li>`;
    return;
  }
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

  return `<li data-playlist-id="${playlist.id}" title="View the tracks in this playlist">
    ${artwork}
    <div class="card-body">
      <h3 class="card-title" title="${escapeHtml(playlist.title)}">${escapeHtml(playlist.title)}</h3>
      <div class="badges">${badges.join("")}</div>
      ${description}
      <div class="meta">${metaLines}</div>
      <div class="card-actions">
        <button class="button card-open" type="button" data-open-playlist>View tracks</button>
        <a href="${escapeHtml(playlist.permalink_url)}" target="_blank" rel="noreferrer" title="Open on SoundCloud">SoundCloud ↗</a>
      </div>
    </div>
  </li>`;
}

function renderPlaylistHeader() {
  const playlist = state.currentPlaylist;
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
    ? `<p class="muted playlist-desc">${escapeHtml(playlist.description)}</p>`
    : "";

  document.getElementById("playlist-header").innerHTML = `
    <div class="playlist-header-art">${artwork}</div>
    <div class="playlist-header-body">
      <h2 class="playlist-title">${escapeHtml(playlist.title)}</h2>
      <div class="badges">${badges.join("")}</div>
      ${description}
      <div class="meta">${metaLines}</div>
      <p class="playlist-link"><a href="${escapeHtml(playlist.permalink_url)}" target="_blank" rel="noreferrer">Open on SoundCloud →</a></p>
    </div>`;
}

function renderTrackList() {
  const list = document.getElementById("track-list");
  const summary = document.getElementById("track-summary");
  const tracks = state.tracks;

  if (!state.tracksLoaded) {
    list.innerHTML = `<li class="empty-state"><span class="spinner" aria-hidden="true"></span>Loading tracks…</li>`;
    return;
  }
  if (state.tracksError) {
    list.innerHTML = `<li class="empty-state">Could not load the track list — see the message above.</li>`;
    return;
  }

  summary.textContent = tracks.length
    ? `${formatCount(tracks.length)} sound${tracks.length === 1 ? "" : "s"} in this playlist`
    : "";

  if (tracks.length === 0) {
    list.innerHTML = `<li class="empty-state">This playlist has no sounds (yet).</li>`;
    return;
  }
  list.innerHTML = tracks.map(trackRowFor).join("");
  updatePreviewTime();
}

function trackRowFor(track, index) {
  const letter = (track.title ?? "?").trim().charAt(0).toUpperCase() || "♪";
  const artwork = track.artwork_url
    ? `<div class="track-art"><img src="${escapeHtml(track.artwork_url)}" alt="" loading="lazy" /></div>`
    : `<div class="track-art track-art-placeholder">${escapeHtml(letter)}</div>`;

  const byLine = [track.user?.username, track.genre].filter(Boolean).join(" · ");
  const title = escapeHtml(track.title ?? "Untitled");
  const permalink = escapeHtml(track.permalink_url);

  const previewLoading = state.preview.trackId === track.id && state.preview.loading;
  const previewClass = [
    "track-preview",
    state.preview.trackId === track.id ? "is-active" : "",
    previewLoading ? "is-loading" : "",
  ].filter(Boolean).join(" ");
  const previewContent = previewLoading
    ? `<span class="spinner" aria-hidden="true"></span>`
    : previewGlyph(track.id);

  return `<li class="track-row">
    <span class="track-index">${index + 1}</span>
    ${artwork}
    <div class="track-body">
      <a class="track-title" href="${permalink}" target="_blank" rel="noreferrer">${title}</a>
      ${byLine ? `<p class="muted track-sub">${escapeHtml(byLine)}</p>` : ""}
    </div>
    <div class="track-meta">
      <span class="track-time" data-track-time="${track.id}">${formatDuration(track.duration)}</span>
      <span>${formatCount(track.playback_count)} plays</span>
      <span>${formatCount(track.likes_count ?? track.favoritings_count)} likes</span>
    </div>
    <span class="track-preview-group">${previewButtonFor(track, "start")}${previewButtonFor(track, "peak")}</span>
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
  stopPreview();
  history.replaceState(null, "", window.location.pathname);
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
  document.getElementById("back-to-playlists").addEventListener("click", goBackToPlaylists);
  document.getElementById("playlist-list").addEventListener("click", onPlaylistListClick);
  document.getElementById("track-list").addEventListener("click", onTrackListClick);
  const previewAudio = document.getElementById("preview-audio");
  previewAudio.addEventListener("ended", onPreviewEnded);
  previewAudio.addEventListener("error", onPreviewError);
  previewAudio.addEventListener("timeupdate", updatePreviewTime);
  window.addEventListener("hashchange", route);
}

function init() {
  initListeners();
  fillConfigForm();
  renderDebugPanel();
  // Mirrors every API request into the on-page troubleshooting log (visible
  // on the connect screen) — status codes, URLs and failure bodies.
  SoundCloudApi.logger = (message) => dbg(message);

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
    showStatus("Not connected yet — click “Connect with SoundCloud” to sign in.", "info");
    showScreen("connect");
  } else {
    showScreen("connect");
  }
}

init();