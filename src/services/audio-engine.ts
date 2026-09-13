/**
 * Audio preview engine: locates and builds the audio source for a preview.
 *
 * Two strategies:
 *  - "jump": HLS segments downloaded from the clicked position onward, then
 *    extended window by window while the playhead approaches the end.
 *    Segments stream through a MediaSource/SourceBuffer when the browser
 *    supports MSE for mp3 — appends are gapless and the element never
 *    reloads. Otherwise they are concatenated into a Blob that is
 *    hot-swapped on extension (a brief audible gap per swap).
 *  - "start": handled by the API's previewSource (30 s snippet), not here.
 */

import { dbg } from "./debug";
import { getState } from "./store";
import {
  getAudio, previewRuntime, revokePreviewObjectUrl,
} from "./preview-runtime";
import type { HlsSegment, PreviewSource, Track } from "../services/types";

/** Cap how much audio one waveform jump may download in total (~10 min). */
const JUMP_MAX_SEGMENTS = 60;

/** Segments fetched per jump window — kept small to limit requests. */
const JUMP_WINDOW = 8;

/** Start extending the jump window when less audio remains than this. */
const EXTEND_AHEAD_SEC = 30;

/** MIME handed to the MediaSource for streamed jump previews. */
const MSE_MIME = "audio/mpeg";

/** Whether this browser can stream mp3 through MediaSource extensions. */
export function mseSupported(): boolean {
  try {
    return typeof MediaSource !== "undefined" && MediaSource.isTypeSupported(MSE_MIME);
  } catch {
    return false;
  }
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

/** Fetch segments[from..to] in parallel; resolves the fulfilled blobs in
 *  order plus the offset (relative to `from`) of the first success. Failed
 *  segments leave a hole (the preview just skips them). */
async function fetchSegmentWindow(from: number, to: number, segments: HlsSegment[]): Promise<{ blobs: Blob[]; firstOk: number }> {
  const results = await Promise.allSettled(
    segments.slice(from, to + 1).map((segment) => getState().api!.fetchSegment(segment.url)),
  );
  const firstOk = results.findIndex((r) => r.status === "fulfilled");
  const blobs = results
    .filter((r): r is PromiseFulfilledResult<Blob> => r.status === "fulfilled")
    .map((r) => r.value);
  return { blobs, firstOk };
}

/**
 * End (local timeline, seconds) of the audio the element actually holds
 * buffered. On the Blob path this equals the loaded duration; on the
 * MediaSource path the duration already covers the whole (future) window,
 * so only the buffered range is really playable right now.
 */
export function bufferedEndSec(audio: HTMLAudioElement): number {
  return audio.buffered.length > 0 ? audio.buffered.end(audio.buffered.length - 1) : 0;
}

/** Resolve with a SourceBuffer of `mime` once the attached MediaSource opens.
 *  Rejects if the element errors out before that (broken object URL, …). */
function openSourceBuffer(audio: HTMLAudioElement, mediaSource: MediaSource, mime: string): Promise<SourceBuffer> {
  if (mediaSource.readyState === "open") return Promise.resolve(mediaSource.addSourceBuffer(mime));
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      mediaSource.removeEventListener("sourceopen", onOpen);
      audio.removeEventListener("error", onError);
    };
    const onOpen = () => {
      cleanup();
      try {
        resolve(mediaSource.addSourceBuffer(mime));
      } catch (err) {
        reject(err);
      }
    };
    const onError = () => {
      cleanup();
      reject(new Error("the audio element could not open the MediaSource"));
    };
    mediaSource.addEventListener("sourceopen", onOpen);
    audio.addEventListener("error", onError);
  });
}

/** Append one blob to the buffer; resolves after the append completes. */
function appendBlob(sourceBuffer: SourceBuffer, blob: Blob): Promise<void> {
  return blob.arrayBuffer().then((data) => new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      sourceBuffer.removeEventListener("updateend", onEnd);
      sourceBuffer.removeEventListener("error", onErr);
    };
    const onEnd = () => { cleanup(); resolve(); };
    const onErr = () => { cleanup(); reject(new Error("the SourceBuffer rejected a segment")); };
    sourceBuffer.addEventListener("updateend", onEnd);
    sourceBuffer.addEventListener("error", onErr);
    try {
      sourceBuffer.appendBuffer(data);
    } catch (err) {
      cleanup();
      reject(err);
    }
  }));
}

