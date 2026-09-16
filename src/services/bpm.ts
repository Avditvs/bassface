/**
 * In-browser BPM (tempo) estimation from onset periodicity (see
 * https://en.wikipedia.org/wiki/Onset_(audio) and Daniel P. W. Ellis,
 * "Beat Tracking by Dynamic Programming", 2007 — the method librosa uses).
 *
 * A track's tempo is estimated from **HLS mp3 segments taken at its most
 * intense moments** (chosen from the SoundCloud waveform loudness bars; even
 * spread as a fallback) — no full download: each segment (~5–10 s) is decoded to mono and
 * reduced to an **onset strength envelope**: overlapping 1024-sample Hann
 * windows (hop 512 on a 2× decimated signal, ~43 fps) whose magnitude
 * with the previous frame — the summed positive differences (spectral flux)
 * spike whenever a note or drum hit starts. The autocorrelation of each
 * segment's envelope is computed over lags of 60–200 BPM and the segments'
 * autocorrelations averaged (segments are not contiguous, so their envelopes
 * are never concatenated — that would fake periodicities at the seams).
 * Tracks without an HLS mp3 stream are analyzed the same way from evenly
 * spread windows of the whole-track source playback falls back to (see
 * services/analysis-source.ts).
 *
 * The lag with the strongest autocorrelation wins, refined by parabolic
 * interpolation for sub-frame precision, then folded into the DJ-friendly
 * [FOLD_MIN, FOLD_MAX) window by doubling/halving (half/double-tempo
 * ambiguity). Confidence is the winning peak height relative to the median
 * autocorrelation — ~1 means no periodicity was found.
 */

import { dbg } from "./debug";
import { BpmStore } from "./config";
import { getState, runtime, setState, showStatus } from "./store";
import { loadAllTracks } from "./tracks";
import { decimate2, fftRealMag, hannWindow } from "./audio";
import { ANALYSIS_DECODE_RATE, loadHlsStream, segmentMono, wholeTrackWindows } from "./analysis-source";
import { ensureWaveformBars } from "./waveform";
import type { BpmAnalysis, HlsSegment, Track } from "../services/types";

/** Tempo analysis runs on a 2× decimated signal: FFT 1024 at 22.05 kHz gives
 *  the same ~43 fps frame rate librosa defaults to, at a quarter of the
 *  44.1 kHz FFT cost — periodicity needs no wide bandwidth. */
const ANALYSIS_RATE = ANALYSIS_DECODE_RATE / 2;

/** FFT window length — sets the time resolution of the onset frames. */
const FFT_SIZE = 1024;

/** Hop between consecutive onset frames (~11.6 ms → ~43 fps @ 22.05 kHz). */
const HOP_SIZE = 512;

/** Onset-envelope frame rate, derived from the constants above. */
const FRAME_RATE = ANALYSIS_RATE / HOP_SIZE;

/** Slowest tempo considered, in BPM (autocorrelation lower bound). */
const BPM_MIN = 60;

/** Fastest tempo considered, in BPM (autocorrelation upper bound). */
const BPM_MAX = 200;

/** Beat-period candidates are folded by octaves into [FOLD_MIN, FOLD_MAX).
 *  The lower bound is kept low enough that a tempo estimated just under 90
 *  (e.g. 89.4) is not doubled to 179. */
const FOLD_MIN = 85;
const FOLD_MAX = 180;

/** Segments analyzed per track, taken at its most intense passages. */
const SEGMENTS_PER_TRACK = 4;

/** Frames whose RMS is below this fraction of the loudest frame are muted
 *  (intro/outro silence would otherwise inject fake periodicity). */
const SILENCE_GATE = 0.05;

/**
 * Onset strength envelope of one decoded segment: spectral flux (summed
 * positive magnitude change between consecutive Hann-windowed FFT frames),
 * zeroed in silent frames and mean-subtracted/clamped so only genuine onsets
 * contribute to the autocorrelation.
 */
