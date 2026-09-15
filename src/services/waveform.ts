/**
 * Track waveform display: fetch + cache loudness bars, draw them on the
 * per-track canvas, highlight the played portion, and redraw on resize.
 *
 * The bar cache lives in `runtime` (non-reactive); the `<WaveformCanvas>`
 * React component calls `ensureWaveformBars` on mount and draws whenever the
 * bars or the preview state change, plus on window resizes.
 */

import { getState, runtime } from "./store";
import { getAudio, previewRuntime } from "./preview-runtime";
import type { Track } from "../services/types";

/** Cap the drawn bars so very long waveforms stay cheap to paint. */
const WAVEFORM_MAX_BARS = 220;

/** Raw waveform samples → normalised (0-1) max-per-bucket bars. */
function normalizeWaveform(samples: unknown): number[] {
  if (!Array.isArray(samples) || samples.length < 2) return [];
  const values = samples.map((s) => Number(s)).filter((v) => Number.isFinite(v) && v >= 0);
  const max = values.reduce((m, v) => Math.max(m, v), 0);
  if (!(max > 0)) return [];
  const bars: number[] = [];
  const bucket = Math.ceil(values.length / WAVEFORM_MAX_BARS);
  for (let i = 0; i < values.length; i += bucket) {
    bars.push(values.slice(i, i + bucket).reduce((m, v) => Math.max(m, v), 0) / max);
  }
  return bars;
}

/** Progress fraction (0-1) of the active preview, for the accent overlay. */
function waveformProgress(trackId: number): number {
  const p = previewRuntime;
  if (p.trackId !== trackId || getState().previewLoading) return 0;
  const audio = getAudio();
  if (!Number.isFinite(audio.duration) || audio.duration <= 0) return 0;
  // The preview can span screens: fall back to the shell-level track
  // snapshot when the current page's track list does not hold the track.
  const state = getState();
  const track = state.previewTrack?.id === trackId ? state.previewTrack : state.tracks.find((t) => t.id === trackId);
  if (!track || !(track.duration > 0)) return 0;
  // Jump blobs start mid-track: place the playhead on the full timeline.
  const originSec = p.originSec ?? 0;
  // Divide by the timeline the element actually plays (HLS stream total or
  // full-mp3 duration, both known to drift from the metadata duration) so
  // the highlight never drifts away from the music.
  const totalSec = p.streamTotalSec ?? track.duration / 1000;
  return Math.min(1, Math.max(0, (originSec + audio.currentTime) / totalSec));
}

/** Fetch the track's waveform bars once (cache + in-flight de-dup). */
export function ensureWaveformBars(track: Track, onReady?: () => void): Promise<number[] | undefined> {
  const cached = runtime.waveforms.get(track.id);
  if (cached) return Promise.resolve(cached);
  const inflight = runtime.waveformInflight.get(track.id);
  if (inflight) return inflight;
  const promise = getState().api!.waveformSamples(track)
    .then((samples) => {
      const bars = normalizeWaveform(samples);
      runtime.waveforms.set(track.id, bars);
      onReady?.();
      return bars;
    })
    .catch(() => {
      runtime.waveforms.set(track.id, []);
      return [] as number[];
    })
    .finally(() => runtime.waveformInflight.delete(track.id));
  runtime.waveformInflight.set(track.id, promise);
  return promise;
}

/**
 * Redraw the waveform canvas of `trackId` from the bar cache (used by the
 * preview controller on `timeupdate`/waveform seeks to refresh the played
 * portion without going through React).
 */
export function redrawTrackWaveform(trackId: number): void {
  const canvases = document.querySelectorAll<HTMLCanvasElement>(`canvas[data-waveform-track="${trackId}"]`);
  const bars = runtime.waveforms.get(trackId);
  if (bars) canvases.forEach((canvas) => drawWaveform(canvas, trackId, bars));
}

/** Cached CSS colors of the waveform (re-read only when stylesheets change). */
let cachedColors: { base: string; accent: string } | null = null;

function waveformColors(): { base: string; accent: string } {
  // getComputedStyle forces a style resolution: cache it, the two colors only
  // change when the document's stylesheets do.
  if (!cachedColors) {
    const styles = getComputedStyle(document.documentElement);
    cachedColors = {
      base: styles.getPropertyValue("--muted").trim() || "#a6a6a6",
      accent: styles.getPropertyValue("--accent").trim() || "#ff5500",
    };
  }
  return cachedColors;
}

// Stylesheet changes (theme switch, hot reload) invalidate the color cache.
document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll("style, link[rel='stylesheet']").forEach((el) => {
    el.addEventListener("load", () => { cachedColors = null; });
  });
});

/** Draw (or redraw) the cached waveform into the track's canvas. */
export function drawWaveform(canvas: HTMLCanvasElement, trackId: number, bars: number[]): void {
  if (!bars) return;
  if (bars.length === 0) {
    canvas.classList.add("is-empty"); // no waveform available for this track
    return;
  }
  canvas.classList.remove("is-empty");
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!width || !height) return;
  const dpr = window.devicePixelRatio || 1;
  const deviceW = Math.round(width * dpr);
  const deviceH = Math.round(height * dpr);
  // Reassigning canvas.width reallocates the backing store — skip it when the
  // device-pixel size is unchanged (timeupdate redraws hit this path 4×/s).
  if (canvas.width !== deviceW || canvas.height !== deviceH) {
    canvas.width = deviceW;
    canvas.height = deviceH;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const { base, accent } = waveformColors();
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
  const values: number[] = [];
  for (let i = 0; i < barCount; i += 1) {
    const from = Math.floor((i * bars.length) / barCount);
    const to = Math.max(from + 1, Math.floor(((i + 1) * bars.length) / barCount));
    values.push(bars.slice(from, to).reduce((m, v) => Math.max(m, v), 0));
  }
  // Mirrored around the centre, on an even pixel height so both halves
  // match; a 2px floor keeps silent passages visible. The value is inverted
  // (loud → short, quiet → tall) for the inverted waveform look.
  const barH = (v: number) => Math.max(2, 2 * Math.round(((1 - v) * (height - 8)) / 2));
  const barY = (h: number) => (height - h) / 2;

  // First bar at/after the playhead switches from accent to muted, so the
  // colour boundary always falls between two bars instead of cutting one.
  const splitIndex = Math.floor(played * barCount);
  for (let i = 0; i < barCount; i += 1) {
    ctx.fillStyle = i < splitIndex ? accent : base;
    ctx.fillRect(i * unit, barY(barH(values[i])), barW, barH(values[i]));
  }
}
