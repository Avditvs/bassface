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
  trackPager: null,
  tracksLoadingMore: false,
  currentPlaylist: null,
  preview: { trackId: null, playing: false, loading: false, objectUrl: null, mode: "start", blob: null, peakOffset: null, pendingSeekSec: null, originSec: null, jump: null, extending: false },
  waveforms: new Map(), // track id → loudness bars (empty array = unavailable)
  waveformInflight: new Map(), // track id → in-flight waveform load
  playlistsLoading: false,
  page: 1,
  pageSize: 24,
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
  state.page = 1;
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
  forgetTrackSentinel();
  state.currentPlaylist = null;
  state.tracks = [];
  state.tracksLoaded = false;
  state.tracksError = "";
  state.trackPager = null;
  state.tracksLoadingMore = false;
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
  state.trackPager = null;
  state.tracksLoadingMore = false;
  stopPreview();
  forgetTrackSentinel();
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
    const pager = state.api.createPlaylistTracksPager(id);
    const firstPage = await pager.next();
    // A faster navigation may have opened another playlist meanwhile.
    if (String(state.currentPlaylist?.id) !== String(id)) return;
    state.trackPager = pager;
    state.tracks = firstPage ?? [];
    state.tracksLoaded = true;
    clearStatus();
  } catch (err) {
    state.tracksLoaded = true;
    state.tracksError = err.message;
    showStatus(`Could not load the track list: ${err.message}`, "error");
  }
  renderTrackList();
}

// ---------------------------------------------------------------------------
// Infinite scroll for the track list (load more as the sentinel nears view)
// ---------------------------------------------------------------------------

let trackSentinelObserver = null;

/** Fetch the next track page and append it to the rendered list. */
async function loadMoreTracks() {
  const pager = state.trackPager;
  if (!pager || pager.done || state.tracksLoadingMore || state.tracksError) return;
  state.tracksLoadingMore = true;
  try {
    const batch = await pager.next();
    if (batch) state.tracks.push(...batch);
  } catch (err) {
    dbg(`[tracks] load-more failed: ${err.message}`);
    showStatus(`Could not load more tracks: ${err.message}`, "error");
  } finally {
    state.tracksLoadingMore = false;
  }
  renderTrackList();
}

/** Watch the sentinel row at the end of the list; fetches when it nears view. */
function observeTrackSentinel() {
  const sentinel = document.getElementById("track-sentinel");
  if (!sentinel) return;
  if (!trackSentinelObserver) {
    trackSentinelObserver = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loadMoreTracks();
      },
      { rootMargin: "600px 0px" }, // start fetching before the user arrives
    );
  }
  trackSentinelObserver.disconnect();
  trackSentinelObserver.observe(sentinel);
}

/** Drop the sentinel observer (leaving a playlist / clearing the view). */
function forgetTrackSentinel() {
  trackSentinelObserver?.disconnect();
}

function goBackToPlaylists() {
  window.location.hash = "#/playlists";
}

// ---------------------------------------------------------------------------
// Track preview (one hidden <audio>, play/pause per row)
// ---------------------------------------------------------------------------

/** Skip the (expensive) loudness decode on very long tracks. */
const PEAK_SCAN_MAX_MS = 8 * 60 * 1000;

/** Loudness needs nowhere near 48 kHz — decoding low-rate is ~6× cheaper. */
const PEAK_SCAN_SAMPLE_RATE = 8000;

/** Never scan more segments than the old truncated-blob behaviour fetched. */
const HLS_SCAN_MAX_SEGMENTS = 120;

/** Cap how much audio one waveform jump may download in total (~10 min). */
const JUMP_MAX_SEGMENTS = 60;

/** Segments fetched per jump window — kept small to limit requests. */
const JUMP_WINDOW = 8;

/** Start extending the jump window when less audio remains than this. */
const EXTEND_AHEAD_SEC = 30;

/**
 * Loudest 1-second window of a decoded buffer, via a cumulative-energy
 * prefix sum: one O(n) pass, then every window's energy in O(1) — the exact
 * global maximum, no block-by-block nested scan. Returns {rms, offsetSec}.
 */
