/**
 * Artwork fallback for playlist miniatures: the list endpoint
 * (`/me/playlists?show_tracks=false`) carries no track data, so a playlist
 * without its own artwork needs one light `GET /playlists/:id/tracks?limit=1`
 * to find the first track's artwork. The result is cached in localStorage and
 * deduplicated per playlist — a playlist whose tracks have no artwork either
 * resolves to null (the UI then shows the music-note placeholder).
 */

import { getState } from "./store";
import type { Playlist } from "./types";

/** Cached first-track artwork of one playlist. */
interface CachedArt {
  /** First track's artwork URL, null when no track exposes one. */
  artworkUrl: string | null;
  fetchedAt: number;
}

/** Cache age after which a playlist's first-track artwork is fetched again. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const ART_KEY = "pu.organize.playlist_art";

function loadCache(): Record<string, CachedArt> {
  try {
    return JSON.parse(localStorage.getItem(ART_KEY) ?? "{}") ?? {};
  } catch {
    return {};
  }
}

const cache: Record<string, CachedArt> = loadCache();

function saveCache(): void {
  try {
    localStorage.setItem(ART_KEY, JSON.stringify(cache));
  } catch {
    // Storage unavailable: the artwork stays session-only.
  }
}

/** One `/playlists/:id/tracks` fetch per playlist at a time. */
const inflight = new Map<string, Promise<void>>();

/** Cached first-track artwork of a playlist (null when none is known yet). */
export function cachedTrackArtwork(playlist: Playlist): string | null {
  return cache[String(playlist.id)]?.artworkUrl ?? null;
}

/**
 * Make sure the first track's artwork of a playlist is cached: resolves
 * immediately when the cache is fresh, else fetches the playlist's first
 * track once (deduplicated). False on failure — the caller retries on the
 * next mount/render. Virtual playlists (liked tracks, no permalink) resolve
 * false without a fetch.
 */
export async function fetchTrackArtwork(playlist: Playlist): Promise<boolean> {
  if (!playlist.permalink_url) return false;
  const id = String(playlist.id);
  const cached = cache[id];
  if (cached && Date.now() - cached.fetchedAt < MAX_AGE_MS) return true;
  const api = getState().api;
  if (!api) return false;
  let pending = inflight.get(id);
  if (!pending) {
    pending = api.createPlaylistTracksPager(id, { pageSize: 1 })
      .next()
      .then((tracks) => {
        const artworkUrl = tracks?.find((track) => track.artwork_url)?.artwork_url ?? null;
        cache[id] = { artworkUrl, fetchedAt: Date.now() };
        saveCache();
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
