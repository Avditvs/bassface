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

import { useEffect, useState } from "react";
import { useApp } from "../services/store";
import {
  escapeUrl, formatCount, formatDate, hiResArtwork,
} from "../services/util";
import { EXPAND_EVENT } from "../services/organize";
import { StatsLine, TrackIcon, usePlaylistArtwork, usePlaylistStats } from "./shared";
import {
  candidatePlaylists, createPlaylistFromSidebar, getSelection,
  moveTrack, onOrganizeDragLeave, onOrganizeDragOver, onOrganizeDrop,
  openSidebarPlaylist, setSelectionAll, toggleSelection, visiblePlaylists,
} from "../services/organize";
import type { Playlist } from "../services/types";

/** One sidebar entry: the card is the "add" drop zone, the strip is "move". */
function OrganizationEntry({ playlist, bpmValues }: {
  playlist: Playlist;
  bpmValues: Record<number, number>;
}) {
  const updatedAt = playlist.last_modified ?? playlist.created_at;
  const stats = usePlaylistStats(playlist, bpmValues);
  const artworkUrl = usePlaylistArtwork(playlist);
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
        {artworkUrl
          ? <img className="org-art" src={escapeUrl(hiResArtwork(artworkUrl)) || undefined} alt="" loading="lazy" />
          : <span className="org-art org-art-placeholder"><TrackIcon size={24} /></span>}
        <span className="org-body">
          <span className="org-title" title={playlist.title ?? ""}>{playlist.title ?? ""}</span>
          <span className="org-count muted">{formatCount(playlist.track_count ?? 0)} tracks {privateBadge}</span>
          <span className="org-stats muted">
            <span title="Likes">♥ {formatCount(playlist.likes_count)}</span>
            {updatedAt ? <span title="Last update">Updated {formatDate(updatedAt)}</span> : null}
          </span>
          <StatsLine stats={stats} className="org-stats muted" />
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

/**
 * Collapsed state of the panel's search bar + description (persisted).
 * Expanded by default; the toggle saves the pinned-panel space on demand.
 */
const EXPANDED_KEY = "pu.organize.expanded";

function loadExpanded(): boolean {
  try {
    const raw = localStorage.getItem(EXPANDED_KEY);
    if (raw !== null) return JSON.parse(raw) === true;
  } catch {
    // Corrupted or unavailable storage: fall through to the default.
  }
  return true;
}

export function OrganizeSidebar() {
  const state = useApp(); // re-render when playlists/track counts/BPMs change
  const [filter, setFilter] = useState("");
  const [selectionMode, setSelectionMode] = useState(false);
  const [expanded, setExpanded] = useState(loadExpanded);
  const [, setSelectionCopy] = useState<Set<string> | null>(getSelection());

  // External expansion (Discover tour's filter step): expand and persist, so
  // the retracted panel never hides a feature the tour is pointing at.
  useEffect(() => {
    const expand = () => {
      setExpanded(true);
      try {
        localStorage.setItem(EXPANDED_KEY, JSON.stringify(true));
      } catch {
        // Storage unavailable: expanded for this session only.
      }
    };
    window.addEventListener(EXPAND_EVENT, expand);
    return () => window.removeEventListener(EXPAND_EVENT, expand);
  }, []);

  /** Toggle the search bar + description and remember the choice. */
  function toggleExpanded(): void {
    setExpanded((value) => {
      try {
        localStorage.setItem(EXPANDED_KEY, JSON.stringify(!value));
      } catch {
        // Storage unavailable: the toggle still works for this session.
      }
      return !value;
    });
  }

  const candidates = candidatePlaylists();
  const playlists = visiblePlaylists(filter);

  return (
    <aside
      id="organize"
      className="organize"
      data-tour="organize-sidebar"
      aria-label="Reorganize playlists"
      onDragOver={onOrganizeDragOver}
      onDragLeave={onOrganizeDragLeave}
      onDrop={onOrganizeDrop}
    >
      <div className="org-head">
        <h2 className="org-title">Reorganize</h2>
        <div className="org-head-actions">
          <button
            className="button button-quiet org-toggle"
            type="button"
            data-tour="organize-toggle"
            aria-expanded={expanded}
            title={expanded ? "Hide the search bar and description" : "Show the search bar and description"}
            onClick={toggleExpanded}
          >
            {expanded ? "▾ Retract" : "▸ Expand"}
          </button>
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
            data-tour="organize-choose"
            onClick={() => setSelectionMode(!selectionMode)}
          >
            {selectionMode ? "Done" : "Choose…"}
          </button>
        </div>
      </div>

      {selectionMode ? (
        <>
          {expanded && <p className="muted org-help">Tick the playlists you want as drop targets in the sidebar.</p>}
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
          {expanded && (
            <p className="muted org-help">
              Drag a sound onto a playlist to add it, or onto the ⇥ strip to move it there.
            </p>
          )}
          {expanded && (
            <input
              className="search org-filter"
              data-tour="organize-filter"
              type="search"
              placeholder="Filter playlists…"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
          )}
          <ul id="organize-list" className="org-list">
            {playlists.length === 0 && <li className="empty-state">No playlists match.</li>}
            {playlists.map((playlist) => (
              <OrganizationEntry key={playlist.id} playlist={playlist} bpmValues={state.bpmValues} />
            ))}
          </ul>
          {expanded && (
            <p className="muted org-shown">{playlists.length} of {candidates.length} playlists shown</p>
          )}
        </>
      )}
    </aside>
  );
}
