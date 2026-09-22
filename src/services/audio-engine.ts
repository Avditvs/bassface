/**
 * Audio preview engine: locates and builds the audio source for a preview.
 *
 * Every preview streams the track window by window: HLS segments are
 * downloaded from the play position onward (0 for the play button, the
 * clicked position for waveform jumps) and extended while the playhead
 * approaches the end — appended to a MediaSource/SourceBuffer when the
 * browser supports MSE for mp3 (gapless appends, no element reload),
 * otherwise concatenated into a Blob that is hot-swapped on extension.
 * previewSource (whole-track Blob or direct src) only serves as the
 * fallback when no HLS segments exist.
 */

import { dbg } from "./debug";
import { getState } from "./store";
import {
  getAudio, previewRuntime, revokePreviewObjectUrl,
} from "./preview-runtime";
import type { HlsSegment, HlsStream, PreviewSource, Track } from "../services/types";

/** Cap how much audio one waveform jump may download in total (~10 min). */
const JUMP_MAX_SEGMENTS = 60;

/** Segments fetched per extension window — kept small to limit requests. */
const JUMP_WINDOW = 8;

/** Segments fetched before playback may start: two are enough to begin, the
 *  rest streams in right after via extendJumpWindow. */
const JUMP_START_SEGMENTS = 2;

/** Start extending the jump window when less audio remains than this. */
const EXTEND_AHEAD_SEC = 30;

