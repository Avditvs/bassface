/**
 * Track waveform display: fetch + cache loudness bars, draw them on the
 * per-track canvas, highlight the played portion, and redraw on resize.
 */

import { state } from "./state.js";
import { el } from "./util.js";
import type { Track } from "./types.js";

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

/** Fetch the track's waveform metadata once; resolves to its bars (or []). */
function waveformBars(track: Track): Promise<number[] | undefined> {
  const cached = state.waveforms.get(track.id);
  if (cached) return Promise.resolve(cached);
  const inflight = state.waveformInflight.get(track.id);
  if (inflight) return inflight;
  const promise = state.api!.waveformSamples(track)
    .then((samples) => {
      const bars = normalizeWaveform(samples);
      state.waveforms.set(track.id, bars);
      drawWaveform(track.id);
      return bars;
    })
    .catch(() => {
      state.waveforms.set(track.id, []);
      return [] as number[];
    })
    .finally(() => state.waveformInflight.delete(track.id));
  state.waveformInflight.set(track.id, promise);
  return promise;
}

/** Progress fraction (0-1) of the active preview, for the accent overlay. */
function waveformProgress(trackId: number): number {
  const p = state.preview;
  if (p.trackId !== trackId || p.loading) return 0;
  const audio = el<HTMLAudioElement>("preview-audio");
  if (!Number.isFinite(audio.duration) || audio.duration <= 0) return 0;
  const track = state.tracks.find((t) => t.id === trackId);
  if (!track || !(track.duration > 0)) return 0;
  // Jump/peak blobs start mid-track: place the playhead on the full timeline.
  const originSec = p.originSec ?? 0;
  return Math.min(1, Math.max(0, (originSec + audio.currentTime) / (track.duration / 1000)));
}

/** Draw (or redraw) the cached waveform into the track's canvas. */
export function drawWaveform(trackId: number): void {
  const canvas = document.querySelector<HTMLCanvasElement>(`canvas[data-waveform-track="${trackId}"]`);
  const bars = state.waveforms.get(trackId);
  if (!canvas || !bars) return;
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
  if (!ctx) return;
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

/** Kick off loads + redraws for every waveform currently on screen. */
export function renderWaveforms(): void {
  for (const track of state.tracks) {
    if (!document.querySelector(`canvas[data-waveform-track="${track.id}"]`)) continue;
    if (state.waveforms.has(track.id)) drawWaveform(track.id);
    else void waveformBars(track);
  }
}
