/**
 * In-browser chroma analysis for harmonic key estimation (see
 * https://en.wikipedia.org/wiki/Chroma_feature).
 *
 * A track's key is estimated from **HLS mp3 segments spread across the
 * track** — no full download: the segments (~5–10 s each) are decoded, split
 * into ~4 s chunks, and every chunk into overlapping 8192-sample Hann
 * windows mapped onto the 12 pitch classes (chroma vectors). Silent chunks
 * are dropped, the chunk vectors averaged, and the best Krumhansl–Kessler
 * major/minor profile correlation names the key. Tracks without an HLS mp3
 * stream are analyzed from evenly spread windows of the whole-track source
 * playback falls back to (see services/analysis-source.ts).
 *
 * 8192 samples at 44.1 kHz give ~5.4 Hz frequency resolution — enough to
 * separate neighbouring semitones down to ~C2, which shorter windows cannot
 * (time–frequency trade-off).
 */

import { dbg } from "./debug";
import { ChromaStore } from "./config";
import { getState, runtime, setState, showStatus } from "./store";
import { loadAllTracks } from "./tracks";
import { fftRealMag, hannWindow } from "./audio";
import { ANALYSIS_DECODE_RATE, loadHlsStream, segmentMono, wholeTrackWindows } from "./analysis-source";
import type { ChromaAnalysis, HlsSegment, Track } from "../services/types";

/** FFT window length — sets the frequency resolution (~5.4 Hz @ 44.1 kHz). */
const FFT_SIZE = 8192;

/** Hop between consecutive analysis windows (50% overlap). */
const HOP_SIZE = 4096;

/** Lowest pitch frequency mapped into the chroma (~A1, bottom bin usable). */
const F_MIN = 55;

/** Highest pitch frequency mapped into the chroma (~C7, avoids hiss bins). */
const F_MAX = 2100;

/** Frames quieter than this fraction of the loudest frame are skipped. */
const SILENCE_GATE = 0.15;

/** Absolute RMS floor: chunks below this are silence, whatever the loudest.
 *  The relative gate alone cannot detect a wholly silent track. */
const SILENCE_FLOOR = 1e-4;

/** Segments analyzed per track, spread across the whole track. */
const SEGMENTS_PER_TRACK = 4;

/** Target duration (seconds) of one analysis chunk inside a segment. */
const CHUNK_SEC = 4;

/** Pitch-class names, chroma index order (C = 0). */
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"] as const;

/** Krumhansl–Kessler key profiles, indexed from the tonic (C). */
const KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KK_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

/** Key label of an analysis ("Am", "C#", …), the shape stored in state. */
function keyLabel(analysis: ChromaAnalysis): string {
  return analysis.tonic + (analysis.mode === "minor" ? "m" : "");
}

/**
 * Restore the analyses persisted in localStorage (ChromaStore) into the
 * runtime cache and the UI state, so previously computed keys appear on the
 * track rows without a new analysis. Runs once at module load (this module is
 * imported by the track rows).
 */
function hydrateCachedAnalyses(): void {
  const stored = ChromaStore.load();
  const keys: Record<number, string> = {};
  for (const [id, analysis] of Object.entries(stored)) {
    if (!analysis || typeof analysis.tonic !== "string" || !Array.isArray(analysis.chroma)) continue;
    const trackId = Number(id);
    if (!Number.isFinite(trackId)) continue;
    runtime.chromas.set(trackId, analysis);
    keys[trackId] = keyLabel(analysis);
  }
  if (Object.keys(keys).length > 0) {
    setState({ chromaKeys: { ...getState().chromaKeys, ...keys } });
    dbg(`[chroma] restored ${Object.keys(keys).length} cached key(s) from localStorage`);
  }
}
hydrateCachedAnalyses();

/** Lowest pitch frequency mapped into the chroma (~A1, bottom bin usable). */
export function binPitchClasses(sampleRate: number): Int8Array {
  const bins = FFT_SIZE / 2;
  const classes = new Int8Array(bins).fill(-1);
  for (let bin = 1; bin < bins; bin += 1) {
    const freq = (bin * sampleRate) / FFT_SIZE;
    if (freq < F_MIN || freq > F_MAX) continue;
    classes[bin] = ((Math.round(12 * Math.log2(freq / 440)) + 69) % 12 + 12) % 12;
  }
  return classes;
}

/** Pearson correlation coefficient of two 12-value vectors. */
function pearson(a: number[], b: number[]): number {
  const n = a.length;
  let sa = 0, sb = 0;
  for (let i = 0; i < n; i += 1) { sa += a[i]; sb += b[i]; }
  const ma = sa / n;
  const mb = sb / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i += 1) {
    const xa = a[i] - ma;
    const xb = b[i] - mb;
    num += xa * xb;
    da += xa * xa;
    db += xb * xb;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}