/** Whether this browser can stream `mime` through MediaSource extensions. */
export function mseSupported(mime = "audio/mpeg"): boolean {
  try {
    return typeof MediaSource !== "undefined" && MediaSource.isTypeSupported(mime);
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

/** Append blobs in order (a SourceBuffer only accepts one append at a time).
 *  Appended audio is never removed from the buffer: played segments stay
 *  buffered for the whole preview, so seeking back into them is gapless
 *  (Chrome only evicts from the front under memory pressure, negligible
 *  for mp3). */
async function appendBlobs(sourceBuffer: SourceBuffer, blobs: Blob[]): Promise<void> {
  for (const blob of blobs) await appendBlob(sourceBuffer, blob);
}

/**
 * Build a gapless MSE jump source: the first two segments are appended to a
 * SourceBuffer so playback can start, later windows stream in via
 * extendJumpWindow. The audio element is attached to the MediaSource here
 * (sourceopen only fires on a bound element). Returns null to fall back to
 * the Blob hot-swap path (unsupported browser, MSE or append failure).
 */
async function loadStreamedJumpSource(
  audio: HTMLAudioElement,
  segments: HlsSegment[],
  starts: number[],
  at: { index: number; startSec: number },
  last: number,
  targetSec: number,
  streamTotalSec: number,
  mime: string,
): Promise<PreviewSource | null> {
  const firstEnd = Math.min(last, at.index + JUMP_START_SEGMENTS - 1);
  const { blobs, firstOk } = await fetchSegmentWindow(at.index, firstEnd, segments);
  if (firstOk < 0) return null;
  const mediaSource = new MediaSource();
  const url = URL.createObjectURL(mediaSource);
  try {
    audio.src = url;
    const sourceBuffer = await openSourceBuffer(audio, mediaSource, mime);
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
      streamDurationSec: streamTotalSec,
      jump: {
        segments, parts: [], nextIndex: firstEnd + 1, lastIndex: last,
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
 * Streaming source for previews: HLS segments are downloaded from the
 * requested position onward (bounded; 0 for the play button, the clicked
 * position for a waveform jump), so playback starts quickly and more audio
 * streams in later. Returns { url, kind: "full", seekOffset, originSec } —
 * with `blob` on the Blob path and `jump.streamed` on the MediaSource path.
 * Falls back to previewSource (full mp3 → then the seek works; truncated
 * source → playback starts at 0).
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
    const source = await getState().api!.previewSource(track, { onRaw, onError });
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

  let stream: HlsStream | null;
  try {
    stream = await getState().api!.hlsStream(track, { onRaw, onError });
  } catch (err) {
    onError?.(err);
    return fallback();
  }
  if (!stream) return fallback();
  const { segments, mime } = stream;
  const starts = segmentStarts(segments);
  // The waveform, the clicks and `track.duration` live on the track's
  // metadata timeline; the HLS stream may run slightly longer or shorter
  // (mp3 128 transcodes drift from the metadata duration). Map the jump
  // target onto the stream timeline so the audio sought is the audio at the
  // clicked waveform position, and expose the stream total so the playhead
  // and the time readout use the same timeline (no drift while playing).
  const streamTotalSec = starts[starts.length - 1] + (segments[segments.length - 1].duration || 0);
  const metaSec = track.duration > 0 ? track.duration / 1000 : 0;
  const streamSec = metaSec > 0 && streamTotalSec > 0 ? targetSec * (streamTotalSec / metaSec) : targetSec;
  if (Math.abs(streamTotalSec - metaSec) > 0.5) {
    dbg(`[preview] jump: stream runs ${streamTotalSec.toFixed(1)} s vs metadata ${metaSec.toFixed(1)} s — rescaled the target by ${(streamTotalSec / metaSec).toFixed(4)}`);
  }
  const at = segmentIndexAt(segments, streamSec);
  if (!at) return fallback();
  const last = Math.min(segments.length - 1, at.index + JUMP_MAX_SEGMENTS - 1);

  // Preferred path: stream the segments through a MediaSource (gapless).
  if (mseSupported(mime)) {
    const streamed = await loadStreamedJumpSource(audio, segments, starts, at, last, streamSec, streamTotalSec, mime);
    if (streamed) {
      dbg(`[preview] jump: streaming via MediaSource — ${JUMP_START_SEGMENTS} segments from ${(streamed.originSec ?? 0).toFixed(1)} s`);
      return streamed;
    }
  }

  // Blob path: fetch the first segments in parallel (one request per segment,
  // all at once, so playback can start quickly) and concatenate the blobs.
  const windowEnd = Math.min(last, at.index + JUMP_START_SEGMENTS - 1);
  const { blobs: parts, firstOk } = await fetchSegmentWindow(at.index, windowEnd, segments);
  if (firstOk < 0) return fallback();
  const originSec = starts[at.index + firstOk];
  dbg(`[preview] jump: ${parts.length} segments from ${originSec.toFixed(1)} s`);
  return {
    blob: new Blob(parts, { type: mime }),
    url: segments[at.index].url,
    kind: "full",
    seekOffset: Math.max(0, targetSec - originSec),
    originSec,
    streamDurationSec: streamTotalSec,
    // Bookkeeping for extendJumpWindow(): more segments stream in as the
    // playhead approaches the end of the downloaded audio.
    jump: { segments, parts, nextIndex: windowEnd + 1, lastIndex: last, mime },
  };
}

/**
 * Feed the next jump window to the preview: with MediaSource streaming the
 * fetched segments are simply appended to the SourceBuffer (gapless);
 * otherwise the playing Blob is hot-swapped to the extended concatenation
 * (a brief audible gap per swap). Called from timeupdate for every preview
 * that streams windows — play-from-start and waveform jumps alike.
 */
export async function extendJumpWindow(): Promise<void> {
  const p = previewRuntime;
  const audio = getAudio();
  if (!p.jump || p.extending) return;
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
    if (p.jump !== jump) return; // switched away meanwhile
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
    p.objectUrl = URL.createObjectURL(new Blob(jump.parts, { type: jump.mime ?? "audio/mpeg" }));
    audio.src = p.objectUrl;
    await waitForMetadata(audio);
    if (p.jump !== jump) return; // switched away during the swap
    audio.currentTime = resumeAt;
    // Re-read the intent after the swap: the pre-swap snapshot is stale once
    // the element was reloaded, and pausing during the swap (a tap on the
    // bar while a slow mobile network fetches the window) must not be undone
    // by the pending resume — otherwise the audio plays on behind a "paused"
    // UI and neither the play/pause nor the close button seem to stop it.
    if (wasPlaying && getState().previewPlaying) {
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
