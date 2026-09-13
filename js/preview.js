/**
 * Preview UI controller: one hidden `<audio>` element shared by every track
 * row. Handles the two per-row buttons (▶ snippet, ⏫ loudest part), the
 * waveform click-to-jump, playback state and the time display.
 */

import { dbg } from "./debug.js";
import { state } from "./state.js";
import { showStatus, clearStatus } from "./screens.js";
import { escapeHtml, formatDuration } from "./util.js";
import { drawWaveform } from "./waveform.js";
import { renderTrackList } from "./render.js";
import {
  loadHlsPeak, loadJumpSource, extendJumpWindow, loudestOffsetSeconds,
  waitForMetadata, revokePreviewObjectUrl,
} from "./audio-engine.js";

/**
 * Glyphs + classes for the two preview buttons of a track row. The button
 * matching the active preview's mode shows ▶/⏸; the other one is inert.
 */
export function previewButtonFor(track, mode) {
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

/** Seconds offset of the loudest window for the loaded preview, cached. */
async function ensurePeakOffset(trackId) {
  const p = state.preview;
  if (p.trackId !== trackId) return null; // switched away meanwhile
  if (p.peakOffset !== null || !p.blob) return p.peakOffset;
  const track = state.tracks.find((t) => t.id === trackId);
  p.peakOffset = track ? await loudestOffsetSeconds(p.blob, track) : null;
  return p.peakOffset;
}

/** Start / pause / switch a preview for one track. */
export async function togglePreview(trackId, mode = "start", { seekTo = null } = {}) {
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

/** Reset the shared audio element and the preview state. */
export function stopPreview() {
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

/** Live time readout + played-portion highlight + jump-window streaming. */
export function updatePreviewTime() {
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

/** Click on a waveform: seek the active preview, or start one at that spot. */
export function seekFromWaveform(canvas, event) {
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

/** Delegated clicks on the track list: waveforms first, then preview buttons. */
export function onTrackListClick(event) {
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

export function onPreviewEnded() {
  state.preview.playing = false;
  renderTrackList();
}

export function onPreviewError() {
  const src = document.getElementById("preview-audio").src;
  dbg(`[preview] audio error on ${src.slice(0, 140)}${src.length > 140 ? "…" : ""}`);
  if (state.preview.trackId === null) return;
  stopPreview();
  showStatus("Preview failed to load — this track may only offer HLS streaming, which this browser cannot play directly.", "error");
  renderTrackList();
}