/** Append blobs in order (a SourceBuffer only accepts one append at a time). */
async function appendBlobs(sourceBuffer: SourceBuffer, blobs: Blob[]): Promise<void> {
  for (const blob of blobs) await appendBlob(sourceBuffer, blob);
}

/**
 * Build a gapless MSE jump source: the first window's segments are appended
 * to a SourceBuffer, later windows stream in via extendJumpWindow. The audio
 * element is attached to the MediaSource here (sourceopen only fires on a
 * bound element). Returns null to fall back to the Blob hot-swap path
 * (unsupported browser, MSE or append failure).
 */
async function loadStreamedJumpSource(
  audio: HTMLAudioElement,
  segments: HlsSegment[],
  starts: number[],
  at: { index: number; startSec: number },
  last: number,
  targetSec: number,
): Promise<PreviewSource | null> {
  const windowEnd = Math.min(last, at.index + JUMP_WINDOW - 1);
  const { blobs, firstOk } = await fetchSegmentWindow(at.index, windowEnd, segments);
  if (firstOk < 0) return null;
  const mediaSource = new MediaSource();
  const url = URL.createObjectURL(mediaSource);
  try {
    audio.src = url;
    const sourceBuffer = await openSourceBuffer(audio, mediaSource, MSE_MIME);
    // Local timeline of the streamed window: 0 = start of the first segment
    // whose content really got appended (failed ones leave a hole).
    const originSec = starts[at.index + firstOk];
    let span = 0;
    for (let i = at.index; i <= last; i += 1) span += segments[i].duration || 0;
    mediaSource.duration = Math.max(span, 1);
    await appendBlobs(sourceBuffer, blobs);
    return {
      url,
      kind: "full",
      seekOffset: Math.max(0, targetSec - originSec),
      originSec,
      jump: {
        segments, parts: [], nextIndex: windowEnd + 1, lastIndex: last,
        streamed: true, sourceBuffer, mediaSource,
      },
    };
  } catch (err) {
    dbg(`[preview] jump: MediaSource streaming failed (${(err as Error).message}) — falling back to the Blob path`);
    URL.revokeObjectURL(url); // the fallback assigns another src right after
    return null;
  }
}

/**
 * Full-track source for waveform jumps: HLS segments are downloaded from the
 * clicked position onward (bounded), so the audio really starts at the
 * requested time. Returns { url, kind: "full", seekOffset, originSec } —
 * with `blob` on the Blob path and `jump.streamed` on the MediaSource path.
 * Falls back to previewSource (full mp3 → then the seek works; snippet →
 * playback starts at 0).
 */
