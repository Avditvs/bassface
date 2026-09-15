/**
 * Playlist detail screen: the toolbar (back + revert), the playlist header,
 * the track list (infinite scroll) with the shared preview `<audio>` element,
 * the drop-to-remove zone and the Reorganize sidebar.
 */

import { useApp } from "../services/store";
import { goBackToPlaylists } from "../services/router";
import { revertLastAction } from "../services/organize";
import { analyzeAllTrackChromas } from "../services/chroma";
import { onRemoveZoneDragLeave, onRemoveZoneDragOver, onRemoveZoneDrop } from "../services/organize";
import { OrganizeSidebar } from "./OrganizeSidebar";
import { PlaylistHeader } from "./PlaylistHeader";
import { TrackList } from "./TrackList";

export function PlaylistScreen() {
  const state = useApp();
  const playlist = state.currentPlaylist;
  if (!playlist) return null;

  return (
    <section id="playlist-screen">
      <div className="playlist-columns">
        <aside id="remove-panel" className="remove-panel" aria-label="Remove from playlist">
          <h2 className="remove-title">Remove</h2>
          <div
            id="remove-zone"
            className="remove-zone"
            onDragOver={onRemoveZoneDragOver}
            onDragLeave={onRemoveZoneDragLeave}
            onDrop={onRemoveZoneDrop}
          >
            🗑 Drop a sound here to remove it from this playlist
          </div>
        </aside>

        <div className="playlist-main">
          <div className="playlist-content">
            <div className="toolbar">
            <button className="button button-quiet" type="button" onClick={goBackToPlaylists}>
              ← All playlists
            </button>
            <button
              className={`button button-quiet${state.chromaAllRunning ? " is-loading" : ""}`}
              type="button"
              title="Estimate the key of every track from segments spread across each one (click again to stop)"
              onClick={() => void analyzeAllTrackChromas()}
            >
              {state.chromaAllRunning ? <span className="spinner" aria-hidden="true" /> : "♪"}
              {state.chromaAllRunning ? " Stop key analysis" : " Analyze all keys"}
            </button>
            {state.undoEntry && (
              <button
                className="button button-undo"
                type="button"
                onClick={() => void revertLastAction()}
              >
                ↩ Revert: {state.undoEntry.label}
              </button>
            )}
          </div>
            <PlaylistHeader />
            <TrackList />
          </div>
        </div>

        {/* Keyed by playlist id: leaving/reopening a playlist resets the
            local filter and selection mode, like the old reset logic. */}
        <OrganizeSidebar key={String(playlist.id)} />
      </div>
    </section>
  );
}
