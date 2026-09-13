/**
 * Playlist Updater — entry point.
 * Connects to SoundCloud (OAuth 2.1 + PKCE, all client-side) and lists
 * the authenticated user's playlists.
 *
 * This file is the thin controller: event wiring, error surface and the
 * boot sequence. Everything else lives in its own module:
 *
 *   config.js        persisted app settings + token/user stores
 *   oauth.js         OAuth 2.1 + PKCE primitives
 *   api.js           SoundCloud API client
 *   state.js         central mutable app state
 *   debug.js         persistent troubleshooting log
 *   screens.js       screen switching + status bar
 *   connect.js       connect screen (config form → authorize redirect)
 *   session.js       OAuth callback, token refresh, sign-in/out lifecycle
 *   router.js        hash routing (#/playlists, #/playlist/<id>)
 *   tracks.js        playlist detail + track pagination (infinite scroll)
 *   audio-engine.js  preview source building (HLS peak scan, jump windows)
 *   waveform.js      waveform canvas drawing
 *   preview.js       preview playback controller (buttons, audio element)
 *   render.js        all DOM rendering (cards, rows, headers, pagination)
 *   util.js          formatting + escaping helpers
 */

import { state, tokenSummary } from "./state.js";
import { dbg, renderDebugPanel } from "./debug.js";
import { showScreen, showStatus } from "./screens.js";
import { onConnectSubmit, fillConfigForm } from "./connect.js";
import { enterApp, handleOAuthCallback, signOut } from "./session.js";
import { route, goBackToPlaylists } from "./router.js";
import { onPlaylistListClick, onPaginationClick, renderPlaylists } from "./render.js";
import { onTrackListClick, onPreviewEnded, onPreviewError, updatePreviewTime } from "./preview.js";
import { renderWaveforms } from "./waveform.js";
import {
  renderOrganizeSidebar,
  onTrackDragStart,
  onOrganizeDragOver,
  onOrganizeDragLeave,
  onOrganizeDrop,
  onOrganizeFilterInput,
  onOrganizeClick,
  onOrganizeChange,
  onRemoveZoneDragOver,
  onRemoveZoneDragLeave,
  onRemoveZoneDrop,
  revertLastAction,
} from "./organize.js";
import { SoundCloudApi } from "./api.js";

/** Wire every static event listener once, at boot. */
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
  // Reorganize sidebar: tracks are dragged from the track list onto the
  // playlist cards (add) or their far-right strip (add + remove from here).
  document.getElementById("track-list").addEventListener("dragstart", onTrackDragStart);
  const organizeList = document.getElementById("organize");
  organizeList.addEventListener("dragover", onOrganizeDragOver);
  organizeList.addEventListener("dragleave", onOrganizeDragLeave);
  organizeList.addEventListener("drop", onOrganizeDrop);
  organizeList.addEventListener("input", onOrganizeFilterInput);
  organizeList.addEventListener("click", onOrganizeClick);
  organizeList.addEventListener("change", onOrganizeChange);
  // Drop-to-remove zone above the track list.
  const removeZone = document.getElementById("remove-zone");
  removeZone.addEventListener("dragover", onRemoveZoneDragOver);
  removeZone.addEventListener("dragleave", onRemoveZoneDragLeave);
  removeZone.addEventListener("drop", onRemoveZoneDrop);
  document.getElementById("undo-action").addEventListener("click", () => void revertLastAction());
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

/** Boot: wire events, mirror the API log, then route or restore the session. */
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
