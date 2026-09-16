/**
 * Audio analysis primitives shared by the in-browser analyzers (chroma key
 * estimation, BPM estimation): an iterative radix-2 FFT, mono mixdown and
 * off-main-thread-free blob decoding via OfflineAudioContext.
 */

/**
 * Iterative radix-2 in-place FFT (n a power of two, |im| same length).
 * Fills `re`/`im` with the transform; the arrays are reused by the caller.
 */
export function fft(re: Float64Array, im: Float64Array): void {
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

/** Precomputed Hann window of the given length (periodic convention). */
export function hannWindow(length: number): Float64Array {
  const window = new Float64Array(length);
  for (let i = 0; i < length; i += 1) window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (length - 1)));
  return window;
}

/** Average all channels of an AudioBuffer into one mono Float32Array. */
export function monoMixdown(buffer: AudioBuffer): Float32Array {
  const out = new Float32Array(buffer.length);
  for (let c = 0; c < buffer.numberOfChannels; c += 1) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < out.length; i += 1) out[i] += data[i] / buffer.numberOfChannels;
  }
  return out;
}

/** Cached half-spectrum twiddle factors (cos/sin of −2πk/n), per FFT size. */
const twiddleCache = new Map<number, { cos: Float64Array; sin: Float64Array }>();

function halfTwiddles(half: number): { cos: Float64Array; sin: Float64Array } {
  let table = twiddleCache.get(half);
  if (!table) {
    const cos = new Float64Array(half);
    const sin = new Float64Array(half);
    for (let k = 0; k < half; k += 1) {
      const angle = (-2 * Math.PI * k) / (2 * half);
      cos[k] = Math.cos(angle);
      sin[k] = Math.sin(angle);
    }
    table = { cos, sin };
    twiddleCache.set(half, table);
  }
  return table;
}

/**
 * Magnitude spectrum of a **real** signal of length n (a power of two), via a
 * half-size complex FFT + untangling (classic real-FFT trick) — half the cost
 * of a full complex FFT, which every spectral analyzer here can use since it
 * only consumes bin magnitudes. `re`/`im` are length-n/2 scratch arrays,
 * `mag` receives bins 0..n/2−1 (bin 0 set to 0: nobody uses DC).
 */
export function fftRealMag(
  input: Float64Array,
  re: Float64Array,
  im: Float64Array,
  mag: Float64Array,
): void {
  const half = input.length >> 1;
  // Pack the even samples as the real part, odd as the imaginary part.
  for (let i = 0; i < half; i += 1) {
    re[i] = input[2 * i];
    im[i] = input[2 * i + 1];
  }
  fft(re, im);
  // Untangle: X[k] = Fe[k] + W[k]·Fo[k] with Fe/Fo the even/odd parts.
  const { cos, sin } = halfTwiddles(half);
  mag[0] = 0;
  for (let k = 1; k < half; k += 1) {
    const mk = half - k;
    const feRe = (re[k] + re[mk]) / 2;
    const feIm = (im[k] - im[mk]) / 2;
    const foRe = (im[k] + im[mk]) / 2;
    const foIm = (re[mk] - re[k]) / 2;
    const wRe = cos[k];
    const wIm = sin[k];
    const xRe = feRe + foRe * wRe - foIm * wIm;
    const xIm = feIm + foRe * wIm + foIm * wRe;
    // sqrt of squares: hypot's edge-case handling is slow and unnecessary
    // for bounded audio magnitudes.
    mag[k] = Math.sqrt(xRe * xRe + xIm * xIm);
  }
}

/**
 * Decode every blob in parallel to an AudioBuffer at `sampleRate`
 * (no user gesture needed).
 */
async function decodeBlobs(blobs: Blob[], sampleRate = 44100): Promise<AudioBuffer[]> {
  // OfflineAudioContext decodes + resamples to a known rate without an
  // autoplay-policy warning; a real AudioContext would start suspended.
  const context = new OfflineAudioContext(1, 1, sampleRate);
  return Promise.all(blobs.map(async (blob) => context.decodeAudioData(await blob.arrayBuffer())));
}

/** A decoded segment reduced to mono samples, with its timing. */
export interface DecodedMono {
  samples: Float32Array;
  sampleRate: number;
  duration: number;
}

/** Cached segment blobs: both analyzers request the same HLS segments, so
 *  the second tool skips the network entirely. Bounded FIFO (a ~10 s mp3
 *  segment is ~160 KB). */
const BLOB_CACHE_MAX = 128;