function loudestWindow(buffer) {
  const samples = buffer.getChannelData(0);
  const windowSize = buffer.sampleRate;
  if (samples.length < windowSize) return samples.length > 0 ? { rms: 0, offsetSec: 0 } : null;
  const stride = Math.max(1, Math.floor(windowSize / 250)); // 250 points per window
  const count = Math.floor(samples.length / stride);
  const cum = new Float64Array(count + 1);
  for (let k = 0; k < count; k += 1) {
    const s = samples[k * stride];
    cum[k + 1] = cum[k] + s * s;
  }
  const win = Math.max(1, Math.floor(windowSize / stride)); // strided points per 1 s
  let bestK = 0;
  let bestE = -1;
  for (let k = 0; k + win <= count; k += 1) {
    const energy = cum[k + win] - cum[k];
    if (energy > bestE) {
      bestE = energy;
      bestK = k;
    }
  }
  return { rms: bestE / win, offsetSec: (bestK * stride) / buffer.sampleRate };
}

/**
 * Index of the segment containing the given offset (from m3u8 durations).
 */
function segmentIndexAt(segments, offsetSec) {
  let startSec = 0;
  for (const [index, segment] of segments.entries()) {
    const endSec = startSec + (segment.duration || 0);
    if (offsetSec < endSec || index === segments.length - 1) return { index, startSec };
    startSec = endSec;
  }
  return null;
}

/**
 * Coarse seconds offset of the centre of the loudest ~1-second window,
 * computed from SoundCloud's waveform metadata — no audio download.
 * Returns null when no usable waveform is available.
 */
async function waveformPeakOffset(track) {
  const samples = await state.api.waveformSamples(track);
  if (!samples || !(track.duration > 0)) return null;
  const perSampleSec = track.duration / 1000 / samples.length;
  const cum = new Float64Array(samples.length + 1);
  for (let k = 0; k < samples.length; k += 1) {
    const s = Number(samples[k]) || 0;
    cum[k + 1] = cum[k] + s * s;
  }
  const win = Math.max(1, Math.round(1 / perSampleSec)); // ~1 s of samples
  let bestK = 0;
  let bestE = -1;
  for (let k = 0; k + win <= samples.length; k += 1) {
    const energy = cum[k + win] - cum[k];
    if (energy > bestE) {
      bestE = energy;
      bestK = k;
    }
  }
  const offset = (bestK + win / 2) * perSampleSec;
  dbg(`[preview] waveform coarse peak at ${offset.toFixed(1)} s`);
  return offset;
}

/**
 * Waveform-guided peak: decode only the two segments around the coarse
 * waveform candidate and keep the true loudest 1-second window among them.
 * Returns the same shape as loadHlsPeak, or null when it fails.
 */
async function waveformGuidedPeak(segments, coarseSec, { onError = null } = {}) {
  const at = segmentIndexAt(segments, coarseSec);
  if (!at) return null;
  // Cumulative start time of every segment, to report the blob's origin.
  const starts = [];
  let acc = 0;
  for (const segment of segments) {
    starts.push(acc);
    acc += segment.duration || 0;
  }
  let context;
  try {
    try {
      context = new AudioContext({ sampleRate: PEAK_SCAN_SAMPLE_RATE });
    } catch {
      context = new AudioContext(); // low rate not supported: default quality
    }
    let best = null; // { index, offsetSec, rms, blob }
    const last = Math.min(segments.length - 1, at.index + 1);
    for (let index = at.index; index <= last; index += 1) {
      let blob;
      try {
        blob = await state.api.fetchSegment(segments[index].url);
      } catch (err) {
        dbg(`[preview] hls segment ${index} failed: ${err.message}`);
        continue;
      }
      const buffer = await context.decodeAudioData(await blob.arrayBuffer());
      const window = loudestWindow(buffer);
      if (window && (!best || window.rms > best.rms)) {
        best = { index, offsetSec: window.offsetSec, rms: window.rms, blob, originSec: starts[index] };
      }
    }
    if (!best) return null;

    // Keep the winning segment plus the next one, so playback continues
    // past the segment boundary instead of stopping abruptly.
    const parts = [best.blob];
    if (segments[best.index + 1]) {
      try {
        parts.push(await state.api.fetchSegment(segments[best.index + 1].url));
      } catch { /* winner alone is fine */ }
    }
    dbg(`[preview] hls peak: segment ${best.index} @ ${best.offsetSec.toFixed(1)} s (waveform-guided)`);
    return {
      blob: new Blob(parts, { type: "audio/mpeg" }),
      url: segments[best.index].url,
      kind: "full",
      peakOffset: best.offsetSec,
      originSec: best.originSec,
    };
  } catch (err) {
    onError?.(err);
    return null;
  } finally {
    context?.close();
  }
}