function onsetEnvelope(samples: Float32Array): Float64Array {
  const mono = samples;
  const half = FFT_SIZE / 2;
  const re = new Float64Array(half);
  const im = new Float64Array(half);
  const mag = new Float64Array(half);
  const frame = new Float64Array(FFT_SIZE);
  const window = hannWindow(FFT_SIZE);
  const flux: number[] = [];
  const energies: number[] = [];
  const prevMag = new Float64Array(half);
  for (let start = 0; start + FFT_SIZE <= mono.length; start += HOP_SIZE) {
    let rms = 0;
    for (let i = 0; i < FFT_SIZE; i += 1) {
      const sample = mono[start + i] * window[i];
      frame[i] = sample;
      rms += sample * sample;
    }
    const energy = Math.sqrt(rms / FFT_SIZE);
    energies.push(energy);
    fftRealMag(frame, re, im, mag);
    let f = 0;
    for (let bin = 1; bin < half; bin += 1) {
      // Only rising magnitudes count: a note ending must not look like an onset.
      const rise = mag[bin] - prevMag[bin];
      if (rise > 0) f += rise;
      prevMag[bin] = mag[bin];
    }
    flux.push(f);
  }
  // Mute frames inside silent passages (energy gate against the loudest frame).
  const maxEnergy = energies.reduce((m, e) => Math.max(m, e), 0);
  if (maxEnergy > 0) {
    for (let i = 0; i < flux.length; i += 1) {
      if (energies[i] < SILENCE_GATE * maxEnergy) flux[i] = 0;
    }
  }
  // Remove the local baseline so steady sounds don't mask the peaks.
  const mean = flux.reduce((s, v) => s + v, 0) / (flux.length || 1);
  const envelope = new Float64Array(flux.length);
  for (let i = 0; i < flux.length; i += 1) envelope[i] = Math.max(0, flux[i] - mean);
  return envelope;
}

/** Lag range (in frames) the autocorrelation spans, for one sample rate. */
function lagRange(frameRate: number): { minLag: number; maxLag: number } {
  return {
    minLag: Math.max(2, Math.floor((frameRate * 60) / BPM_MAX)),
    maxLag: Math.ceil((frameRate * 60) / BPM_MIN),
  };
}

/**
 * Normalised autocorrelation of one envelope over the tempo lag range:
 * ac[lag] = Σ x[t]·x[t+lag] / Σ x[t+lag]², i.e. the Pearson-like strength of
 * a beat period of `lag` frames regardless of the segment's loudness.
 */
function autocorrelation(envelope: Float64Array, frameRate: number): Float64Array {
  const { minLag, maxLag } = lagRange(frameRate);
  const ac = new Float64Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let dot = 0;
    let norm = 0;
    for (let t = 0; t + lag < envelope.length; t += 1) {
      dot += envelope[t] * envelope[t + lag];
      norm += envelope[t + lag] * envelope[t + lag];
    }
    ac[lag] = norm > 0 ? dot / norm : 0;
  }
  return ac;
}

/** Evenly spread segment indexes across the track (avoiding the very ends). */
function pickSegments(segments: HlsSegment[]): number[] {
  const indexes: number[] = [];
  for (let i = 1; i <= SEGMENTS_PER_TRACK; i += 1) {
    indexes.push(Math.min(segments.length - 1, Math.floor((segments.length * i) / (SEGMENTS_PER_TRACK + 1))));
  }
  // A track shorter than the budget de-duplicates to fewer segments.
  return [...new Set(indexes)];
}

/** Minimum gap (in segments) between two picks from the quieter parts —
 *  they only pad the budget, so keep them in distinct moments. Intense
 *  picks (≥ STRONG_FRACTION of the loudest segment) may sit adjacent:
 *  one long drop is exactly where the beat lives. */
const PICK_SPACING = 2;

/** Segments at least this fraction of the loudest segment's loudness count
 *  as intense moments and are always picked (subject to the budget). */
const STRONG_FRACTION = 0.7;

/** Segments quieter than this fraction of the loudest one are near-silence
 *  (breakdowns, silence): never picked, whatever the budget. */
const NEGLIGIBLE_FRACTION = 0.1;

/** Never analyze fewer than this many segments (fallback when the whole
 *  track is quiet apart from one moment). */
const MIN_SEGMENTS = 2;

/**
 * Intensity-guided segment picking: rank segments by SoundCloud waveform
 * loudness (bars cached by the track-row display — usually no extra request)
 * and take the most energetic ones — the beat is clearest in drops and
 * choruses, not intros or breakdowns. Intense segments (≥ 70% of the peak)
 * are taken first (adjacent ones included: one long drop), the remaining
 * budget is filled from active-but-quieter parts kept a few segments apart,
 * and near-silent segments are never picked. Falls back to the even spread
 * when no waveform is available. Exported for the sanity tests.
 */
