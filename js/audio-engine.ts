/**
 * Audio preview engine: locates and builds the audio source for a preview.
 *
 * Three strategies:
 *  - "peak": full-track preview starting at the loudest 1-second window.
 *    Coarse pass from SoundCloud's waveform metadata (a few KB, no audio),
 *    then only the surrounding HLS segments are decoded; a full segment scan
 *    is the fallback when no waveform is available.
 *  - "jump": HLS segments downloaded from the clicked position onward, then
 *    extended window by window while the playhead approaches the end.
 *  - "start": handled by the API's previewSource (30 s snippet), not here.
 */

import { dbg } from "./debug.js";
import { state } from "./state.js";
import { el } from "./util.js";
import type { HlsSegment, PreviewSource, Track } from "./types.js";

/** Skip the (expensive) loudness decode on very long tracks. */
const PEAK_SCAN_MAX_MS = 8 * 60 * 1000;

/** Loudness needs nowhere near 48 kHz — decoding low-rate is ~6× cheaper. */
const PEAK_SCAN_SAMPLE_RATE = 8000;

/** Never scan more segments than the old truncated-blob behaviour fetched. */
const HLS_SCAN_MAX_SEGMENTS = 120;

/** Cap how much audio one waveform jump may download in total (~10 min). */
const JUMP_MAX_SEGMENTS = 60;

/** Segments fetched per jump window — kept small to limit requests. */
const JUMP_WINDOW = 8;

/** Start extending the jump window when less audio remains than this. */
const EXTEND_AHEAD_SEC = 30;

/** Result of the loudest-window scan. */
interface LoudestWindow {
  rms: number;
  offsetSec: number;
}

/** Segment scan candidate being tracked while scanning. */
interface SegmentCandidate {
  index: number;
  offsetSec: number;
  rms: number;
  blob: Blob;
  originSec: number;
}

/**
 * Loudest 1-second window of a decoded buffer, via a cumulative-energy
 * prefix sum: one O(n) pass, then every window's energy in O(1) — the exact
 * global maximum, no block-by-block nested scan. Returns {rms, offsetSec}.
 */
function loudestWindow(buffer: AudioBuffer): LoudestWindow | null {
  const samples = buffer.getChannelData(0);
  const windowSize = buffer.sampleRate;
  if (samples.length < windowSize) return samples.length > 0 ? { rms: 0, offsetSec: 0 } : null;
  const stride = Math.max(1, Math.floor(windowSize / 250)); // 250 points per window
  const count = Math.floor(samples.length / stride);
  const cum = new Float64Array(count + 1);
  for (let k = 0; k < count; k += 1) {
    const s = samples[k * stride];
    cum[k + 1] = cum[k] + s * s;
  }
  const win = Math.max(1, Math.floor(windowSize / stride)); // strided points per 1 s
  let bestK = 0;
  let bestE = -1;
  for (let k = 0; k + win <= count; k += 1) {
    const energy = cum[k + win] - cum[k];
    if (energy > bestE) {
      bestE = energy;
      bestK = k;
    }
  }
  return { rms: bestE / win, offsetSec: (bestK * stride) / buffer.sampleRate };
}

/** Index of the segment containing the given offset (from m3u8 durations). */
function segmentIndexAt(segments: HlsSegment[], offsetSec: number): { index: number; startSec: number } | null {
  let startSec = 0;
  for (const [index, segment] of segments.entries()) {
    const endSec = startSec + (segment.duration || 0);
    if (offsetSec < endSec || index === segments.length - 1) return { index, startSec };
    startSec = endSec;
  }
  return null;
}

/** Cumulative start time (seconds) of every segment, in order. */
function segmentStarts(segments: HlsSegment[]): number[] {
  const starts: number[] = [];
  let acc = 0;
  for (const segment of segments) {
    starts.push(acc);
    acc += segment.duration || 0;
  }
  return starts;
}

/** An AudioContext at the cheap peak-scan sample rate (falls back to default). */
async function createScanContext(): Promise<AudioContext> {
  try {
    return new AudioContext({ sampleRate: PEAK_SCAN_SAMPLE_RATE });
  } catch {
    return new AudioContext(); // low rate not supported: default quality
  }
}