/**
 * Full-track preview for the ⏫ button via HLS, jumping straight to the
 * loudest part. Coarse pass from the waveform metadata (a few KB, no
 * audio), then only the segments around the candidate are decoded; the
 * full segment scan below is the fallback when no waveform is available.
 * Returns { blob, url, kind: "full", peakOffset } or null when the track
 * offers no HLS mp3 stream (the caller falls back to previewSource).
 */
async function loadHlsPeak(track, { onRaw = null, onError = null } = {}) {
  let segments;
  try {
    segments = await state.api.hlsSegments(track, { onRaw, onError });
  } catch (err) {
    onError?.(err);
    return null;
  }
  if (!segments) return null;

  const coarseSec = await waveformPeakOffset(track);
  if (coarseSec !== null) {
    const guided = await waveformGuidedPeak(segments, coarseSec, { onError });
    if (guided) return guided;
    dbg("[preview] hls peak: waveform-guided scan failed — falling back to full scan");
  }
  dbg(`[preview] hls peak: scanning ${segments.length} segments`);

  let context;
  try {
    try {
      context = new AudioContext({ sampleRate: PEAK_SCAN_SAMPLE_RATE });
    } catch {
      context = new AudioContext(); // low rate not supported: default quality
    }
    let best = null; // { index, url, offsetSec, rms, blob }
    let startSec = 0;
    let scanned = 0;
    for (const [index, segment] of segments.entries()) {
      if (startSec * 1000 > PEAK_SCAN_MAX_MS || scanned >= HLS_SCAN_MAX_SEGMENTS) break;
      let blob;
      try {
        blob = await state.api.fetchSegment(segment.url);
      } catch (err) {
        dbg(`[preview] hls segment ${index} failed: ${err.message}`);
        continue;
      }
      scanned += 1;
      const buffer = await context.decodeAudioData(await blob.arrayBuffer());
      const window = loudestWindow(buffer);
      if (window && (!best || window.rms > best.rms)) {
        best = { index, url: segment.url, offsetSec: window.offsetSec, rms: window.rms, blob, originSec: startSec };
      }
      startSec += segment.duration || buffer.duration;
    }
    if (!best) return null;
    dbg(`[preview] hls peak: full scan done — ${scanned} segments scored`);

    // Keep the winning segment plus the next one, so playback continues
    // past the segment boundary instead of stopping abruptly.
    const parts = [best.blob];
    if (segments[best.index + 1]) {
      try {
        parts.push(await state.api.fetchSegment(segments[best.index + 1].url));
      } catch { /* winner alone is fine */ }
    }
    dbg(`[preview] hls peak: segment ${best.index} @ ${best.offsetSec.toFixed(1)} s`);
    return {
      blob: new Blob(parts, { type: "audio/mpeg" }),
      url: best.url,
      kind: "full",
      peakOffset: best.offsetSec,
      originSec: best.originSec,
    };
  } catch (err) {
    onError?.(err);
    return null;
  } finally {
    context?.close();
  }
}

/**
 * Full-track source for waveform jumps: HLS segments are downloaded from the
 * clicked position onward (bounded), so the Blob's audio really starts at the
 * requested time — unlike the peak source, which keeps only the loudest
 * segment. Returns { blob, url, kind: "full", seekOffset, originSec } where
 * seekOffset is where to start inside the Blob. Falls back to previewSource
 * (full mp3 → then the seek works; snippet → playback starts at 0).
 */
