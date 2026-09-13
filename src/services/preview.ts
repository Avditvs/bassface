/**
 * Preview controller: one hidden `<audio>` element shared by every track
 * row. Handles the two per-row buttons (▶ snippet, ⏫ loudest part), the
 * waveform click-to-jump, playback state and the time display.
 *
 * The identity fields that drive the UI (which track, playing/loading, mode)
 * live in the central store; blobs, offsets and the audio element live in
 * `preview-runtime.ts`.
 */

import { dbg } from "./debug";
import { clearStatus, getState, setState, showStatus } from "./store";
import { formatDuration } from "./util";
import { redrawTrackWaveform } from "./waveform";
import {
  loadHlsPeak, loadJumpSource, extendJumpWindow, loudestOffsetSeconds,
  waitForMetadata,
} from "./audio-engine";
import { getAudio, previewRuntime, revokePreviewObjectUrl } from "./preview-runtime";
import type { PreviewMode } from "../services/types";

/** Reset the shared audio element and the preview state. */
export function stopPreview(): void {
  try {
    const audio = getAudio();
    audio.pause();
    audio.removeAttribute("src");
    audio.load(); // reset the element so the emptied src cannot fire error events
  } catch {
    /* audio element not mounted (playlist screen closed) */
  }
  revokePreviewObjectUrl();
  Object.assign(previewRuntime, {
    trackId: null, mode: "start", blob: null, peakOffset: null,
    pendingSeekSec: null, originSec: null, jump: null, extending: false,
  } satisfies Partial<typeof previewRuntime>);
  setState({
    previewTrackId: null, previewPlaying: false, previewLoading: false, previewMode: "start",
  });
}

/** Seconds offset of the loudest window for the loaded preview, cached. */
async function ensurePeakOffset(trackId: number): Promise<number | null> {
  const p = previewRuntime;
  if (p.trackId !== trackId) return null; // switched away meanwhile
  if (p.peakOffset !== null || !p.blob) return p.peakOffset;
  const track = getState().tracks.find((t) => t.id === trackId);
  p.peakOffset = track ? await loudestOffsetSeconds(p.blob, track) : null;
  return p.peakOffset;
}

/** Start / pause / switch a preview for one track. */
export async function togglePreview(
  trackId: number,
  mode: PreviewMode = "start",
  { seekTo = null }: { seekTo?: number | null } = {},
): Promise<void> {
  const p = previewRuntime;
  const audio = getAudio();

  if (p.trackId === trackId && seekTo === null) {
    if (getState().previewLoading) {
      // Still loading: a second click cancels the pending preview.
      stopPreview();
      clearStatus();
      return;
    }
    // A "jump" preview is full-track audio too: its ⏫ button pauses/resumes
    // it like a native peak preview instead of reloading.
    const activeMode: PreviewMode = p.mode === "jump" ? "peak" : p.mode;
    if (mode === activeMode) {
      // Same button: pause / resume.
      if (getState().previewPlaying) {
        audio.pause();
        setState({ previewPlaying: false });
      } else {
        setState({ previewPlaying: true });
        try {
          await audio.play();
        } catch {
          setState({ previewPlaying: false }); // playback blocked (autoplay policy)
        }
      }
      return;
    }
    // The other button uses a different source (snippet vs full track):
    // stop what is playing and load the requested one from scratch.
    stopPreview();
  }
  if (p.trackId !== null) stopPreview();

  const track = getState().tracks.find((t) => t.id === trackId);
  if (!track) return;

  Object.assign(p, {
    trackId, mode, blob: null, peakOffset: null, pendingSeekSec: seekTo,
    originSec: null, jump: null, extending: false,
  });
  setState({ previewTrackId: trackId, previewLoading: true, previewMode: mode });
  showStatus(`Loading preview of “${track.title}”…`);

  try {
    const onRaw = (streams: unknown) => dbg(`[preview] streams raw: ${JSON.stringify(streams).slice(0, 800)}`);
    const onError = (err: unknown) => dbg(`[preview] streams failed: ${(err as Error).message}`);
    // Peak prefers HLS: segments are scanned one by one and only the loudest
    // one is kept. Jump downloads from the clicked position onward. Every
    // other mode (and HLS-less tracks) use previewSource.
    const api = getState().api!;
    const source = mode === "peak"
      ? (await loadHlsPeak(track, { onRaw, onError })) ?? await api.previewSource(track, { mode, onRaw, onError })
      : mode === "jump"
        ? (await loadJumpSource(track, p.pendingSeekSec ?? 0, { onRaw, onError })) ?? await api.previewSource(track, { mode: "peak", onRaw, onError })
        : await api.previewSource(track, { mode: "start", onRaw, onError });
    if (!source || (!source.blob && !source.url)) throw new Error("this track has no playable preview");

    // Stream URLs live on api.soundcloud.com and require the OAuth header,
    // which a bare <audio> cannot send — play from a downloaded Blob (full
    // track, direct mp3 or concatenated HLS) whenever possible.
    let src: string;
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
    setState({ previewLoading: false });
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
    setState({ previewPlaying: !audio.paused });
  } catch (err) {
    setState({ previewTrackId: null, previewLoading: false });
    p.trackId = null;
    dbg(`[preview] failed: ${(err as Error).message}`);
    showStatus(`Preview failed: ${(err as Error).message}`, "error");
  }
}

