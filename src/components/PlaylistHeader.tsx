/**
 * Playlist detail header: artwork, title, badges, description, meta.
 */

import { useApp } from "../services/store";
import { Badges, CardMeta } from "./shared";
import { Artwork } from "./shared";

export function PlaylistHeader() {
  const playlist = useApp().currentPlaylist;
  if (!playlist) return null;
  return (
    <div id="playlist-header" className="playlist-header">
      <div className="playlist-header-art">
        <Artwork artworkUrl={playlist.artwork_url} title={playlist.title} />
      </div>
      <div className="playlist-header-body">
        <h2 className="playlist-title">{playlist.title ?? ""}</h2>
        <Badges playlist={playlist} />
        {playlist.description && <p className="muted playlist-desc">{playlist.description}</p>}
        <CardMeta playlist={playlist} />
        <p className="playlist-link">
          <a href={playlist.permalink_url} target="_blank" rel="noreferrer">Open on SoundCloud →</a>
        </p>
      </div>
    </div>
  );
}
