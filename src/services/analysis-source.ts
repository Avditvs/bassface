/**
 * Shared audio loader for the in-browser analyzers (chroma key, BPM).
 *
 * Tracks are analyzed from HLS mp3 segments when the track offers them —
 * the same segment streaming playback uses — with the fetched blobs and
 * decoded buffers shared across the two analyzers through the caches in
 * audio.ts. When a track exposes no HLS mp3 playlist, the analyzers fall
 * back to windows sliced from the whole-track preview source (the direct
 * mp3 Blob or the legacy stream download — whatever playback would fall
 * back to), so every track that can play can also be analyzed.
 */

import { dbg } from "./debug";
import { getState } from "./store";
import { decodeBlobMono, decodeMono, fetchSegmentBlob, sliceAnalysisWindows } from "./audio";
import type { DecodedMono } from "./audio";
import type { HlsSegment, HlsStream, Track } from "./types";

/** Decode rate of the fetched audio — shared by both analyzers so they
 *  reuse the same cached segment blobs and decodings. */
export const ANALYSIS_DECODE_RATE = 44100;

/** Whole-track fallback: windows sliced from the decoded track. */
const WHOLE_TRACK_WINDOWS = 4;

/** Whole-track fallback: duration (seconds) of one sliced window. */
const WHOLE_TRACK_WINDOW_SEC = 25;

/** Bounded FIFO of whole-track fallbacks, keyed by track id: the decoded
 *  mono track (~4 bytes × 44100 × seconds — a few tens of MB) plus its
 *  slices stay shared between the chroma and BPM analyzers. */
const WHOLE_TRACK_CACHE_MAX = 2;

const wholeTrackCache = new Map<number, DecodedMono[]>();

/** Best HLS playlist of the track (mp3 preferred, aac fallback, then the
 *  track's HLS transcodings), or null when it exposes none — callers then
 *  fall back to the whole-track source. */
export function loadHlsStream(track: Track): Promise<HlsStream | null> {
  return getState().api!.hlsStream(track);
}

/** Fetch (or recall from cache) one HLS segment decoded to mono samples at
 *  the shared analysis rate. */
export async function segmentMono(segments: HlsSegment[], index: number): Promise<DecodedMono> {
  const segment = segments[index];
  const blob = await fetchSegmentBlob((url) => getState().api!.fetchSegment(url), segment.url);
  return decodeMono(blob, segment.url, ANALYSIS_DECODE_RATE);
}

/**
 * Whole-track fallback: decode the source playback would use (previewSource
 * — direct mp3 Blob, or the legacy stream URL downloaded for the purpose)
 * and slice it into evenly spread analysis windows. The decoded track is
 * cached per track id so the second analyzer skips the download and decode.
 */
export async function wholeTrackWindows(track: Track): Promise<DecodedMono[]> {
  const hit = wholeTrackCache.get(track.id);
  if (hit) return hit;
  const api = getState().api!;
  const source = await api.previewSource(track);
  let blob = source?.blob ?? null;
  if (!blob && source?.kind === "legacy") {
    // Legacy sources hand out a direct URL: download it here, since the
    // analyzers need bytes to decode, not just something an <audio> can play.
    blob = await api.fetchAudioBlob(source.url).catch((err: unknown) => {
      dbg(`[analysis] track ${track.id}: legacy stream download failed: ${(err as Error).message}`);
      return null;
    });
  }
  if (!blob) {
    throw new Error("this track exposes no downloadable audio (no HLS stream, no progressive source, no preview snippet)");
  }
  dbg(`[analysis] track ${track.id}: whole-track fallback — decoding ${(blob.size / 1e6).toFixed(1)} MB (${source?.kind})`);
  const mono = await decodeBlobMono(blob, ANALYSIS_DECODE_RATE);
  const windows = sliceAnalysisWindows(mono, WHOLE_TRACK_WINDOWS, WHOLE_TRACK_WINDOW_SEC);
  while (wholeTrackCache.size >= WHOLE_TRACK_CACHE_MAX) {
    const oldest = wholeTrackCache.keys().next().value;
    if (oldest === undefined) break;
    wholeTrackCache.delete(oldest);
  }
  wholeTrackCache.set(track.id, windows);
  return windows;
}