/** Live time readout + played-portion highlight + jump-window streaming. */
export function updatePreviewTime(): void {
  const p = previewRuntime;
  if (p.trackId === null) return;
  const audio = getAudio();
  const span = document.querySelector<HTMLElement>(`[data-track-time="${p.trackId}"]`);
  if (!span) return;
  const current = Number.isFinite(audio.currentTime) ? audio.currentTime * 1000 : 0;
  const total = Number.isFinite(audio.duration) ? audio.duration * 1000 : 0;
  // Keep the baked-in duration until metadata has loaded (total > 0).
  if (total <= 0) return;
  span.textContent = `${formatDuration(current)} / ${formatDuration(total)}`;
  span.classList.toggle("is-live", getState().previewPlaying);
  redrawTrackWaveform(p.trackId); // keep the played portion highlighted
  void extendJumpWindow(); // stream in the next window when close to the end
}

/** Click on a waveform: seek the active preview, or start one at that spot. */
export function seekFromWaveform(canvas: HTMLCanvasElement, event: MouseEvent): void {
  const trackId = Number(canvas.dataset.waveformTrack);
  const track = getState().tracks.find((t) => t.id === trackId);
  if (!track || !(track.duration > 0)) return;
  const rect = canvas.getBoundingClientRect();
  const fraction = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
  const targetSec = fraction * (track.duration / 1000);
  // Not laid out yet (or coordinateless event): the fraction would be NaN —
  // ignore the click instead of jumping to a bogus position.
  if (!rect.width || !Number.isFinite(targetSec)) return;
  const p = previewRuntime;
  const audio = getAudio();
  // Seek directly only when the click lands inside the already-downloaded
  // audio window [originSec, originSec + duration]; otherwise reload from
  // the clicked position ("jump" mode, see loadJumpSource).
  const originSec = p.originSec ?? 0;
  const coveredEnd = originSec + (Number.isFinite(audio.duration) ? audio.duration : 0);
  if (p.trackId === trackId && !getState().previewLoading && p.blob && audio.duration > 0
      && targetSec >= originSec && targetSec < coveredEnd - 0.05) {
    audio.currentTime = targetSec - originSec;
    if (audio.paused) {
      void audio.play().catch(() => { /* retried on next click */ });
      setState({ previewPlaying: true });
    }
    redrawTrackWaveform(trackId);
    return;
  }
  // Nothing (or not the right window) loaded: fetch the track from that spot.
  void togglePreview(trackId, "jump", { seekTo: targetSec });
}

/** `onEnded` handler of the shared `<audio>` element. */
export function onPreviewEnded(): void {
  setState({ previewPlaying: false });
}

/** `onError` handler of the shared `<audio>` element. */
export function onPreviewError(): void {
  let src = "";
  try {
    src = getAudio().src;
  } catch { /* element gone */ }
  dbg(`[preview] audio error on ${src.slice(0, 140)}${src.length > 140 ? "…" : ""}`);
  if (previewRuntime.trackId === null) return;
  stopPreview();
  showStatus("Preview failed to load — this track may only offer HLS streaming, which this browser cannot play directly.", "error");
}