/** Best major/minor Krumhansl–Kessler profile match for a chroma vector. */
function estimateKey(chroma: number[]): { tonic: string; mode: "major" | "minor"; correlation: number } {
  let best: { tonic: string; mode: "major" | "minor"; correlation: number } | null = null;
  for (const [mode, profile] of [["major", KK_MAJOR], ["minor", KK_MINOR]] as const) {
    for (let rotation = 0; rotation < 12; rotation += 1) {
      // Profile rotated so its tonic sits on chroma index `rotation`.
      const aligned = profile.map((_, i) => profile[(i - rotation + 12) % 12]);
      const correlation = pearson(chroma, aligned);
      if (!best || correlation > best.correlation) {
        best = { tonic: NOTE_NAMES[rotation], mode, correlation };
      }
    }
  }
  return best!;
}

/**
 * Chroma vector of every ~CHUNK_SEC chunk of one decoded segment: frames are
 * grouped into chunks, each chunk normalised to a unit 12-vector, and chunks
 * whose mean energy is far below the loudest one (quiet lead/tail, gap) are
 * dropped so only musically active passages feed the estimate.
 */
function chunkChromas(
  mono: Float32Array,
  sampleRate: number,
  classes: Int8Array,
  window: Float64Array,
): number[][] {
  const half = FFT_SIZE / 2;
  const re = new Float64Array(half);
  const im = new Float64Array(half);
  const mag = new Float64Array(half);
  const frame = new Float64Array(FFT_SIZE);
  const energies: number[] = [];
  const perFrame: number[][] = [];
  for (let start = 0; start + FFT_SIZE <= mono.length; start += HOP_SIZE) {
    let rms = 0;
    for (let i = 0; i < FFT_SIZE; i += 1) {
      const sample = mono[start + i] * window[i];
      frame[i] = sample;
      rms += sample * sample;
    }
    energies.push(Math.sqrt(rms / FFT_SIZE));
    fftRealMag(frame, re, im, mag);
    const frameVec = new Array<number>(12).fill(0);
    for (let bin = 1; bin < half; bin += 1) {
      const pc = classes[bin];
      if (pc < 0) continue;
      const energy = mag[bin] * mag[bin];
      frameVec[pc] += energy;
    }
    perFrame.push(frameVec);
  }
  const framesPerChunk = Math.max(1, Math.round((CHUNK_SEC * sampleRate) / HOP_SIZE));
  const maxEnergy = energies.reduce((m, e) => Math.max(m, e), 0);
  const chunks: number[][] = [];
  for (let from = 0; from < perFrame.length; from += framesPerChunk) {
    const to = Math.min(perFrame.length, from + framesPerChunk);
    let energy = 0;
    const chunk = new Array<number>(12).fill(0);
    for (let f = from; f < to; f += 1) {
      energy += energies[f];
      for (let pc = 0; pc < 12; pc += 1) chunk[pc] += perFrame[f][pc];
    }
    if (maxEnergy > 0 && energy / (to - from) < SILENCE_GATE * maxEnergy) continue;
    if (energy / (to - from) < SILENCE_FLOOR) continue; // digitally silent
    const norm = Math.hypot(...chunk) || 1;
    chunks.push(chunk.map((v) => v / norm));
  }
  return chunks;
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

/** Chroma analysis of a track from segments spread across its whole length
 *  (whole-track source windows when no HLS mp3 stream exists). */
export async function analyzeChroma(track: Track): Promise<ChromaAnalysis> {
  const stream = await loadHlsStream(track);
  let decoded;
  let usedSegments: number;
  if (stream) {
    const chosen = pickSegments(stream.segments);
    usedSegments = chosen.length;
    // Cached across the BPM analyzer: segments the tempo tool already fetched
    // and decoded cost no network and no decode here (and vice versa).
    decoded = await Promise.all(chosen.map((index) => segmentMono(stream.segments, index)));
  } else {
    dbg(`[chroma] track ${track.id}: no HLS mp3 stream — falling back to whole-track windows`);
    decoded = await wholeTrackWindows(track);
    usedSegments = decoded.length;
  }
  const window = hannWindow(FFT_SIZE);
  const totalSec = decoded.reduce((sum, d) => sum + d.duration, 0);
  // Per-chunk chroma vectors from every segment, equally weighted (a segment
  // with more kept chunks doesn't dominate the estimate).
  const chunkVectors: number[][] = [];
  const classes = binPitchClasses(ANALYSIS_DECODE_RATE);
  for (const { samples, sampleRate } of decoded) {
    chunkVectors.push(...chunkChromas(samples, sampleRate, classes, window));
  }
  if (chunkVectors.length === 0) throw new Error("the analyzed segments are silent");
  const chroma = new Array<number>(12).fill(0);
  for (const vector of chunkVectors) {
    for (let pc = 0; pc < 12; pc += 1) chroma[pc] += vector[pc] / chunkVectors.length;
  }
  const norm = Math.hypot(...chroma) || 1;
  const normalized = chroma.map((v) => v / norm);
  const key = estimateKey(normalized);
  dbg(`[chroma] track ${track.id}: ${usedSegments} source window(s), ${chunkVectors.length} chunk(s), `
    + `${totalSec.toFixed(1)} s — chroma ` + normalized.map((v) => v.toFixed(3)).join(","));
  return {
    chroma: normalized, ...key,
    chunks: chunkVectors.length,
    analyzedSec: totalSec, segmentsUsed: usedSegments,
  };
}

/**
 * User-facing entry point: estimate (and cache) the key of one track, with
 * loading/success/error feedback in the status bar. Results land in
 * `state.chromaKeys` so the track rows can display them.
 */
export async function analyzeTrackChroma(trackId: number): Promise<void> {
  if (runtime.chromas.has(trackId) || runtime.chromaInflight.has(trackId)) return;
  const track = getState().tracks.find((t) => t.id === trackId);
  if (!track) return;
  setState({ chromaLoadingTrackId: trackId });
  showStatus(`Analyzing the key of “${track.title}” from ${SEGMENTS_PER_TRACK} spread segments…`);
  const promise = analyzeChroma(track)
    .then((analysis) => {
      runtime.chromas.set(trackId, analysis);
      ChromaStore.save(trackId, analysis);
      const label = keyLabel(analysis);
      setState({
        chromaKeys: { ...getState().chromaKeys, [trackId]: label },
        chromaLoadingTrackId: null,
      });
      showStatus(
        `Key of “${track.title}”: ${label} — ${analysis.mode} (r=${analysis.correlation.toFixed(2)}), `
        + `${analysis.segmentsUsed} segment(s), ${analysis.chunks} chunk(s), ${analysis.analyzedSec.toFixed(1)} s analyzed`,
        "success",
      );
      return analysis;
    })
    .catch((err) => {
      dbg(`[chroma] track ${trackId} failed: ${(err as Error).message}`);
      setState({ chromaLoadingTrackId: null });
      showStatus(`Chroma analysis failed: ${(err as Error).message}`, "error");
      throw err;
    });
  runtime.chromaInflight.set(trackId, promise);
  await promise.catch(() => { /* status already shown */ });
}

/** Parallel analyses in the analyze-all pool (2 segment requests each). */
const ALL_CONCURRENCY = 3;

/** Store an analysis everywhere it lives: runtime cache, localStorage, UI. */
function recordAnalysis(trackId: number, analysis: ChromaAnalysis): void {
  runtime.chromas.set(trackId, analysis);
  ChromaStore.save(trackId, analysis);
  setState({ chromaKeys: { ...getState().chromaKeys, [trackId]: keyLabel(analysis) } });
}

/**
 * Analyze the key of every track of the open playlist — including tracks not
 * yet fetched by the infinite scroll (the remaining pages are loaded first).
 * Skips cached ones. Runs a small parallel pool; a second click on the
 * toolbar button stops the remaining queue. Per-track failures are logged and
 * skipped, the rest of the batch continues.
 */
export async function analyzeAllTrackChromas(): Promise<void> {
  if (runtime.chromaAllRunning) {
    runtime.chromaAllStop = true; // second click: stop after the current batch
    return;
  }
  const alreadyAnalyzed = getState().tracks.filter((track) => runtime.chromas.has(track.id)).length;
  showStatus("Loading all tracks of the playlist…", "loading");
  const allTracks = await loadAllTracks();
  const pending = allTracks.filter((track) => !runtime.chromas.has(track.id));
  if (pending.length === 0) {
    showStatus(allTracks.length === 0
      ? "This playlist has no tracks"
      : `Every track already has a key (${alreadyAnalyzed || allTracks.length})`, "info");
    return;
  }
  runtime.chromaAllRunning = true;
  runtime.chromaAllStop = false;
  setState({ chromaAllRunning: true });
  showStatus(`Analyzing keys of ${pending.length} tracks… (click again to stop)`, "loading");
  let done = 0;
  let failed = 0;
  const analyzeOne = async (track: Track): Promise<void> => {
    try {
      const analysis = await analyzeChroma(track);
      if (!runtime.chromaAllStop) recordAnalysis(track.id, analysis);
    } catch (err) {
      failed += 1;
      dbg(`[chroma] analyze-all: track ${track.id} failed: ${(err as Error).message}`);
    }
    done += 1;
    showStatus(`Analyzing keys… ${done}/${pending.length} (click again to stop)`, "loading");
  };
  const queue = [...pending];
  await Promise.all(Array.from({ length: ALL_CONCURRENCY }, async () => {
    while (queue.length > 0 && !runtime.chromaAllStop) {
      const track = queue.shift()!;
      await analyzeOne(track);
    }
  }));
  runtime.chromaAllRunning = false;
  setState({ chromaAllRunning: false });
  if (runtime.chromaAllStop) {
    showStatus(`Key analysis stopped — ${done} of ${pending.length} done`, "info");
  } else {
    showStatus(
      `Keys analyzed for ${pending.length - failed} of ${pending.length} tracks`
      + (failed > 0 ? ` — ${failed} failed (no HLS stream?)` : ""),
      "success",
    );
  }
}