/**
 * Coarse seconds offset of the centre of the loudest ~1-second window,
 * computed from SoundCloud's waveform metadata — no audio download.
 * Returns null when no usable waveform is available.
 */
async function waveformPeakOffset(track: Track): Promise<number | null> {
  const samples = await state.api!.waveformSamples(track);
  if (!samples || !(track.duration > 0)) return null;
  const perSampleSec = track.duration / 1000 / samples.length;
  const cum = new Float64Array(samples.length + 1);
  for (let k = 0; k < samples.length; k += 1) {
    const s = Number(samples[k]) || 0;
    cum[k + 1] = cum[k] + s * s;
  }
  const win = Math.max(1, Math.round(1 / perSampleSec)); // ~1 s of samples
  let bestK = 0;
  let bestE = -1;
  for (let k = 0; k + win <= samples.length; k += 1) {
    const energy = cum[k + win] - cum[k];
    if (energy > bestE) {
      bestE = energy;
      bestK = k;
    }
  }
  const offset = (bestK + win / 2) * perSampleSec;
  dbg(`[preview] waveform coarse peak at ${offset.toFixed(1)} s`);
  return offset;
}

/**
 * Waveform-guided peak: decode only the two segments around the coarse
 * waveform candidate and keep the true loudest 1-second window among them.
 * Returns the same shape as loadHlsPeak, or null when it fails.
 */
async function waveformGuidedPeak(
  segments: HlsSegment[],
  coarseSec: number,
  { onError = null }: { onError?: ((err: unknown) => void) | null } = {},
): Promise<PreviewSource | null> {
  const at = segmentIndexAt(segments, coarseSec);
  if (!at) return null;
  const starts = segmentStarts(segments);
  let context: AudioContext | undefined;
  try {
    context = await createScanContext();
    let best: SegmentCandidate | null = null;
    const last = Math.min(segments.length - 1, at.index + 1);
    for (let index = at.index; index <= last; index += 1) {
      let blob: Blob;
      try {
        blob = await state.api!.fetchSegment(segments[index].url);
      } catch (err) {
        dbg(`[preview] hls segment ${index} failed: ${err.message}`);
        continue;
      }
      const buffer = await context.decodeAudioData(await blob.arrayBuffer());
      const window = loudestWindow(buffer);
      if (window && (!best || window.rms > best.rms)) {
        best = { index, offsetSec: window.offsetSec, rms: window.rms, blob, originSec: starts[index] };
      }
    }
    if (!best) return null;

    // Keep the winning segment plus the next one, so playback continues
    // past the segment boundary instead of stopping abruptly.
    const parts: Blob[] = [best.blob];
    if (segments[best.index + 1]) {
      try {
        parts.push(await state.api!.fetchSegment(segments[best.index + 1].url));
      } catch { /* winner alone is fine */ }
    }
    dbg(`[preview] hls peak: segment ${best.index} @ ${best.offsetSec.toFixed(1)} s (waveform-guided)`);
    return {
      blob: new Blob(parts, { type: "audio/mpeg" }),
      url: segments[best.index].url,
      kind: "full",
      peakOffset: best.offsetSec,
      originSec: best.originSec,
    };
  } catch (err) {
    onError?.(err);
    return null;
  } finally {
    context?.close();
  }
}

/**
 * Full-track preview for the ⏫ button via HLS, jumping straight to the
 * loudest part (see the module doc). Returns { blob, url, kind: "full",
 * peakOffset } or null when the track offers no HLS mp3 stream (the caller
 * falls back to previewSource).
 */