export async function pickIntenseSegments(track: Track, segments: HlsSegment[]): Promise<number[]> {
  const bars = await ensureWaveformBars(track);
  const totalSec = segments.reduce((sum, seg) => sum + seg.duration, 0);
  if (!bars || bars.length < 4 || !(totalSec > 0)) return pickSegments(segments);
  const barSec = totalSec / bars.length;
  // Mean loudness of each segment's bars, ignoring the first/last 5% of the
  // timeline (quiet lead-in/outro would otherwise still rank on loudness).
  const edgeBars = Math.floor(bars.length * 0.05);
  const starts: number[] = [];
  let cursor = 0;
  for (const seg of segments) { starts.push(cursor); cursor += seg.duration; }
  const energies = segments.map((seg, i) => {
    const from = Math.max(0, Math.floor(starts[i] / barSec));
    const to = Math.min(bars.length, Math.ceil((starts[i] + seg.duration) / barSec));
    let sum = 0;
    let n = 0;
    for (let b = from; b < to; b += 1) {
      if (b < edgeBars || b >= bars.length - edgeBars) continue;
      sum += bars[b];
      n += 1;
    }
    return n > 0 ? sum / n : 0;
  });
  const ranked = energies
    .map((energy, index) => ({ energy, index }))
    .filter((entry) => entry.energy > 0)
    .sort((a, b) => b.energy - a.energy);
  if (ranked.length === 0) return pickSegments(segments);
  const max = ranked[0].energy;
  const strong = ranked.filter((e) => e.energy >= STRONG_FRACTION * max);
  const weak = ranked.filter((e) => e.energy < STRONG_FRACTION * max && e.energy >= NEGLIGIBLE_FRACTION * max);
  // All intense moments first, whatever their spacing (one long drop counts
  // as one moment and is exactly where to measure the tempo).
  const chosen: number[] = [];
  for (const { index } of strong) {
    if (chosen.length >= SEGMENTS_PER_TRACK) break;
    chosen.push(index);
  }
  // Fill the rest from quieter-but-active parts, in distinct moments.
  for (let spacing = PICK_SPACING; spacing >= 0 && chosen.length < SEGMENTS_PER_TRACK; spacing -= 1) {
    for (const { index } of weak) {
      if (chosen.length >= SEGMENTS_PER_TRACK) break;
      if (chosen.includes(index)) continue;
      if (chosen.some((c) => Math.abs(c - index) <= spacing)) continue;
      chosen.push(index);
    }
  }
  // A track loud in a single moment only still needs a second sample.
  if (chosen.length < MIN_SEGMENTS) {
    for (const { index } of weak) {
      if (chosen.length >= MIN_SEGMENTS) break;
      chosen.push(index);
    }
  }
  return [...new Set(chosen)].sort((a, b) => a - b);
}

/** BPM of a lag (frames), for one frame rate. */
function lagToBpm(lag: number, frameRate: number): number {
  return (frameRate * 60) / lag;
}

/** Fold a raw BPM into [FOLD_MIN, FOLD_MAX) by doubling/halving (octaves). */
function foldBpm(bpm: number): number {
  let folded = bpm;
  while (folded < FOLD_MIN) folded *= 2;
  while (folded >= FOLD_MAX) folded /= 2;
  return folded;
}