export async function loadJumpSource(
  track: Track,
  targetSec: number,
  audio: HTMLAudioElement,
  { onRaw = null, onError = null }: {
    onRaw?: ((streams: unknown) => void) | null;
    onError?: ((err: unknown) => void) | null;
  } = {},
): Promise<PreviewSource | null> {
  /** Fallback when the segmented jump is impossible: fetch a whole-track
   *  source and seek inside it when it really covers the full track. */
  const fallback = async (): Promise<PreviewSource | null> => {
    const source = await getState().api!.previewSource(track, { mode: "full", onRaw, onError });
    if (source && source.kind !== "full") dbg(`[preview] jump: only a ${source.kind} source exists — starting at 0`);
    // A complete full-track Blob starts at the track's position 0, so the
    // requested jump position is a plain seek inside it. Without this, the
    // fallback (no HLS segments available) would start playback at 0.
    if (source?.kind === "full" && source.complete) {
      source.originSec = 0;
      source.seekOffset = Math.max(0, targetSec);
    } else if (source?.kind === "full") {
      dbg("[preview] jump: full source is truncated — starting at 0");
    }
    return source;
  };

  let segments: HlsSegment[] | null;
  try {
    segments = await getState().api!.hlsSegments(track, { onRaw, onError });
  } catch (err) {
    onError?.(err);
    return fallback();
  }
  if (!segments) return fallback();
  const at = segmentIndexAt(segments, targetSec);
  if (!at) return fallback();
  const last = Math.min(segments.length - 1, at.index + JUMP_MAX_SEGMENTS - 1);
  const starts = segmentStarts(segments);

  // Preferred path: stream the segments through a MediaSource (gapless).
  if (mseSupported()) {
    const streamed = await loadStreamedJumpSource(audio, segments, starts, at, last, targetSec);
    if (streamed) {
      dbg(`[preview] jump: streaming via MediaSource — ${JUMP_WINDOW} segments from ${(streamed.originSec ?? 0).toFixed(1)} s`);
      return streamed;
    }
  }

  // Blob path: fetch the first window in parallel (one request per segment,
  // all at once, so playback can start quickly) and concatenate the blobs.
  const windowEnd = Math.min(last, at.index + JUMP_WINDOW - 1);
  const { blobs: parts, firstOk } = await fetchSegmentWindow(at.index, windowEnd, segments);
  if (firstOk < 0) return fallback();
  const originSec = starts[at.index + firstOk];
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
 * Feed the next jump window to the preview: with MediaSource streaming the
 * fetched segments are simply appended to the SourceBuffer (gapless);
 * otherwise the playing Blob is hot-swapped to the extended concatenation
 * (a brief audible gap per swap). Called from timeupdate.
 */
export async function extendJumpWindow(): Promise<void> {
  const p = previewRuntime;
  const audio = getAudio();
  if (p.mode !== "jump" || !p.jump || p.extending) return;
  const jump = p.jump;
  if (jump.nextIndex > jump.lastIndex) return;
  if (!jump.streamed && jump.parts.length === 0) return;
  // Buffered time ahead of the playhead: on the Blob path the blob holds
  // everything downloaded so far (audio.duration); on the MediaSource path
  // the duration already covers the whole window, so use the buffered range.
  const ahead = jump.streamed
    ? bufferedEndSec(audio) - audio.currentTime
    : audio.duration - audio.currentTime;
  if (!Number.isFinite(ahead) || ahead > EXTEND_AHEAD_SEC) return;
  p.extending = true;
  try {
    const end = Math.min(jump.lastIndex, jump.nextIndex + JUMP_WINDOW - 1);
    const { blobs: fetched, firstOk } = await fetchSegmentWindow(jump.nextIndex, end, jump.segments);
    if (p.mode !== "jump" || p.jump !== jump) return; // switched away meanwhile
    if (firstOk < 0) return;
    if (jump.streamed && jump.sourceBuffer) {
      // The mp3 segments append in order and their frames continue the
      // timeline: playback never reloads the element, so it stays gapless.
      try {
        await appendBlobs(jump.sourceBuffer, fetched);
      } catch (err) {
        dbg(`[preview] jump append failed: ${(err as Error).message}`);
        return;
      }
      jump.nextIndex = end + 1;
      if (jump.nextIndex > jump.lastIndex && jump.mediaSource) {
        try { jump.mediaSource.endOfStream(); } catch { /* already ended */ }
      }
      dbg(`[preview] jump window appended — ${jump.nextIndex} of ${jump.lastIndex + 1} segments streamed`);
      return;
    }
    // Blob hot-swap path (browsers without MSE mp3 support).
    jump.parts.push(...fetched);
    jump.nextIndex = end + 1;
    // Swap in the extended blob without losing the playhead.
    const resumeAt = audio.currentTime;
    const wasPlaying = getState().previewPlaying && !audio.paused;
    revokePreviewObjectUrl();
    p.objectUrl = URL.createObjectURL(new Blob(jump.parts, { type: "audio/mpeg" }));
    audio.src = p.objectUrl;
    await waitForMetadata(audio);
    if (p.mode !== "jump" || p.jump !== jump) return; // switched away during the swap
    audio.currentTime = resumeAt;
    if (wasPlaying) {
      try { await audio.play(); } catch { /* retried on next click */ }
    }
    dbg(`[preview] jump window extended — ${jump.parts.length} segments buffered`);
  } finally {
    p.extending = false;
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