async function loadJumpSource(track, targetSec, { onRaw = null, onError = null } = {}) {
  let segments;
  try {
    segments = await state.api.hlsSegments(track, { onRaw, onError });
  } catch (err) {
    onError?.(err);
  }
  if (!segments) {
    const source = await state.api.previewSource(track, { mode: "peak", onRaw, onError });
    if (source && source.kind !== "full") dbg(`[preview] jump: only a ${source.kind} source exists — starting at 0`);
    return source;
  }
  const at = segmentIndexAt(segments, targetSec);
  if (!at) return null;
  const last = Math.min(segments.length - 1, at.index + JUMP_MAX_SEGMENTS - 1);
  const windowEnd = Math.min(last, at.index + JUMP_WINDOW - 1);
  // Cumulative start time of every segment, to place the blob on the timeline.
  const starts = [];
  let acc = 0;
  for (const segment of segments) {
    starts.push(acc);
    acc += segment.duration || 0;
  }
  // Fetch the first window in parallel: one request per segment, but all at
  // once, so playback can start quickly. Failed segments leave a hole (the
  // preview just skips them).
  const results = await Promise.allSettled(
    segments.slice(at.index, windowEnd + 1).map((segment) => state.api.fetchSegment(segment.url)),
  );
  const parts = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
  const originSec = starts[at.index + results.findIndex((r) => r.status === "fulfilled")];
  if (!parts.length) return null;
  dbg(`[preview] jump: ${parts.length} segments from ${originSec.toFixed(1)} s`);
  return {
    blob: new Blob(parts, { type: "audio/mpeg" }),
    url: segments[at.index].url,
    kind: "full",
    seekOffset: Math.max(0, targetSec - originSec),
    originSec,
    // Bookkeeping for extendJumpWindow(): more segments stream in as the
    // playhead approaches the end of the downloaded audio.
    jump: { segments, parts, nextIndex: windowEnd + 1, lastIndex: last },
  };
}

/**
 * Fetch the next jump window and hot-swap the playing blob when the playhead
 * gets close to the end of the downloaded audio (called from timeupdate).
 */
async function extendJumpWindow() {
  const p = state.preview;
  const audio = document.getElementById("preview-audio");
  if (p.mode !== "jump" || !p.jump || p.extending) return;
  const { segments, parts, nextIndex, lastIndex } = p.jump;
  if (nextIndex > lastIndex || parts.length === 0) return;
  if (!Number.isFinite(audio.duration) || audio.duration - audio.currentTime > EXTEND_AHEAD_SEC) return;
  p.extending = true;
  try {
    const end = Math.min(lastIndex, nextIndex + JUMP_WINDOW - 1);
    const results = await Promise.allSettled(
      segments.slice(nextIndex, end + 1).map((segment) => state.api.fetchSegment(segment.url)),
    );
    if (p.mode !== "jump" || !p.blob) return; // switched away meanwhile
    const fetched = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
    if (!fetched.length) return;
    parts.push(...fetched);
    p.jump.nextIndex = end + 1;
    // Swap in the extended blob without losing the playhead.
    const resumeAt = audio.currentTime;
    const wasPlaying = p.playing && !audio.paused;
    revokePreviewObjectUrl();
    p.objectUrl = URL.createObjectURL(new Blob(parts, { type: "audio/mpeg" }));
    audio.src = p.objectUrl;
    await waitForMetadata(audio);
    if (p.mode !== "jump") return; // switched away during the swap
    audio.currentTime = resumeAt;
    if (wasPlaying) {
      try { await audio.play(); } catch { /* retried on next click */ }
    }
    dbg(`[preview] jump window extended — ${parts.length} segments buffered`);
  } finally {
    p.extending = false;
  }
}

/**
 * Seconds offset of the loudest 1-second window in a downloaded mp3 blob
 * (fallback path when no HLS stream exists). Returns null when the track is
 * too long to decode comfortably or the decode fails.
 */
async function loudestOffsetSeconds(blob, track) {
  if ((track.duration ?? 0) > PEAK_SCAN_MAX_MS) return null;
  let context;
  try {
    try {
      context = new AudioContext({ sampleRate: PEAK_SCAN_SAMPLE_RATE });
    } catch {
      context = new AudioContext(); // low rate not supported: default quality
    }
    const buffer = await context.decodeAudioData(await blob.arrayBuffer());
    const window = loudestWindow(buffer);
    return window ? window.offsetSec : 0;
  } catch {
    return null; // start from the beginning instead
  } finally {
    context?.close();
  }
}

// ---------------------------------------------------------------------------
// Waveform display + click-to-jump (right of each track card)
// ---------------------------------------------------------------------------

/** Cap the drawn bars so very long waveforms stay cheap to paint. */
const WAVEFORM_MAX_BARS = 220;

