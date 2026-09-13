/**
 * Playlist Updater — entry point.
 * Connects to SoundCloud (OAuth 2.1 + PKCE, all client-side) and lists
 * the authenticated user's playlists.
 *
 * This file is the thin controller: event wiring, error surface and the
 * boot sequence. Everything else lives in its own module:
 *
 *   types.ts         shared domain types (SoundCloud API shapes, contracts)
 *   config.ts        persisted app settings + token/user stores
 *   oauth.ts         OAuth 2.1 + PKCE primitives
 *   api.ts           SoundCloud API client
 *   state.ts         central mutable app state
 *   debug.ts         persistent troubleshooting log
 *   screens.ts       screen switching + status bar
 *   connect.ts       connect screen (config form → authorize redirect)
 *   session.ts       OAuth callback, token refresh, sign-in/out lifecycle
 *   router.ts        hash routing (#/playlists, #/playlist/<id>)
 *   tracks.ts        playlist detail + track pagination (infinite scroll)
 *   audio-engine.ts  preview source building (HLS peak scan, jump windows)
 *   waveform.ts      waveform canvas drawing
 *   preview.ts       preview playback controller (buttons, audio element)
 *   render.ts        all DOM rendering (cards, rows, headers, pagination)
 *   util.ts          formatting + escaping + DOM helpers
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
import { el } from "./util.js";
import type { OAuthCallback } from "./types.js";

/** Wire every static event listener once, at boot. */
function initListeners(): void {
  el("config-form").addEventListener("submit", onConnectSubmit);
  el("sign-out").addEventListener("click", signOut);
  const resetPageAndRender = () => {
    state.page = 1;
    renderPlaylists();
  };
  el("search").addEventListener("input", resetPageAndRender);
  el("type-filter").addEventListener("change", resetPageAndRender);
  el("sort").addEventListener("change", resetPageAndRender);
  el("playlist-pagination").addEventListener("click", onPaginationClick);
  el("back-to-playlists").addEventListener("click", goBackToPlaylists);
  el("playlist-list").addEventListener("click", onPlaylistListClick);
  el("track-list").addEventListener("click", onTrackListClick);
  // Reorganize sidebar: tracks are dragged from the track list onto the
  // playlist cards (add) or their far-right strip (add + remove from here).
  el("track-list").addEventListener("dragstart", onTrackDragStart);
  const organizeList = el("organize");
  organizeList.addEventListener("dragover", onOrganizeDragOver);
  organizeList.addEventListener("dragleave", onOrganizeDragLeave);
  organizeList.addEventListener("drop", onOrganizeDrop);
  organizeList.addEventListener("input", onOrganizeFilterInput);
  organizeList.addEventListener("click", onOrganizeClick);
  organizeList.addEventListener("change", onOrganizeChange);
  // Drop-to-remove zone above the track list.
  const removeZone = el("remove-zone");
  removeZone.addEventListener("dragover", onRemoveZoneDragOver);
  removeZone.addEventListener("dragleave", onRemoveZoneDragLeave);
  removeZone.addEventListener("drop", onRemoveZoneDrop);
  el("undo-action").addEventListener("click", () => void revertLastAction());
  const previewAudio = el<HTMLAudioElement>("preview-audio");
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
function init(): void {
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
  const callback: OAuthCallback = { code: query.get("code"), state: query.get("state"), error: query.get("error") };

  if (callback.code || callback.error) {
    dbg(`[init] callback present — code=${Boolean(callback.code)} error=${callback.error ?? ""} ${tokenSummary()}`);
    void handleOAuthCallback(callback);
    return;
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