/** Yield to the event loop so the UI stays responsive between segments. */
function yieldToUi(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** BPM analysis of a track, sampling its most intense passages (whole-track
 *  source windows when no HLS mp3 stream exists, picked with the same
 *  intensity logic). */
export async function analyzeBpm(track: Track): Promise<BpmAnalysis> {
  const stream = await loadHlsStream(track);
  let decoded;
  let chosen: number[];
  if (stream) {
    chosen = await pickIntenseSegments(track, stream.segments);
    // Cached across the chroma analyzer: segments the key tool already fetched
    // and decoded cost no network and no decode here (and vice versa).
    decoded = await Promise.all(chosen.map((index) => segmentMono(stream.segments, index)));
  } else {
    dbg(`[bpm] track ${track.id}: no HLS mp3 stream — falling back to whole-track windows`);
    const windows = await wholeTrackWindows(track);
    // The same intensity picker over the spread windows (pseudo-segments:
    // url is only a cache key, duration drives the waveform mapping).
    const pseudo: HlsSegment[] = windows.map((w, i) => ({ url: `window-${i}`, duration: w.duration }));
    chosen = await pickIntenseSegments(track, pseudo);
    decoded = chosen.map((index) => windows[index]);
  }
  const totalSec = decoded.reduce((sum, d) => sum + d.duration, 0);

  // One normalized autocorrelation per segment, then per-lag weighted
  // average — a segment where the beat drops out contributes nothing instead
  // of injecting a fake period. All decoded buffers share the same sample
  // rate (the shared decodeMono resamples to ANALYSIS_DECODE_RATE), so
  // integer lags align.
  const { minLag, maxLag } = lagRange(FRAME_RATE);
  const scores = new Float64Array(maxLag + 1);
  const weights = new Float64Array(maxLag + 1);
  for (const { samples, duration } of decoded) {
    const envelope = onsetEnvelope(decimate2(samples));
    const ac = autocorrelation(envelope, FRAME_RATE);
    let energy = 0;
    for (let lag = minLag; lag <= maxLag; lag += 1) energy += ac[lag];
    if (energy <= 0) continue;
    for (let lag = minLag; lag <= maxLag; lag += 1) {
      scores[lag] += ac[lag] * duration;
      weights[lag] += duration;
    }
    // Let pending UI work run before the next segment's number crunching.
    await yieldToUi();
  }
  const combined = new Float64Array(maxLag + 1);
  let bestLag = -1;
  let bestScore = 0;
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    combined[lag] = weights[lag] > 0 ? scores[lag] / weights[lag] : 0;
    if (combined[lag] > bestScore) {
      bestScore = combined[lag];
      bestLag = lag;
    }
  }
  if (bestLag < 0) throw new Error("no periodicity found in the analyzed segments");

  // Parabolic interpolation around the peak lag: sub-frame precision, so a
  // 174 BPM track (29.7 frames between beats) is not rounded to 172.
  const y0 = combined[bestLag - 1] ?? 0;
  const y1 = combined[bestLag];
  const y2 = combined[bestLag + 1] ?? 0;
  const denom = y0 - 2 * y1 + y2;
  const shift = denom !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / denom)) : 0;
  const rawBpm = lagToBpm(bestLag + shift, FRAME_RATE);

  // Confidence: how far the winning peak rises above the median periodicity.
  const sorted = [...combined].filter((v) => v > 0).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] || 1;
  const confidence = bestScore / median;
  dbg(`[bpm] track ${track.id}: ${chosen.length} segment(s), ${totalSec.toFixed(1)} s — raw ${rawBpm.toFixed(1)} bpm, confidence ${confidence.toFixed(2)}`);
  return {
    bpm: Math.round(foldBpm(rawBpm)),
    rawBpm: Math.round(rawBpm * 10) / 10,
    confidence: Math.round(confidence * 100) / 100,
    analyzedSec: totalSec,
    segmentsUsed: chosen.length,
  };
}

/**
 * User-facing entry point: estimate (and cache) the BPM of one track, with
 * loading/success/error feedback in the status bar. Results land in
 * `state.bpmValues` so the track rows can display them.
 */
export async function analyzeTrackBpm(trackId: number): Promise<void> {
  if (runtime.bpms.has(trackId) || runtime.bpmInflight.has(trackId)) return;
  const track = getState().tracks.find((t) => t.id === trackId);
  if (!track) return;
  setState({ bpmLoadingTrackId: trackId });
  showStatus(`Analyzing the BPM of “${track.title}” from its ${SEGMENTS_PER_TRACK} most intense passages…`);
  const promise = analyzeBpm(track)
    .then((analysis) => {
      runtime.bpms.set(trackId, analysis);
      BpmStore.save(trackId, analysis);
      setState({
        bpmValues: { ...getState().bpmValues, [trackId]: analysis.bpm },
        bpmLoadingTrackId: null,
      });
      showStatus(
        `BPM of “${track.title}”: ${analysis.bpm} (raw ${analysis.rawBpm}, confidence ${analysis.confidence.toFixed(2)}), `
        + `${analysis.segmentsUsed} segment(s), ${analysis.analyzedSec.toFixed(1)} s analyzed`,
        "success",
      );
      return analysis;
    })
    .catch((err) => {
      dbg(`[bpm] track ${trackId} failed: ${(err as Error).message}`);
      setState({ bpmLoadingTrackId: null });
      showStatus(`BPM analysis failed: ${(err as Error).message}`, "error");
      throw err;
    });
  runtime.bpmInflight.set(trackId, promise);
  await promise.catch(() => { /* status already shown */ });
}

