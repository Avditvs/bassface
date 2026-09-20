/**
 * Aggregate statistics for the Reorganize sidebar playlist cards: total
 * duration and the min/max BPM of the analyzed tracks (see services/bpm.ts).
 *
 * SoundCloud's `/me/playlists` list response carries no track data, so each
 * card's stats need one `GET /playlists/:id`. The fetched durations and track
 * ids are cached in localStorage and refreshed when the playlist's track
 * count changes (add/move/remove) or the cache ages out; the BPM range is
 * recomputed from the UI state on every render, so freshly analyzed tracks
 * update the cards without a refetch.
 */

import { getState } from "./store";
import type { Playlist } from "./types";

/** Statistics shown on a sidebar playlist card. */
export interface PlaylistStats {
  /** Sum of the track durations, in ms. */
  durationMs: number;
  /** Number of tracks covered by the sum. */
  trackCount: number;
  /** Slowest analyzed BPM (null when none of the tracks has one). */
  bpmMin: number | null;
  /** Fastest analyzed BPM (null likewise). */
  bpmMax: number | null;
  /** How many of the playlist's tracks have a BPM analysis. */
  bpmAnalyzed: number;
}

/** What the fetch persists: track ids (for the BPM range) and the total. */
interface CachedStats {
  trackIds: number[];
  durationMs: number;
  trackCount: number;
  fetchedAt: number;
}

/** Cache age after which a playlist's stats are fetched again. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

const STATS_KEY = "pu.organize.playlist_stats";

function loadCache(): Record<string, CachedStats> {
  try {
    return JSON.parse(localStorage.getItem(STATS_KEY) ?? "{}") ?? {};
  } catch {
    return {};
  }
}

const cache: Record<string, CachedStats> = loadCache();

function saveCache(): void {
  try {
    localStorage.setItem(STATS_KEY, JSON.stringify(cache));
  } catch {
    // Storage unavailable: the stats stay session-only.
  }
}

/** One GET /playlists/:id per playlist at a time. */
const inflight = new Map<string, Promise<CachedStats>>();

/** Is the cached entry usable for this playlist as-is? */
function isFresh(cached: CachedStats | undefined, expectedCount: number): boolean {
  return Boolean(
    cached
    && cached.trackCount === expectedCount
    && Date.now() - cached.fetchedAt < MAX_AGE_MS,
  );
}

/** BPM range across the given track ids, from the UI's analyzed BPMs. */
function bpmRange(trackIds: number[], bpmValues: Record<number, number>): {
  bpmMin: number | null;
  bpmMax: number | null;
  bpmAnalyzed: number;
} {
  let min: number | null = null;
  let max: number | null = null;
  let analyzed = 0;
  for (const id of trackIds) {
    const bpm = bpmValues[id];
    if (typeof bpm !== "number" || !Number.isFinite(bpm)) continue;
    analyzed += 1;
    min = min === null ? bpm : Math.min(min, bpm);
    max = max === null ? bpm : Math.max(max, bpm);
  }
  return { bpmMin: min, bpmMax: max, bpmAnalyzed: analyzed };
}

/** Cached stats of a playlist, or null before its first successful fetch. */
export function cachedStats(playlist: Playlist, bpmValues: Record<number, number>): PlaylistStats | null {
  const cached = cache[String(playlist.id)];
  if (!cached) return null;
  return {
    durationMs: cached.durationMs,
    trackCount: cached.trackCount,
    ...bpmRange(cached.trackIds, bpmValues),
  };
}

/**
 * Make sure the stats of a playlist are cached: resolves immediately when
 * the cache is fresh, else fetches the full playlist once (deduplicated)
 * and resolves when the cache has been updated. False on failure (no API
 * context, network error) — the card stays without stats until a retry.
 */
export async function fetchPlaylistStats(playlist: Playlist): Promise<boolean> {
  const id = String(playlist.id);
  if (isFresh(cache[id], playlist.track_count ?? 0)) return true;
  const api = getState().api;
  if (!api) return false;
  let pending = inflight.get(id);
  if (!pending) {
    pending = api.getPlaylist(id)
      .then((full) => {
        const tracks = full.tracks ?? [];
        const entry: CachedStats = {
          trackIds: tracks.map((track) => track.id),
          durationMs: tracks.reduce((sum, track) => sum + (track.duration ?? 0), 0),
          trackCount: tracks.length,
          fetchedAt: Date.now(),
        };
        cache[id] = entry;
        saveCache();
        return entry;
      })
      .finally(() => { inflight.delete(id); });
    inflight.set(id, pending);
  }
  try {
    await pending;
    return true;
  } catch {
    return false;
  }
}
