/**
 * "Reorganize" sidebar (playlist detail screen): the user's other playlists
 * are listed on the right of the track list and accept drag & drop from the
 * track rows:
 *
 *   - drop on a playlist card        → add the track to that playlist (copy)
 *   - drop on the far-right ⇥ strip  → add it there AND remove it from the
 *                                      playlist currently open (move)
 *
 * Filter text and selection mode are component-local state; the persisted
 * drop-target selection and the drag/rewrite operations live in the
 * organize service.
 */

import { useState } from "react";
import { useApp } from "../services/store";
import { escapeUrl, formatCount } from "../services/util";
import {
  candidatePlaylists, createPlaylistFromSidebar, getSelection,
  moveTrack, onOrganizeDragLeave, onOrganizeDragOver, onOrganizeDrop,
  openSidebarPlaylist, setSelectionAll, toggleSelection, visiblePlaylists,
} from "../services/organize";
import type { Playlist } from "../services/types";

/** One sidebar entry: the card is the "add" drop zone, the strip is "move". */
function OrganizationEntry({ playlist }: { playlist: Playlist }) {
  const letter = (playlist.title ?? "?").trim().charAt(0).toUpperCase() || "♪";
  const privateBadge = playlist.sharing === "private"
    ? <span className="badge type-private">Private</span>
    : null;
  return (
    <li className="org-item" data-org-playlist-id={playlist.id}>
      <div
        className="org-drop"
        data-org-action="add"
        title="Drop to add the dragged sound to this playlist"
        onClick={() => openSidebarPlaylist(String(playlist.id))}
      >
        {playlist.artwork_url
          ? <img className="org-art" src={escapeUrl(playlist.artwork_url) || undefined} alt="" loading="lazy" />
          : <span className="org-art org-art-placeholder">{letter}</span>}
        <span className="org-body">
          <span className="org-title" title={playlist.title ?? ""}>{playlist.title ?? ""}</span>
          <span className="org-count muted">{formatCount(playlist.track_count ?? 0)} tracks {privateBadge}</span>
        </span>
      </div>
      <div
        className="org-move"
        data-org-action="move"
        title="Drop to add the sound here and remove it from the current playlist"
      >
        ⇥
      </div>
    </li>
  );
}

export function OrganizeSidebar() {
  useApp(); // re-render when playlists/track counts change
  const [filter, setFilter] = useState("");
  const [selectionMode, setSelectionMode] = useState(false);
  const [, setSelectionCopy] = useState<Set<string> | null>(getSelection());

  const candidates = candidatePlaylists();
  const playlists = visiblePlaylists(filter);

  return (
    <aside
      id="organize"
      className="organize"
      aria-label="Reorganize playlists"
      onDragOver={onOrganizeDragOver}
      onDragLeave={onOrganizeDragLeave}
      onDrop={onOrganizeDrop}
    >
      <div className="org-head">
        <h2 className="org-title">Reorganize</h2>
        <div className="org-head-actions">
          <button
            className="button button-quiet"
            type="button"
            title="Create a new, empty playlist"
            onClick={() => void createPlaylistFromSidebar()}
          >
            + New
          </button>
          <button
            className="button button-quiet"
            type="button"
            onClick={() => setSelectionMode(!selectionMode)}
          >
            {selectionMode ? "Done" : "Choose…"}
          </button>
        </div>
      </div>

      {selectionMode ? (
        <>
          <p className="muted org-help">Tick the playlists you want as drop targets in the sidebar.</p>
          <div className="org-actions">
            <button
              className="button button-quiet"
              type="button"
              onClick={() => { setSelectionAll(true); setSelectionCopy(getSelection()); }}
            >
              All
            </button>
            <button
              className="button button-quiet"
              type="button"
              onClick={() => { setSelectionAll(false); setSelectionCopy(getSelection()); }}
            >
              None
            </button>
          </div>
          <ul className="org-check-list">
            {candidates.length === 0 && <li className="empty-state">You have no other playlists.</li>}
            {candidates.map((playlist) => (
              <li key={playlist.id}>
                <label className="org-check">
                  <input
                    type="checkbox"
                    data-org-select-id={playlist.id}
                    checked={!getSelection() || getSelection()!.has(String(playlist.id))}
                    onChange={(event) => {
                      toggleSelection(String(playlist.id), event.target.checked);
                      setSelectionCopy(getSelection());
                    }}
                  />
                  <span className="org-check-title" title={playlist.title ?? ""}>{playlist.title ?? ""}</span>
                </label>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <>
          <p className="muted org-help">
            Drag a sound onto a playlist to add it, or onto the ⇥ strip to move it there.
          </p>
          <input
            className="search org-filter"
            type="search"
            placeholder="Filter playlists…"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
          <ul id="organize-list" className="org-list">
            {playlists.length === 0 && <li className="empty-state">No playlists match.</li>}
            {playlists.map((playlist) => (
              <OrganizationEntry key={playlist.id} playlist={playlist} />
            ))}
          </ul>
          <p className="muted org-shown">{playlists.length} of {candidates.length} playlists shown</p>
        </>
      )}
    </aside>
  );
}