/** Parallel analyses in the analyze-all pool (2 segment requests each). */
const ALL_CONCURRENCY = 3;

/** Store an analysis everywhere it lives: runtime cache, localStorage, UI. */
function recordAnalysis(trackId: number, analysis: BpmAnalysis): void {
  runtime.bpms.set(trackId, analysis);
  BpmStore.save(trackId, analysis);
  setState({ bpmValues: { ...getState().bpmValues, [trackId]: analysis.bpm } });
}

/**
 * Restore the analyses persisted in localStorage (BpmStore) into the runtime
 * cache and the UI state, so previously computed BPMs appear on the track
 * rows without a new analysis. Runs once at module load (this module is
 * imported by the track rows).
 */
function hydrateCachedAnalyses(): void {
  const stored = BpmStore.load();
  const bpms: Record<number, number> = {};
  for (const [id, analysis] of Object.entries(stored)) {
    if (!analysis || typeof analysis.bpm !== "number" || !Number.isFinite(analysis.bpm)) continue;
    const trackId = Number(id);
    if (!Number.isFinite(trackId)) continue;
    runtime.bpms.set(trackId, analysis);
    bpms[trackId] = analysis.bpm;
  }
  if (Object.keys(bpms).length > 0) {
    setState({ bpmValues: { ...getState().bpmValues, ...bpms } });
    dbg(`[bpm] restored ${Object.keys(bpms).length} cached BPM(s) from localStorage`);
  }
}
hydrateCachedAnalyses();

/**
 * Analyze the BPM of every track of the open playlist — including tracks not
 * yet fetched by the infinite scroll (the remaining pages are loaded first).
 * Skips cached ones. Runs a small parallel pool; a second click on the
 * toolbar button stops the remaining queue. Per-track failures are logged and
 * skipped, the rest of the batch continues.
 */
export async function analyzeAllTrackBpms(): Promise<void> {
  if (runtime.bpmAllRunning) {
    runtime.bpmAllStop = true; // second click: stop after the current batch
    return;
  }
  const alreadyAnalyzed = getState().tracks.filter((track) => runtime.bpms.has(track.id)).length;
  showStatus("Loading all tracks of the playlist…", "loading");
  const allTracks = await loadAllTracks();
  const pending = allTracks.filter((track) => !runtime.bpms.has(track.id));
  if (pending.length === 0) {
    showStatus(allTracks.length === 0
      ? "This playlist has no tracks"
      : `Every track already has a BPM (${alreadyAnalyzed || allTracks.length})`, "info");
    return;
  }
  runtime.bpmAllRunning = true;
  runtime.bpmAllStop = false;
  setState({ bpmAllRunning: true });
  showStatus(`Analyzing BPMs of ${pending.length} tracks… (click again to stop)`, "loading");
  let done = 0;
  let failed = 0;
  const analyzeOne = async (track: Track): Promise<void> => {
    try {
      const analysis = await analyzeBpm(track);
      if (!runtime.bpmAllStop) recordAnalysis(track.id, analysis);
    } catch (err) {
      failed += 1;
      dbg(`[bpm] analyze-all: track ${track.id} failed: ${(err as Error).message}`);
    }
    done += 1;
    showStatus(`Analyzing BPMs… ${done}/${pending.length} (click again to stop)`, "loading");
  };
  const queue = [...pending];
  await Promise.all(Array.from({ length: ALL_CONCURRENCY }, async () => {
    while (queue.length > 0 && !runtime.bpmAllStop) {
      const track = queue.shift()!;
      await analyzeOne(track);
    }
  }));
  runtime.bpmAllRunning = false;
  setState({ bpmAllRunning: false });
  if (runtime.bpmAllStop) {
    showStatus(`BPM analysis stopped — ${done} of ${pending.length} done`, "info");
  } else {
    showStatus(
      `BPMs analyzed for ${pending.length - failed} of ${pending.length} tracks`
      + (failed > 0 ? ` — ${failed} failed (no HLS stream?)` : ""),
      "success",
    );
  }
}
