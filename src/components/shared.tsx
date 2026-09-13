/**
 * Shared presentational helpers: artwork (image or letter placeholder),
 * type/private badges and the count/likes/updated meta line.
 */

import { TYPE_LABELS } from "../services/store";
import { escapeUrl, formatCount, formatDate, playlistBucket } from "../services/util";
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
