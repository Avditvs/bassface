/**
 * Audio preview engine: locates and builds the audio source for a preview.
 *
 * Two strategies:
 *  - "jump": HLS segments downloaded from the clicked position onward, then
 *    extended window by window while the playhead approaches the end.
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

/**
 * Full-track source for waveform jumps: HLS segments are downloaded from the
 * clicked position onward (bounded), so the Blob's audio really starts at the
 * requested time. Returns { blob, url, kind: "full", seekOffset, originSec }
 * where seekOffset is where to start inside the Blob. Falls back to
 * previewSource (full mp3 → then the seek works; snippet → playback starts
 * at 0).
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
    segments = await getState().api!.hlsSegments(track, { onRaw, onError });
  } catch (err) {
    onError?.(err);
    segments = null;
  }
  if (!segments) {
    const source = await getState().api!.previewSource(track, { mode: "full", onRaw, onError });
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
    segments.slice(at.index, windowEnd + 1).map((segment) => getState().api!.fetchSegment(segment.url)),
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
  const p = previewRuntime;
  const audio = getAudio();
  if (p.mode !== "jump" || !p.jump || p.extending) return;
  const { segments, parts, nextIndex, lastIndex } = p.jump;
  if (nextIndex > lastIndex || parts.length === 0) return;
  if (!Number.isFinite(audio.duration) || audio.duration - audio.currentTime > EXTEND_AHEAD_SEC) return;
  p.extending = true;
  try {
    const end = Math.min(lastIndex, nextIndex + JUMP_WINDOW - 1);
    const results = await Promise.allSettled(
      segments.slice(nextIndex, end + 1).map((segment) => getState().api!.fetchSegment(segment.url)),
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
    const wasPlaying = getState().previewPlaying && !audio.paused;
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

/** Resolve when the element has metadata; rejects when loading errors out. */
export function waitForMetadata(audio: HTMLAudioElement): Promise<void> {
  if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) return Promise.resolve();
  return new Promise((resolve, reject) => {
    audio.addEventListener("loadedmetadata", () => resolve(), { once: true });
    audio.addEventListener("error", () => reject(new Error("the audio element could not load the stream")), { once: true });
  });
}