/** Raw waveform samples → normalised (0-1) max-per-bucket bars. */
function normalizeWaveform(samples) {
  if (!Array.isArray(samples) || samples.length < 2) return [];
  const values = samples.map((s) => Number(s)).filter((v) => Number.isFinite(v) && v >= 0);
  const max = values.reduce((m, v) => Math.max(m, v), 0);
  if (!(max > 0)) return [];
  const bars = [];
  const bucket = Math.ceil(values.length / WAVEFORM_MAX_BARS);
  for (let i = 0; i < values.length; i += bucket) {
    bars.push(values.slice(i, i + bucket).reduce((m, v) => Math.max(m, v), 0) / max);
  }
  return bars;
}

/** Fetch the track's waveform metadata once; resolves to its bars (or []). */
function waveformBars(track) {
  if (state.waveforms.has(track.id)) return Promise.resolve(state.waveforms.get(track.id));
  if (state.waveformInflight.has(track.id)) return state.waveformInflight.get(track.id);
  const promise = state.api.waveformSamples(track)
    .then((samples) => {
      const bars = normalizeWaveform(samples);
      state.waveforms.set(track.id, bars);
      drawWaveform(track.id);
      return bars;
    })
    .catch(() => {
      state.waveforms.set(track.id, []);
      return [];
    })
    .finally(() => state.waveformInflight.delete(track.id));
  state.waveformInflight.set(track.id, promise);
  return promise;
}

/** Progress fraction (0-1) of the active preview, for the accent overlay. */
function waveformProgress(trackId) {
  const p = state.preview;
  if (p.trackId !== trackId || p.loading) return 0;
  const audio = document.getElementById("preview-audio");
  if (!Number.isFinite(audio.duration) || audio.duration <= 0) return 0;
  const track = state.tracks.find((t) => t.id === trackId);
  if (!track || !(track.duration > 0)) return 0;
  // Jump/peak blobs start mid-track: place the playhead on the full timeline.
  const originSec = p.originSec ?? 0;
  return Math.min(1, Math.max(0, (originSec + audio.currentTime) / (track.duration / 1000)));
}

/** Draw (or redraw) the cached waveform into the track's canvas. */
function drawWaveform(trackId) {
  const canvas = document.querySelector(`canvas[data-waveform-track="${trackId}"]`);
  if (!canvas || !state.waveforms.has(trackId)) return;
  const bars = state.waveforms.get(trackId);
  if (bars.length === 0) {
    canvas.classList.add("is-empty"); // no waveform available for this track
    return;
  }
  canvas.classList.remove("is-empty");
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!width || !height) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  const styles = getComputedStyle(document.documentElement);
  const base = styles.getPropertyValue("--muted").trim() || "#a6a6a6";
  const accent = styles.getPropertyValue("--accent").trim() || "#ff5500";
  const played = waveformProgress(trackId);

  // The bar count follows the canvas width: every bar gets exactly the same
  // slot (bar + 1px gap), so no bar is wider, narrower or shifted compared
  // to its neighbours, whatever the zoom or window size.
  const gap = 1;
  const unit = Math.max(3, Math.round(width / 90)); // bar+gap period in px
  const barW = unit - gap;
  const barCount = Math.max(1, Math.floor((width + gap) / unit));
  // Cached bars → barCount buckets (max within each bucket), so the shape
  // is preserved at every resolution.
  const values = [];
  for (let i = 0; i < barCount; i += 1) {
    const from = Math.floor((i * bars.length) / barCount);
    const to = Math.max(from + 1, Math.floor(((i + 1) * bars.length) / barCount));
    values.push(bars.slice(from, to).reduce((m, v) => Math.max(m, v), 0));
  }
  // Mirrored around the centre, on an even pixel height so both halves
  // match; a 2px floor keeps silent passages visible. The value is inverted
  // (loud → short, quiet → tall) for the inverted waveform look.
  const barH = (v) => Math.max(2, 2 * Math.round(((1 - v) * (height - 8)) / 2));
  const barY = (h) => (height - h) / 2;

  // First bar at/after the playhead switches from accent to muted, so the
  // colour boundary always falls between two bars instead of cutting one.
  const splitIndex = Math.floor(played * barCount);
  for (let i = 0; i < barCount; i += 1) {
    ctx.fillStyle = i < splitIndex ? accent : base;
    ctx.fillRect(i * unit, barY(barH(values[i])), barW, barH(values[i]));
  }
}