export async function loadHlsPeak(
  track: Track,
  { onRaw = null, onError = null }: {
    onRaw?: ((streams: unknown) => void) | null;
    onError?: ((err: unknown) => void) | null;
  } = {},
): Promise<PreviewSource | null> {
  let segments: HlsSegment[] | null;
  try {
    segments = await state.api!.hlsSegments(track, { onRaw, onError });
  } catch (err) {
    onError?.(err);
    return null;
  }
  if (!segments) return null;

  const coarseSec = await waveformPeakOffset(track);
  if (coarseSec !== null) {
    const guided = await waveformGuidedPeak(segments, coarseSec, { onError });
    if (guided) return guided;
    dbg("[preview] hls peak: waveform-guided scan failed — falling back to full scan");
  }
  dbg(`[preview] hls peak: scanning ${segments.length} segments`);

  let context: AudioContext | undefined;
  try {
    context = await createScanContext();
    let best: SegmentCandidate & { url: string } | null = null;
    let startSec = 0;
    let scanned = 0;
    for (const [index, segment] of segments.entries()) {
      if (startSec * 1000 > PEAK_SCAN_MAX_MS || scanned >= HLS_SCAN_MAX_SEGMENTS) break;
      let blob: Blob;
      try {
        blob = await state.api!.fetchSegment(segment.url);
      } catch (err) {
        dbg(`[preview] hls segment ${index} failed: ${err.message}`);
        continue;
      }
      scanned += 1;
      const buffer = await context.decodeAudioData(await blob.arrayBuffer());
      const window = loudestWindow(buffer);
      if (window && (!best || window.rms > best.rms)) {
        best = { index, url: segment.url, offsetSec: window.offsetSec, rms: window.rms, blob, originSec: startSec };
      }
      startSec += segment.duration || buffer.duration;
    }
    if (!best) return null;
    dbg(`[preview] hls peak: full scan done — ${scanned} segments scored`);

    // Keep the winning segment plus the next one, so playback continues
    // past the segment boundary instead of stopping abruptly.
    const parts: Blob[] = [best.blob];
    if (segments[best.index + 1]) {
      try {
        parts.push(await state.api!.fetchSegment(segments[best.index + 1].url));
      } catch { /* winner alone is fine */ }
    }
    dbg(`[preview] hls peak: segment ${best.index} @ ${best.offsetSec.toFixed(1)} s`);
    return {
      blob: new Blob(parts, { type: "audio/mpeg" }),
      url: best.url,
      kind: "full",
      peakOffset: best.offsetSec,
      originSec: best.originSec,
    };
  } catch (err) {
    onError?.(err);
    return null;
  } finally {
    context?.close();
  }
}

/**
 * Full-track source for waveform jumps: HLS segments are downloaded from the
 * clicked position onward (bounded), so the Blob's audio really starts at the
 * requested time — unlike the peak source, which keeps only the loudest
 * segment. Returns { blob, url, kind: "full", seekOffset, originSec } where
 * seekOffset is where to start inside the Blob. Falls back to previewSource
 * (full mp3 → then the seek works; snippet → playback starts at 0).
 */
export async function loadJumpSource(
  track: Track,
  targetSec: number,
  { onRaw = null, onError = null }: {
    onRaw?: ((streams: unknown) => void) | null;
    onError?: ((err: unknown) => void) | null;
  } = {},
): Promise<PreviewSource | null> {
  let segments: HlsSegment[] | null;
  try {
    segments = await state.api!.hlsSegments(track, { onRaw, onError });
  } catch (err) {
    onError?.(err);
    segments = null;
  }
  if (!segments) {
    const source = await state.api!.previewSource(track, { mode: "peak", onRaw, onError });
    if (source && source.kind !== "full") dbg(`[preview] jump: only a ${source.kind} source exists — starting at 0`);
    return source;
  }
  const at = segmentIndexAt(segments, targetSec);
  if (!at) return null;
  const last = Math.min(segments.length - 1, at.index + JUMP_MAX_SEGMENTS - 1);
  const windowEnd = Math.min(last, at.index + JUMP_WINDOW - 1);
  const starts = segmentStarts(segments);
  // Fetch the first window in parallel: one request per segment, but all at
  // once, so playback can start quickly. Failed segments leave a hole (the
  // preview just skips them).
  const results = await Promise.allSettled(
    segments.slice(at.index, windowEnd + 1).map((segment) => state.api!.fetchSegment(segment.url)),
  );
  const parts = results
    .filter((r): r is PromiseFulfilledResult<Blob> => r.status === "fulfilled")
    .map((r) => r.value);
  const originSec = starts[at.index + results.findIndex((r) => r.status === "fulfilled")];
  if (!parts.length) return null;
  dbg(`[preview] jump: ${parts.length} segments from ${originSec.toFixed(1)} s`);
  return {
    blob: new Blob(parts, { type: "audio/mpeg" }),
    url: segments[at.index].url,
    kind: "full",
    seekOffset: Math.max(0, targetSec - originSec),
    originSec,
    // Bookkeeping for extendJumpWindow(): more segments stream in as the
    // playhead approaches the end of the downloaded audio.
    jump: { segments, parts, nextIndex: windowEnd + 1, lastIndex: last },
  };
}

