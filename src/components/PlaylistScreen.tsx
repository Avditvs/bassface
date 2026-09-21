/**
 * Playlist detail screen: the toolbar (back + revert), the playlist header,
 * the track list (infinite scroll) with the shared preview `<audio>` element,
 * the drop-to-remove zone and the Reorganize sidebar.
 */

import { useApp, getState } from "../services/store";
import { goBackToPlaylists } from "../services/router";
import { revertLastAction } from "../services/organize";
import { analyzeAllTrackBpms } from "../services/bpm";
import { analyzeAllTrackChromas } from "../services/chroma";
import { isLikedView } from "../services/tracks";
import { onRemoveZoneDragLeave, onRemoveZoneDragOver, onRemoveZoneDrop } from "../services/organize";
import { isTouchDevice } from "./TrackRow";
import { OrganizeSidebar } from "./OrganizeSidebar";
import { PlaylistHeader } from "./PlaylistHeader";
import { TrackList } from "./TrackList";

/**
 * Estimate the BPM then the key of every track of the playlist. A second
 * click while either analysis runs stops it after the current batch.
 */
function analyzeAllTracks(): void {
  const state = getState();
  if (state.chromaAllRunning || state.bpmAllRunning) {
    // Re-invoking the entry point of a running analysis sets its stop flag.
    if (state.chromaAllRunning) void analyzeAllTrackChromas();
    if (state.bpmAllRunning) void analyzeAllTrackBpms();
    return;
  }
  void (async () => {
    await analyzeAllTrackBpms();
    await analyzeAllTrackChromas();
  })();
}

export function PlaylistScreen() {
  const state = useApp();
  const playlist = state.currentPlaylist;
  if (!playlist) return null;

  return (
    <section id="playlist-screen">
      <div className={`playlist-columns${isLikedView() ? " is-liked" : ""}`}>
        {!isLikedView() && (
          <aside id="remove-panel" className="remove-panel" aria-label="Remove from playlist">
            <h2 className="remove-title">Remove</h2>
            <div
              id="remove-zone"
              className="remove-zone"
              data-tour="remove-zone"
              onDragOver={onRemoveZoneDragOver}
              onDragLeave={onRemoveZoneDragLeave}
              onDrop={onRemoveZoneDrop}
            >
              🗑 Drop a sound here to remove it from this playlist
            </div>
          </aside>
        )}

        <div className="playlist-main">
          <div className="playlist-content">
            <div className="toolbar">
            <button className="button button-quiet" type="button" onClick={goBackToPlaylists}>
              ← All playlists
            </button>
            <button
              className={`button button-quiet${state.chromaAllRunning || state.bpmAllRunning ? " is-loading" : ""}`}
              type="button"
              data-tour="analyze-all"
              title="Estimate the BPM and the key of every track (click again to stop)"
              onClick={analyzeAllTracks}
            >
              {state.chromaAllRunning || state.bpmAllRunning
                ? <span className="spinner" aria-hidden="true" />
                : "♪"}
              {state.chromaAllRunning || state.bpmAllRunning ? " Stop analysis" : " Analyze all"}
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
            {/* Touch devices cannot use the drag & drop remove zone: on
                phones the panel is hidden and the swipe gesture is the only
                removal path, so point to it. Hidden by CSS on large screens. */}
            {!isLikedView() && isTouchDevice() && (
              <p className="swipe-tip">← Swipe a track left to remove it from this playlist</p>
            )}
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