/** Kick off loads + redraws for every waveform currently on screen. */
function renderWaveforms() {
  for (const track of state.tracks) {
    if (!document.querySelector(`canvas[data-waveform-track="${track.id}"]`)) continue;
    if (state.waveforms.has(track.id)) drawWaveform(track.id);
    else void waveformBars(track);
  }
}

/** Click on a waveform: seek the active preview, or start one at that spot. */
function seekFromWaveform(canvas, event) {
  const trackId = Number(canvas.dataset.waveformTrack);
  const track = state.tracks.find((t) => t.id === trackId);
  if (!track || !(track.duration > 0)) return;
  const rect = canvas.getBoundingClientRect();
  const fraction = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
  const targetSec = fraction * (track.duration / 1000);
  // Not laid out yet (or coordinateless event): the fraction would be NaN —
  // ignore the click instead of jumping to a bogus position.
  if (!rect.width || !Number.isFinite(targetSec)) return;
  const p = state.preview;
  const audio = document.getElementById("preview-audio");
  // Seek directly only when the click lands inside the already-downloaded
  // audio window [originSec, originSec + duration]; otherwise reload from
  // the clicked position ("jump" mode, see loadJumpSource).
  const originSec = p.originSec ?? 0;
  const coveredEnd = originSec + (Number.isFinite(audio.duration) ? audio.duration : 0);
  if (p.trackId === trackId && !p.loading && p.blob && audio.duration > 0
      && targetSec >= originSec && targetSec < coveredEnd - 0.05) {
    audio.currentTime = targetSec - originSec;
    if (audio.paused) {
      void audio.play().catch(() => { /* retried on next click */ });
      p.playing = true;
    }
    drawWaveform(trackId);
    return;
  }
  // Nothing (or not the right window) loaded: fetch the track from that spot.
  void togglePreview(trackId, "jump", { seekTo: targetSec });
}

/**
 * Glyphs + classes for the two preview buttons of a track row. The button
 * matching the active preview's mode shows ▶/⏸; the other one is inert.
 */
function previewButtonFor(track, mode) {
  const p = state.preview;
  const isMine = p.trackId === track.id;
  // A jump preview (waveform click) is a full-track source like "peak".
  const activeMode = p.mode === "jump" ? "peak" : p.mode;
  const isActive = isMine && !p.loading && activeMode === mode;
  const glyph = isActive && p.playing ? "⏸" : mode === "peak" ? "⏫" : "▶";
  const isLoading = isMine && p.loading && activeMode === mode;
  const classes = ["track-preview", isMine && activeMode === mode ? "is-active" : "", isLoading ? "is-loading" : ""].filter(Boolean).join(" ");
  const content = isLoading ? `<span class="spinner" aria-hidden="true"></span>` : glyph;
  const label = mode === "peak" ? "Play from the loudest part" : "Play the ~30 s preview";
  return `<button class="${classes}" type="button" data-preview-track="${track.id}" data-preview-mode="${mode}" title="${label}" aria-label="${label} of ${escapeHtml(track.title ?? "track")}">${content}</button>`;
}