/**
 * Fetch the next jump window and hot-swap the playing blob when the playhead
 * gets close to the end of the downloaded audio (called from timeupdate).
 */
export async function extendJumpWindow(): Promise<void> {
  const p = state.preview;
  const audio = el<HTMLAudioElement>("preview-audio");
  if (p.mode !== "jump" || !p.jump || p.extending) return;
  const { segments, parts, nextIndex, lastIndex } = p.jump;
  if (nextIndex > lastIndex || parts.length === 0) return;
  if (!Number.isFinite(audio.duration) || audio.duration - audio.currentTime > EXTEND_AHEAD_SEC) return;
  p.extending = true;
  try {
    const end = Math.min(lastIndex, nextIndex + JUMP_WINDOW - 1);
    const results = await Promise.allSettled(
      segments.slice(nextIndex, end + 1).map((segment) => state.api!.fetchSegment(segment.url)),
    );
    if (p.mode !== "jump" || !p.blob) return; // switched away meanwhile
    const fetched = results
      .filter((r): r is PromiseFulfilledResult<Blob> => r.status === "fulfilled")
      .map((r) => r.value);
    if (!fetched.length) return;
    parts.push(...fetched);
    p.jump.nextIndex = end + 1;
    // Swap in the extended blob without losing the playhead.
    const resumeAt = audio.currentTime;
    const wasPlaying = p.playing && !audio.paused;
    revokePreviewObjectUrl();
    p.objectUrl = URL.createObjectURL(new Blob(parts, { type: "audio/mpeg" }));
    audio.src = p.objectUrl;
    await waitForMetadata(audio);
    if (p.mode !== "jump") return; // switched away during the swap
    audio.currentTime = resumeAt;
    if (wasPlaying) {
      try { await audio.play(); } catch { /* retried on next click */ }
    }
    dbg(`[preview] jump window extended — ${parts.length} segments buffered`);
  } finally {
    p.extending = false;
  }
}

/**
 * Seconds offset of the loudest 1-second window in a downloaded mp3 blob
 * (fallback path when no HLS stream exists). Returns null when the track is
 * too long to decode comfortably or the decode fails.
 */
export async function loudestOffsetSeconds(blob: Blob, track: Track): Promise<number | null> {
  if ((track.duration ?? 0) > PEAK_SCAN_MAX_MS) return null;
  let context: AudioContext | undefined;
  try {
    context = await createScanContext();
    const buffer = await context.decodeAudioData(await blob.arrayBuffer());
    const window = loudestWindow(buffer);
    return window ? window.offsetSec : 0;
  } catch {
    return null; // start from the beginning instead
  } finally {
    context?.close();
  }
}

/** Resolve when the element has metadata; rejects when loading errors out. */
export function waitForMetadata(audio: HTMLAudioElement): Promise<void> {
  if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) return Promise.resolve();
  return new Promise((resolve, reject) => {
    audio.addEventListener("loadedmetadata", () => resolve(), { once: true });
    audio.addEventListener("error", () => reject(new Error("the audio element could not load the stream")), { once: true });
  });
}

/** Free the blob backing the current preview, if any. */
export function revokePreviewObjectUrl(): void {
  if (state.preview.objectUrl) {
    URL.revokeObjectURL(state.preview.objectUrl);
    state.preview.objectUrl = null;
  }
}
