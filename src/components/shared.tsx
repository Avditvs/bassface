/**
 * Shared presentational helpers: artwork (image or letter placeholder),
 * type/private badges and the count/likes/updated meta line, plus the
 * per-playlist statistics line (total duration + BPM range) used by the
 * playlist header and the Reorganize sidebar cards.
 */

import { useEffect, useMemo, useState } from "react";
import { TYPE_LABELS } from "../services/store";
import {
  cachedStats, fetchPlaylistStats,
} from "../services/playlist-stats";
import type { PlaylistStats } from "../services/playlist-stats";
import {
  escapeUrl, formatCount, formatDate, formatTotalDuration, playlistBucket,
} from "../services/util";
import type { Playlist } from "../services/types";

/** Artwork image or a letter placeholder. */
export function Artwork({ artworkUrl, title, className }: {
  artworkUrl?: string | null;
  title?: string;
  className?: string;
}) {
  const letter = (title ?? "?").trim().charAt(0).toUpperCase() || "♪";
  return artworkUrl ? (
    <div className={className ?? "artwork"}>
      <img src={escapeUrl(artworkUrl) || undefined} alt="" loading="lazy" />
    </div>
  ) : (
    <div className={className ?? "artwork-placeholder"}>{letter}</div>
  );
}

/** Type (+ private) badges and the count/likes/updated meta line. */
export function Badges({ playlist }: { playlist: Playlist }) {
  const type = playlistBucket(playlist);
  const typeLabel = TYPE_LABELS[type] ?? type;
  return (
    <div className="badges">
      <span className={`badge type-${type}`}>{typeLabel}</span>
      {playlist.sharing === "private" && <span className="badge type-private">Private</span>}
    </div>
  );
}

export function CardMeta({ playlist }: { playlist: Playlist }) {
  const updatedAt = playlist.last_modified ?? playlist.created_at;
  return (
    <div className="meta">
      <span>{formatCount(playlist.track_count ?? 0)} tracks</span>
      <span>{formatCount(playlist.likes_count)} likes</span>
      {updatedAt ? <span>Updated {formatDate(updatedAt)}</span> : null}
    </div>
  );
}

/**
 * Statistics of one playlist: cached durations + a BPM range recomputed
 * from the analyzed BPMs (null until the first background fetch succeeds).
 * Refetches when the playlist's track count changes; null playlists (e.g. the
 * liked-tracks view) simply have no stats.
 */
export function usePlaylistStats(playlist: Playlist | null, bpmValues: Record<number, number>): PlaylistStats | null {
  const [version, setVersion] = useState(0);
  const stats = useMemo(
    () => (playlist ? cachedStats(playlist, bpmValues) : null),
    [playlist, bpmValues, version],
  );
  useEffect(() => {
    if (!playlist) return undefined;
    let cancelled = false;
    void fetchPlaylistStats(playlist).then((available) => {
      if (!cancelled && available) setVersion((value) => value + 1);
    });
    return () => { cancelled = true; };
  }, [playlist, playlist?.track_count]);
  return stats;
}

/** Duration + BPM range of a playlist, or a placeholder while loading. */
export function StatsLine({ stats, className }: { stats: PlaylistStats | null; className: string }) {
  return (
    <span className={className}>
      {stats
        ? <>
            <span title="Total duration">⏱ {formatTotalDuration(stats.durationMs)}</span>
            <span
              title={stats.bpmAnalyzed > 0
                ? `${stats.bpmAnalyzed} of ${stats.trackCount} tracks analyzed`
                : "No BPM analysis yet"}
            >
              BPM {stats.bpmMin !== null ? `${stats.bpmMin}–${stats.bpmMax}` : "—"}
              {stats.bpmAnalyzed > 0 && stats.bpmAnalyzed < stats.trackCount
                ? ` (${stats.bpmAnalyzed}/${stats.trackCount})`
                : ""}
            </span>
          </>
        : <span title="Loading the playlist statistics…">⏱ …</span>}
    </span>
  );
}