async function togglePreview(trackId, mode = "start", { seekTo = null } = {}) {
  const p = state.preview;
  const audio = document.getElementById("preview-audio");

  if (p.trackId === trackId && seekTo === null) {
    if (p.loading) {
      // Still loading: a second click cancels the pending preview.
      stopPreview();
      renderTrackList();
      clearStatus();
      return;
    }
    // A "jump" preview is full-track audio too: its ⏫ button pauses/resumes
    // it like a native peak preview instead of reloading.
    const activeMode = p.mode === "jump" ? "peak" : p.mode;
    if (mode === activeMode) {
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
    // The other button uses a different source (snippet vs full track):
    // stop what is playing and load the requested one from scratch.
    stopPreview();
  }
  if (p.trackId !== null) stopPreview();

  const track = state.tracks.find((t) => t.id === trackId);
  if (!track) return;

  p.trackId = trackId;
  p.mode = mode;
  p.blob = null;
  p.peakOffset = null;
  p.pendingSeekSec = seekTo;
  p.originSec = null;
  p.jump = null;
  p.extending = false;
  p.loading = true;
  renderTrackList();
  showStatus(`Loading preview of “${track.title}”…`);

  try {
    const onRaw = (streams) => dbg(`[preview] streams raw: ${JSON.stringify(streams).slice(0, 800)}`);
    const onError = (err) => dbg(`[preview] streams failed: ${err.message}`);
    // Peak prefers HLS: segments are scanned one by one and only the loudest
    // one is kept. Jump downloads from the clicked position onward. Every
    // other mode (and HLS-less tracks) use previewSource.
    const source = mode === "peak"
      ? (await loadHlsPeak(track, { onRaw, onError })) ?? await state.api.previewSource(track, { mode, onRaw, onError })
      : mode === "jump"
        ? (await loadJumpSource(track, p.pendingSeekSec ?? 0, { onRaw, onError })) ?? await state.api.previewSource(track, { mode: "peak", onRaw, onError })
        : await state.api.previewSource(track, { mode, onRaw, onError });
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
    p.peakOffset = source.peakOffset ?? null;
    p.originSec = source.originSec ?? null;
    p.jump = source.jump ?? null;
    audio.src = src;
    p.loading = false;
    await waitForMetadata(audio);
    if (p.trackId !== trackId) return; // user switched away while loading

    // "Peak" starts full-length previews at their loudest window; anything
    // else (and any non-full source) simply starts at the beginning.
    let offset = 0;
    if (p.mode === "jump") {
      // The jump blob starts at the clicked position (see loadJumpSource).
      if (source.kind === "full" && source.seekOffset != null
          && Number.isFinite(audio.duration) && audio.duration > 0) {
        offset = Math.min(source.seekOffset, Math.max(0, audio.duration - 0.05));
        dbg(`[preview] jumping to ${((p.originSec ?? 0) + offset).toFixed(1)} s`);
      } else {
        dbg(`[preview] jump unavailable for ${source.kind} source — starting at 0`);
      }
      p.pendingSeekSec = null;
    } else if (p.mode === "peak") {
      if (source.kind === "full") {
        offset = (await ensurePeakOffset(trackId)) ?? 0;
      } else {
        dbg(`[preview] peak unavailable for ${source.kind} source — starting at 0`);
      }
      p.pendingSeekSec = null;
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
  state.preview.pendingSeekSec = null;
  state.preview.originSec = null;
  state.preview.jump = null;
  state.preview.extending = false;
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
  drawWaveform(p.trackId); // keep the played portion highlighted
  void extendJumpWindow(); // stream in the next window when close to the end
}

function onTrackListClick(event) {
  const wave = event.target.closest("[data-waveform-track]");
  if (wave) {
    seekFromWaveform(wave, event);
    return;
  }
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
    renderPagination(0);
    return;
  }
  if (visible.length === 0) {
    list.innerHTML = `<li class="empty-state">No playlists match your filters.`;
    renderPagination(0);
    return;
  }

  // Clamp the page in case the filters shrank the result set.
  const pageCount = Math.max(1, Math.ceil(visible.length / state.pageSize));
  state.page = Math.min(Math.max(1, state.page), pageCount);
  const start = (state.page - 1) * state.pageSize;
  list.innerHTML = visible.slice(start, start + state.pageSize).map(cardFor).join("");
  renderPagination(pageCount);
}

function renderPagination(pageCount) {
  const nav = document.getElementById("playlist-pagination");
  if (pageCount <= 1) {
    nav.hidden = true;
    nav.innerHTML = "";
    return;
  }

  // Windowed page numbers: 1 … 4 5 6 … 12 (context around the current page).
  const numbers = [];
  for (let p = 1; p <= pageCount; p += 1) {
    if (p === 1 || p === pageCount || Math.abs(p - state.page) <= 1) {
      numbers.push(p);
    } else if (numbers[numbers.length - 1] !== "…") {
      numbers.push("…");
    }
  }

  const pageButton = (p) =>
    `<button class="page-number${p === state.page ? " is-current" : ""}" type="button" data-goto-page="${p}" aria-current="${p === state.page ? "page" : "false"}">${p}</button>`;
  const ellipsis = `<span class="page-ellipsis" aria-hidden="true">…</span>`;

  nav.hidden = false;
  nav.innerHTML = [
    `<button class="page-number page-prev" type="button" data-goto-page="${state.page - 1}" ${state.page === 1 ? "disabled" : ""} aria-label="Previous page">‹ Prev</button>`,
    ...numbers.map((n) => (n === "…" ? ellipsis : pageButton(n))),
    `<button class="page-number page-next" type="button" data-goto-page="${state.page + 1}" ${state.page === pageCount ? "disabled" : ""} aria-label="Next page">Next ›</button>`,
    `<span class="page-info">Page ${state.page} of ${pageCount}</span>`,
  ].join("");
}

function onPaginationClick(event) {
  const button = event.target.closest("[data-goto-page]");
  if (!button || button.disabled) return;
  const target = Number(button.dataset.gotoPage);
  if (!Number.isInteger(target)) return;
  state.page = target;
  renderPlaylists();
  // Keep the (re-rendered) grid in view after jumping pages.
  document.getElementById("playlists-screen").scrollIntoView({ behavior: "smooth", block: "start" });
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
  const hasMore = state.trackPager !== null && !state.trackPager.done && !state.tracksError;
  const totalCount = state.currentPlaylist?.track_count ?? tracks.length;

  if (!state.tracksLoaded) {
    forgetTrackSentinel();
    list.innerHTML = `<li class="empty-state"><span class="spinner" aria-hidden="true"></span>Loading tracks…</li>`;
    return;
  }
  if (state.tracksError) {
    forgetTrackSentinel();
    list.innerHTML = `<li class="empty-state">Could not load the track list — see the message above.</li>`;
    return;
  }

  summary.textContent = tracks.length
    ? `${formatCount(tracks.length)} of ${formatCount(totalCount)} sound${totalCount === 1 ? "" : "s"} in this playlist${hasMore ? " — scroll for more" : ""}`
    : "";

  if (tracks.length === 0) {
    forgetTrackSentinel();
    list.innerHTML = `<li class="empty-state">This playlist has no sounds (yet).</li>`;
    return;
  }
  list.innerHTML = tracks.map(trackRowFor).join("") +
    (hasMore
      ? `<li id="track-sentinel" class="track-sentinel" aria-hidden="true"><span class="spinner"></span>Loading more tracks…</li>`
      : "");
  if (hasMore) {
    observeTrackSentinel();
  } else {
    forgetTrackSentinel();
  }
  updatePreviewTime();
  renderWaveforms();
}

function trackRowFor(track, index) {
  const letter = (track.title ?? "?").trim().charAt(0).toUpperCase() || "♪";
  const artwork = track.artwork_url
    ? `<div class="track-art"><img src="${escapeHtml(track.artwork_url)}" alt="" loading="lazy" /></div>`
    : `<div class="track-art track-art-placeholder">${escapeHtml(letter)}</div>`;

  const byLine = [track.user?.username, track.genre].filter(Boolean).join(" · ");
  const title = escapeHtml(track.title ?? "Untitled");
  const permalink = escapeHtml(track.permalink_url);

  return `<li class="track-row">
    <span class="track-index">${index + 1}</span>
    ${artwork}
    <div class="track-body">
      <a class="track-title" href="${permalink}" target="_blank" rel="noreferrer">${title}</a>
      ${byLine ? `<p class="muted track-sub">${escapeHtml(byLine)}</p>` : ""}
    </div>
    <canvas class="track-waveform" data-waveform-track="${track.id}" title="Click the waveform to jump into this track" aria-hidden="true"></canvas>
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
  forgetTrackSentinel();
  state.trackPager = null;
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
  const resetPageAndRender = () => {
    state.page = 1;
    renderPlaylists();
  };
  document.getElementById("search").addEventListener("input", resetPageAndRender);
  document.getElementById("type-filter").addEventListener("change", resetPageAndRender);
  document.getElementById("sort").addEventListener("change", resetPageAndRender);
  document.getElementById("playlist-pagination").addEventListener("click", onPaginationClick);
  document.getElementById("back-to-playlists").addEventListener("click", goBackToPlaylists);
  document.getElementById("playlist-list").addEventListener("click", onPlaylistListClick);
  document.getElementById("track-list").addEventListener("click", onTrackListClick);
  const previewAudio = document.getElementById("preview-audio");
  previewAudio.addEventListener("ended", onPreviewEnded);
  previewAudio.addEventListener("error", onPreviewError);
  previewAudio.addEventListener("timeupdate", updatePreviewTime);
  window.addEventListener("hashchange", route);
  // Window resizes change the waveform canvases' width: redraw (debounced —
  // a resize fires dozens of times while dragging).
  let resizeTimer = 0;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(renderWaveforms, 120);
  });
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