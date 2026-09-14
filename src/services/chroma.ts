/**
 * In-browser chroma analysis for harmonic key estimation (see
 * https://en.wikipedia.org/wiki/Chroma_feature).
 *
 * A track's key is estimated from **1–2 of its HLS mp3 segments** — no full
 * download: two segments (~5–10 s each) from the musically active middle of
 * the track are decoded, split into overlapping 8192-sample Hann windows and
 * mapped onto the 12 pitch classes (the chroma vector). The best
 * Krumhansl–Kessler major/minor profile correlation names the key.
 *
 * 8192 samples at 44.1 kHz give ~5.4 Hz frequency resolution — enough to
 * separate neighbouring semitones down to ~C2, which shorter windows cannot
 * (time–frequency trade-off). Frames below 15% of the loudest frame's energy
 * are skipped so silent leads/tails never pollute the chroma.
 */

import { dbg } from "./debug";
import { ChromaStore } from "./config";
import { getState, runtime, setState, showStatus } from "./store";
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

/** HLS segments analyzed per track (the "1–2 windows" budget). */
const SEGMENTS_PER_TRACK = 2;

/** Where in the track the segments are taken from (avoid intro/outro). */
const SEGMENT_FRACTIONS = [0.3, 0.7];

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

/** Iterative radix-2 in-place FFT (n a power of two, |im| same length). */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tre = re[i]; re[i] = re[j]; re[j] = tre;
      const tim = im[i]; im[i] = im[j]; im[j] = tim;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < half; k += 1) {
        const aRe = re[i + k];
        const aIm = im[i + k];
        const bRe = re[i + k + half] * curRe - im[i + k + half] * curIm;
        const bIm = re[i + k + half] * curIm + im[i + k + half] * curRe;
        re[i + k] = aRe + bRe;
        im[i + k] = aIm + bIm;
        re[i + k + half] = aRe - bRe;
        im[i + k + half] = aIm - bIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

/** Average all channels into one mono Float32Array. */
function monoMixdown(buffer: AudioBuffer): Float32Array {
  const out = new Float32Array(buffer.length);
  for (let c = 0; c < buffer.numberOfChannels; c += 1) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < out.length; i += 1) out[i] += data[i] / buffer.numberOfChannels;
  }
  return out;
}

/** Pitch-class index of every FFT bin (−1 when outside [F_MIN, F_MAX]). */
function binPitchClasses(sampleRate: number): Int8Array {
  const bins = FFT_SIZE / 2;
  const classes = new Int8Array(bins).fill(-1);
  for (let bin = 1; bin < bins; bin += 1) {
    const freq = (bin * sampleRate) / FFT_SIZE;
    if (freq < F_MIN || freq > F_MAX) continue;
    classes[bin] = ((Math.round(12 * Math.log2(freq / 440)) + 69) % 12 + 12) % 12;
  }
  return classes;
}

/** Precomputed Hann window for the analysis frames. */
function hannWindow(): Float64Array {
  const window = new Float64Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i += 1) window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1)));
  return window;
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

/** Decode every segment blob in parallel (no user gesture needed). */
async function decodeBlobs(blobs: Blob[]): Promise<AudioBuffer[]> {
  // OfflineAudioContext decodes + resamples to a known rate without an
  // autoplay-policy warning; a real AudioContext would start suspended.
  const context = new OfflineAudioContext(1, 1, 44100);
  return Promise.all(blobs.map(async (blob) => context.decodeAudioData(await blob.arrayBuffer())));
}

/** Chroma vector of one decoded segment (frames averaged after the gate). */
function chromaOfBuffer(buffer: AudioBuffer, classes: Int8Array, window: Float64Array): { chroma: number[]; frames: number } {
  const mono = monoMixdown(buffer);
  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  const acc = new Array<number>(12).fill(0);
  const energies: number[] = [];
  const perFrame: number[][] = [];
  for (let start = 0; start + FFT_SIZE <= mono.length; start += HOP_SIZE) {
    let rms = 0;
    for (let i = 0; i < FFT_SIZE; i += 1) {
      const sample = mono[start + i] * window[i];
      re[i] = sample;
      im[i] = 0;
      rms += sample * sample;
    }
    energies.push(Math.sqrt(rms / FFT_SIZE));
    fft(re, im);
    const frame = new Array<number>(12).fill(0);
    for (let bin = 1; bin < FFT_SIZE / 2; bin += 1) {
      const pc = classes[bin];
      if (pc < 0) continue;
      const energy = re[bin] * re[bin] + im[bin] * im[bin];
      frame[pc] += energy;
      acc[pc] += energy;
    }
    perFrame.push(frame);
  }
  // Silence gate: drop the frames from quiet leads/tails, renormalise.
  const maxEnergy = energies.reduce((m, e) => Math.max(m, e), 0);
  const kept = new Array<number>(12).fill(0);
  let frames = 0;
  for (let f = 0; f < perFrame.length; f += 1) {
    if (maxEnergy > 0 && energies[f] < SILENCE_GATE * maxEnergy) continue;
    for (let pc = 0; pc < 12; pc += 1) kept[pc] += perFrame[f][pc];
    frames += 1;
  }
  const source = frames > 0 ? kept : acc; // never return all-zero chroma
  const norm = Math.hypot(...source) || 1;
  return { chroma: source.map((v) => v / norm), frames };
}

/** Pick `SEGMENTS_PER_TRACK` segment indexes spread over the track. */
function pickSegments(segments: HlsSegment[]): number[] {
  const indexes = SEGMENT_FRACTIONS
    .map((f) => Math.min(segments.length - 1, Math.floor(segments.length * f)))
    // A track shorter than the budget de-duplicates to a single segment.
    .filter((index, i, all) => all.indexOf(index) === i);
  return indexes.slice(0, SEGMENTS_PER_TRACK);
}

/** Chroma analysis of a track from 1–2 of its HLS segments. */
export async function analyzeChroma(track: Track): Promise<ChromaAnalysis> {
  const api = getState().api!;
  const segments = await api.hlsSegments(track);
  if (!segments) throw new Error("this track exposes no HLS mp3 stream to analyze");
  const chosen = pickSegments(segments);
  const blobs = await Promise.all(chosen.map((index) => api.fetchSegment(segments[index].url)));
  const buffers = await decodeBlobs(blobs);
  const window = hannWindow();
  const totalSec = buffers.reduce((sum, b) => sum + b.duration, 0);
  const chroma = new Array<number>(12).fill(0);
  let frames = 0;
  for (const buffer of buffers) {
    const part = chromaOfBuffer(buffer, binPitchClasses(buffer.sampleRate), window);
    for (let pc = 0; pc < 12; pc += 1) chroma[pc] += part.chroma[pc] / buffers.length;
    frames += part.frames;
  }
  const norm = Math.hypot(...chroma) || 1;
  const normalized = chroma.map((v) => v / norm);
  const key = estimateKey(normalized);
  dbg(`[chroma] track ${track.id}: ${chosen.length} segment(s), ${totalSec.toFixed(1)} s, ${frames} frames — chroma `
    + normalized.map((v) => v.toFixed(3)).join(","));
  return { chroma: normalized, ...key, frames, analyzedSec: totalSec, segmentsUsed: chosen.length };
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
  showStatus(`Analyzing the key of “${track.title}” from ${SEGMENTS_PER_TRACK} segments…`);
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
        + `${analysis.segmentsUsed} segment(s), ${analysis.analyzedSec.toFixed(1)} s analyzed`,
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
