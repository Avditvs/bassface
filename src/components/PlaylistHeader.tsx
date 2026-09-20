/**
 * Playlist detail header: artwork, title, badges, description, meta. The
 * liked-tracks view (virtual playlist) gets a simpler header instead.
 */
import { useApp } from "../services/store";
import { Artwork, Badges, CardMeta, StatsLine, usePlaylistArtwork, usePlaylistStats } from "./shared";
import { formatCount } from "../services/util";

export function PlaylistHeader() {
  const state = useApp();
  const playlist = state.currentPlaylist;
  // Same hook order in every branch (the liked view simply has no stats).
  const stats = usePlaylistStats(playlist, state.bpmValues);
  const artworkUrl = usePlaylistArtwork(playlist);
  if (!playlist) return null;

  if (state.route.name === "liked") {
    return (
      <div id="playlist-header" className="playlist-header">
        <div className="playlist-header-art">
          <Artwork artworkUrl={artworkUrl} fallback="♥" />
        </div>
        <div className="playlist-header-body">
          <h2 className="playlist-title">Liked tracks</h2>
          <p className="muted playlist-desc">
            {formatCount(state.tracks.length)} liked so far, most recently liked first.
            Drag a sound onto a playlist in the Reorganize sidebar to add it — it stays liked.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div id="playlist-header" className="playlist-header">
      <div className="playlist-header-art">
        <Artwork artworkUrl={artworkUrl} />
      </div>
      <div className="playlist-header-body">
        <h2 className="playlist-title">{playlist.title ?? ""}</h2>
        <Badges playlist={playlist} />
        {playlist.description && <p className="muted playlist-desc">{playlist.description}</p>}
        <CardMeta playlist={playlist} />
        <StatsLine stats={stats} className="meta playlist-stats" />
        <p className="playlist-link">
          <a href={playlist.permalink_url} target="_blank" rel="noreferrer">Open on SoundCloud →</a>
        </p>
      </div>
    </div>
  );
}
