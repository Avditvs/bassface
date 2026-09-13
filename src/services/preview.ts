/**
 * Preview controller: one hidden `<audio>` element shared by every track
 * row. Handles the per-row play/pause button, the waveform click-to-jump,
 * playback state and the time display.
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
  loadJumpSource, extendJumpWindow, waitForMetadata,
} from "./audio-engine";
import { getAudio, previewRuntime, revokePreviewObjectUrl } from "./preview-runtime";
import type { PreviewMode } from "../services/types";

/** Remove the active-playback colour from a track's time display. */
function clearLiveTrackTime(trackId: number): void {
  document.querySelector<HTMLElement>(`[data-track-time="${trackId}"]`)?.classList.remove("is-live");
}

/** Reset the shared audio element and the preview state. */
export function stopPreview(): void {
  const previousTrackId = previewRuntime.trackId;
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
    trackId: null, mode: "start", blob: null,
    pendingSeekSec: null, originSec: null, jump: null, extending: false,
  } satisfies Partial<typeof previewRuntime>);
  setState({
    previewTrackId: null, previewPlaying: false, previewLoading: false, previewMode: "start",
  });
  // The active canvas is normally redrawn from audio `timeupdate` events.
  // Switching tracks stops those events, so redraw the old canvas explicitly
  // after clearing its runtime identity to remove its accent overlay.
  if (previousTrackId !== null) {
    clearLiveTrackTime(previousTrackId);
    redrawTrackWaveform(previousTrackId);
  }
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
    // Single button: pause / resume whatever is active on this row (the
    // full-track preview or a jump into it alike).
    if (getState().previewPlaying) {
      audio.pause();
      clearLiveTrackTime(trackId);
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
  if (p.trackId !== null) stopPreview();

  const track = getState().tracks.find((t) => t.id === trackId);
  if (!track) return;

  Object.assign(p, {
    trackId, mode, blob: null, pendingSeekSec: seekTo,
    originSec: null, jump: null, extending: false,
  });
  setState({ previewTrackId: trackId, previewLoading: true, previewMode: mode });
  showStatus(`Loading preview of “${track.title}”…`);

  try {
    const onRaw = (streams: unknown) => dbg(`[preview] streams raw: ${JSON.stringify(streams).slice(0, 800)}`);
    const onError = (err: unknown) => dbg(`[preview] streams failed: ${(err as Error).message}`);
    // Every mode streams the track through the jump engine: the play button
    // ("start") streams from position 0 exactly like a waveform jump ("jump")
    // streams from the clicked position — segments append to a MediaSource,
    // extended window by window. The previewSource fallback (whole-track
    // Blob or direct src) only kicks in when no HLS segments exist.
    const source = await loadJumpSource(track, p.pendingSeekSec ?? 0, audio, { onRaw, onError });
    if (!source || (!source.blob && !source.url)) throw new Error("this track has no playable preview");

    // Streamed jump previews (MediaSource) are already attached to the
    // element by the audio engine; every other source is assigned here.
    const streamed = source.jump?.streamed === true;
    let src: string;
    if (source.blob) {
      src = URL.createObjectURL(source.blob);
      dbg(`[preview] downloaded ${source.blob.size} bytes (${source.kind}) from ${source.url}`);
    } else {
      src = source.url;
      dbg(`[preview] no blob (${source.kind}) — using ${streamed ? "streamed MediaSource" : "direct"} src: ${source.url}`);
    }

    revokePreviewObjectUrl();
    p.objectUrl = source.blob || streamed ? src : null;
    p.blob = source.blob ?? null;
    p.originSec = source.originSec ?? null;
    p.jump = source.jump ?? null;
    if (!streamed) audio.src = src;
    setState({ previewLoading: false });
    await waitForMetadata(audio);
    if (p.trackId !== trackId) return; // user switched away while loading

    // A jump blob starts at the clicked position (see loadJumpSource); any
    // other mode simply starts at the beginning.
    let offset = 0;
    if (p.mode === "jump") {
      if (source.kind === "full" && source.seekOffset != null
          && Number.isFinite(audio.duration) && audio.duration > 0) {
        offset = Math.min(source.seekOffset, Math.max(0, audio.duration - 0.05));
        dbg(`[preview] jumping to ${((p.originSec ?? 0) + offset).toFixed(1)} s`);
      } else {
        dbg(`[preview] jump unavailable for ${source.kind} source — starting at 0`);
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
  // The loaded blob may only be a window of the track (jump window, 30 s
  // window), so audio.duration is that window's length — not
  // the track's. Display the position inside the whole track instead,
  // matching the waveform highlight (originSec + currentTime, track.duration).
  const track = getState().tracks.find((t) => t.id === p.trackId);
  const current = ((p.originSec ?? 0) + (Number.isFinite(audio.currentTime) ? audio.currentTime : 0)) * 1000;
  const total = track && track.duration > 0
    ? track.duration
    : (Number.isFinite(audio.duration) ? audio.duration * 1000 : 0);
  // Keep the baked-in duration until the real one is known (total > 0).
  if (total <= 0) return;
  span.textContent = `${formatDuration(Math.min(current, total))} / ${formatDuration(total)}`;
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
  // Seek directly only when the click lands inside audio the element already
  // holds: on the MediaSource path every buffered range is seekable — played
  // segments are never evicted, so jumping back is gapless; on the Blob path
  // the whole window [originSec, originSec + duration] is seekable. Anything
  // else reloads from the clicked position ("jump" mode, see loadJumpSource).
  const streamed = p.jump?.streamed === true;
  const originSec = p.originSec ?? 0;
  let covered = false;
  if (p.trackId === trackId && !getState().previewLoading && (p.blob || streamed) && audio.duration > 0) {
    const local = targetSec - originSec;
    if (streamed) {
      for (let i = 0; i < audio.buffered.length && !covered; i += 1) {
        covered = local >= audio.buffered.start(i) && local < audio.buffered.end(i) - 0.05;
      }
    } else {
      covered = local >= 0 && local < (Number.isFinite(audio.duration) ? audio.duration : 0) - 0.05;
    }
  }
  if (covered) {
    audio.currentTime = Math.max(0, targetSec - originSec);
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
  const trackId = previewRuntime.trackId;
  if (trackId !== null) clearLiveTrackTime(trackId);
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