/** Cached decoded mono segments — skips re-decoding recently used segments
 *  (a ~10 s mono buffer at 44.1 kHz is ~1.8 MB). Bounded FIFO. */
const MONO_CACHE_MAX = 24;

const blobCache = new Map<string, Blob>();
const monoCache = new Map<string, DecodedMono>();

/** Drop oldest entries (Map iteration order) while the cache is over budget. */
function evictOldest<T>(cache: Map<string, T>, max: number): void {
  while (cache.size >= max) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** Fetch (or recall from cache) one segment blob through the given fetcher. */
export async function fetchSegmentBlob(fetcher: (url: string) => Promise<Blob>, url: string): Promise<Blob> {
  const hit = blobCache.get(url);
  if (hit) return hit;
  const blob = await fetcher(url);
  evictOldest(blobCache, BLOB_CACHE_MAX);
  blobCache.set(url, blob);
  return blob;
}

/** Decode (or recall from cache) a segment blob as mono samples at
 *  `sampleRate`. The cache is keyed by rate + URL, so the chroma (44.1 kHz)
 *  and BPM (decimated afterwards) analyses share the fetched blobs. */
export async function decodeMono(blob: Blob, url: string, sampleRate: number): Promise<DecodedMono> {
  const key = `${sampleRate}|${url}`;
  const hit = monoCache.get(key);
  if (hit) return hit;
  const buffer = (await decodeBlobs([blob], sampleRate))[0];
  const decoded: DecodedMono = {
    samples: monoMixdown(buffer),
    sampleRate: buffer.sampleRate,
    duration: buffer.duration,
  };
  evictOldest(monoCache, MONO_CACHE_MAX);
  monoCache.set(key, decoded);
  return decoded;
}

/** Floor for short sources split into equal analysis windows (seconds). */
const MIN_WINDOW_SEC = 5;

/**
 * Slice a whole-track mono buffer into `count` analysis windows. Long tracks
 * get `count` windows of `windowSec` seconds spread evenly (centres at
 * (i+1)/(count+1) of the timeline, so the quiet lead-in/outro stay clear).
 * Shorter sources (e.g. the ~30 s preview snippet) are split into
 * non-overlapping equal windows covering them entirely, keeping each window
 * at least MIN_WINDOW_SEC long. Windows are copies, so the decoded parent
 * can be released once the slices are cached.
 */
export function sliceAnalysisWindows(mono: DecodedMono, count: number, windowSec: number): DecodedMono[] {
  const maxWindowLen = Math.round(windowSec * mono.sampleRate);
  if (mono.samples.length <= maxWindowLen) return [mono];
  if (mono.samples.length <= count * maxWindowLen) {
    const minLen = Math.round(MIN_WINDOW_SEC * mono.sampleRate);
    const n = Math.max(1, Math.min(count, Math.floor(mono.samples.length / minLen)));
    const len = Math.floor(mono.samples.length / n);
    const windows: DecodedMono[] = [];
    for (let i = 0; i < n; i += 1) {
      windows.push({
        samples: mono.samples.slice(i * len, (i + 1) * len),
        sampleRate: mono.sampleRate,
        duration: len / mono.sampleRate,
      });
    }
    return windows;
  }
  const windowLen = maxWindowLen;
  const windows: DecodedMono[] = [];
  for (let i = 0; i < count; i += 1) {
    const center = ((i + 1) / (count + 1)) * mono.samples.length;
    const start = Math.max(0, Math.min(mono.samples.length - windowLen, Math.round(center - windowLen / 2)));
    windows.push({
      samples: mono.samples.slice(start, start + windowLen),
      sampleRate: mono.sampleRate,
      duration: windowLen / mono.sampleRate,
    });
  }
  return windows;
}

/** Decode a single blob to an AudioBuffer at `sampleRate` (no caching —
 *  callers decide what to keep; used for whole-track fallback decodes). */
export async function decodeBlobMono(blob: Blob, sampleRate = 44100): Promise<DecodedMono> {
  const buffer = (await decodeBlobs([blob], sampleRate))[0];
  return {
    samples: monoMixdown(buffer),
    sampleRate: buffer.sampleRate,
    duration: buffer.duration,
  };
}

/** Halve the sample rate by averaging adjacent samples (cheap anti-aliasing
 *  decimation) — tempo analysis does not need 44.1 kHz. */
export function decimate2(samples: Float32Array): Float32Array {
  const out = new Float32Array(samples.length >> 1);
  for (let i = 0; i < out.length; i += 1) out[i] = (samples[2 * i] + samples[2 * i + 1]) / 2;
  return out;
}
