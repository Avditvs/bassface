/**
 * "Reorganize" sidebar service: the user's other playlists accept drag &
 * drop from the track rows:
 *
 *   - drop on a playlist card        → add the track to that playlist (copy)
 *   - drop on the far-right ⇥ strip  → add it there AND remove it from the
 *                                      playlist currently open (move)
 *
 * SoundCloud's `PUT /playlists/:id` replaces a playlist's whole track list,
 * so every operation reads the target playlist first, then writes the
 * modified id list back. UI state (filter text, selection mode) lives in the
 * `OrganizeSidebar` component; the persisted drop-target selection, the
 * dragged track and the undo stack live here.
 */

import { getState, setState, showStatus, clearStatus } from "./store";
import { navigateToPlaylist } from "./router";
import { replaceTracks } from "./tracks";
import type { Playlist, Track } from "../services/types";

/**
 * Which playlists the sidebar shows as drop targets: null = all, otherwise a
 * Set of playlist ids chosen by the user (persisted in localStorage).
 */
const SELECTION_KEY = "pu.organize.selected";

function loadSelection(): Set<string> | null {
  try {
    const raw = localStorage.getItem(SELECTION_KEY);
    if (raw === null) return null;
    return new Set(JSON.parse(raw).map(String));
  } catch {
    return null;
  }
}

let selection: Set<string> | null = loadSelection();

/** Current drop-target selection (null = all playlists). */
export function getSelection(): Set<string> | null {
  return selection;
}

function saveSelection(): void {
  if (selection === null) {
    localStorage.removeItem(SELECTION_KEY);
  } else {
    localStorage.setItem(SELECTION_KEY, JSON.stringify([...selection]));
  }
}

/** All/None buttons of the choose mode. */
export function setSelectionAll(all: boolean): void {
  selection = all ? null : new Set();
  saveSelection();
}

/** Checkbox toggles in choose mode; "All" is materialized before unchecking. */
export function toggleSelection(id: string, checked: boolean): void {
  if (selection === null) {
    // "All" is implicit — materialize it before unchecking the first box.
    selection = new Set(candidatePlaylists().map((playlist) => String(playlist.id)));
  }
  if (checked) {
    selection.add(id);
  } else {
    selection.delete(id);
  }
  saveSelection();
}

/** All playlists eligible for the sidebar (everything but the open one). */
export function candidatePlaylists(): Playlist[] {
  const currentId = String(getState().currentPlaylist?.id ?? "");
  return getState().playlists.filter((playlist) => String(playlist.id) !== currentId);
}

/** The user's playlists minus the open one, filtered by selection + search. */
export function visiblePlaylists(filter: string): Playlist[] {
  const query = filter.trim().toLowerCase();
  return candidatePlaylists()
    .filter((playlist) => !selection || selection.has(String(playlist.id)))
    .filter((playlist) => !query || playlist.title?.toLowerCase().includes(query));
}

/** The playlist currently open, or a clear error when there is none. */
function currentPlaylist(): Playlist {
  const current = getState().currentPlaylist;
  if (!current) throw new Error("No playlist is open");
  return current;
}

// --- Drag & drop -------------------------------------------------------------

/** Track being dragged: set by dragstart. */
let dragged: { track: Track; row: HTMLElement } | null = null;

/** Track rows start the drag; the dragged track is kept in module state. */
export function onTrackDragStart(event: React.DragEvent, track: Track, row: HTMLElement): void {
  dragged = { track, row };
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = "copyMove";
    event.dataTransfer.setData("text/plain", String(track.id));
    event.dataTransfer.setDragImage(row, 24, 24);
  }
  row.classList.add("is-dragging");
  window.addEventListener("dragend", clearDragged, { once: true });
}

function clearDragged(): void {
  dragged = null;
  document.querySelectorAll(".track-row.is-dragging").forEach((elem) => elem.classList.remove("is-dragging"));
  document.querySelectorAll(".org-item .is-over").forEach((elem) => elem.classList.remove("is-over"));
}

/** Sidebar dragover: allow the drop and highlight the hovered zone. */
export function onOrganizeDragOver(event: React.DragEvent): void {
  if (!dragged) return;
  const target = event.target instanceof Element ? event.target : null;
  const zone = target?.closest<HTMLElement>("[data-org-action]");
  const item = target?.closest<HTMLElement>(".org-item");
  if (!zone || !item) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = zone.dataset.orgAction === "move" ? "move" : "copy";
  item.querySelectorAll(".is-over").forEach((elem) => elem.classList.remove("is-over"));
  zone.classList.add("is-over");
}

/** Sidebar dragleave: drop the highlight when leaving a zone. */
export function onOrganizeDragLeave(event: React.DragEvent): void {
  const target = event.target instanceof Element ? event.target : null;
  const zone = target?.closest<HTMLElement>("[data-org-action]");
  if (zone) zone.classList.remove("is-over");
}

/** Sidebar drop: "add" copies the track, "move" copies + removes from here. */
export function onOrganizeDrop(event: React.DragEvent): void {
  if (!dragged) return;
  const target = event.target instanceof Element ? event.target : null;
  const zone = target?.closest<HTMLElement>("[data-org-action]");
  const item = target?.closest<HTMLElement>(".org-item");
  if (!zone || !item) return;
  event.preventDefault();
  const { track } = dragged;
  clearDragged();

  const playlist = getState().playlists.find((p) => String(p.id) === item.dataset.orgPlaylistId);
  if (!playlist) return;
  if (zone.dataset.orgAction === "move") {
    void moveTrack(track, playlist);
  } else {
    void addTrack(track, playlist);
  }
}

// --- Undo ---------------------------------------------------------------------

/** One reversible operation: full track-list snapshots of every playlist touched. */
interface UndoEntry {
  label: string;
  track: Track;
  changes: { playlist: Playlist; before: Track[] }[];
}

/** Stack of reversible operations, newest last. */
const undoStack: UndoEntry[] = [];

/** Push an operation onto the undo stack and refresh the toolbar button. */
function pushUndo(entry: UndoEntry): void {
  undoStack.push(entry);
  setState({ undoEntry: { label: entry.label } });
}

/** Undo the most recent add/move/remove (toolbar Revert button). */
export async function revertLastAction(): Promise<void> {
  const entry = undoStack.pop()!;
  if (!entry) return;
  setState({ undoEntry: undoStack.length ? { label: undoStack[undoStack.length - 1].label } : null });
  showStatus(`Reverting: ${entry.label}…`);
  try {
    for (const change of entry.changes) {
      await getState().api!.updatePlaylistTracks(change.playlist.id, change.before.map((t) => t.id));
      change.playlist.track_count = change.before.length;
    }
  } catch (err) {
    undoStack.push(entry); // still revertible — let the user retry
    setState({ undoEntry: { label: entry.label } });
    showStatus(`Could not revert: ${(err as Error).message}`, "error");
    return;
  }
  // If the open playlist was touched, restore its view straight from the
  // snapshot (full track list, original order — no refetch needed).
  const currentChange = entry.changes.find(
    (change) => String(change.playlist.id) === String(getState().currentPlaylist?.id),
  );
  if (currentChange) {
    replaceTracks([...currentChange.before], getState().currentPlaylist!);
  }
  setState({ playlists: [...getState().playlists] }); // refresh sidebar counts
  showStatus(`Reverted: ${entry.label}.`, "success");
  setTimeout(clearStatus, 3000);
}

// --- Operations (read playlist → modify id list → PUT) ------------------------

async function rewritePlaylist(playlist: Playlist, trackIds: number[]): Promise<void> {
  const updated = await getState().api!.updatePlaylistTracks(playlist.id, trackIds);
  // Keep the sidebar counts in sync with what SoundCloud now reports.
  playlist.track_count = updated?.track_count ?? trackIds.length;
  setState({ playlists: [...getState().playlists] });
}

/** Add a track to a target playlist (no-op when it is already there). */
export async function addTrack(track: Track, playlist: Playlist): Promise<void> {
  showStatus(`Adding “${track.title}” to “${playlist.title}”…`);
  try {
    const full = await getState().api!.getPlaylist(playlist.id);
    const before = (full.tracks ?? []).slice(); // full track objects — the revert snapshot
    const ids = before.map((t) => t.id);
    if (ids.some((id) => String(id) === String(track.id))) {
      showStatus(`“${track.title}” is already in “${playlist.title}”.`, "info");
      setTimeout(clearStatus, 3000);
      return;
    }
    ids.push(track.id);
    await rewritePlaylist(playlist, ids);
    pushUndo({ label: `Add to “${playlist.title}”`, track, changes: [{ playlist, before }] });
    showStatus(`Added “${track.title}” to “${playlist.title}”.`, "success");
  } catch (err) {
    showStatus(`Could not add the sound: ${(err as Error).message}`, "error");
    return;
  }
  setTimeout(clearStatus, 3000);
}

/** Add the track to the target playlist and remove it from the open one. */
export async function moveTrack(track: Track, playlist: Playlist): Promise<void> {
  const current = currentPlaylist();
  showStatus(`Moving “${track.title}” to “${playlist.title}”…`);
  try {
    const target = await getState().api!.getPlaylist(playlist.id);
    const targetBefore = (target.tracks ?? []).slice();
    const targetIds = targetBefore.map((t) => t.id);
    if (!targetIds.some((id) => String(id) === String(track.id))) {
      targetIds.push(track.id);
      await rewritePlaylist(playlist, targetIds);
    }

    const currentFull = await getState().api!.getPlaylist(current.id);
    const currentBefore = (currentFull.tracks ?? []).slice();
    const remainingIds = currentBefore.map((t) => t.id).filter((id) => String(id) !== String(track.id));
    await rewritePlaylist(current, remainingIds);

    pushUndo({
      label: `Move to “${playlist.title}”`,
      track,
      changes: [
        { playlist, before: targetBefore },
        { playlist: current, before: currentBefore },
      ],
    });

    // Reflect the removal in the open view (the track is gone from here).
    const remaining = getState().tracks.filter((t) => String(t.id) !== String(track.id));
    current.track_count = remainingIds.length;
    setState({ tracks: remaining, currentPlaylist: { ...current } });
    showStatus(`Moved “${track.title}” to “${playlist.title}”.`, "success");
  } catch (err) {
    showStatus(`Could not move the sound: ${(err as Error).message}`, "error");
    return;
  }
  setTimeout(clearStatus, 3000);
}

/**
 * Drop zone above the track list: dropping a sound here removes it from the
 * playlist currently open.
 */
export function onRemoveZoneDragOver(event: React.DragEvent): void {
  if (!dragged) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
}

export function onRemoveZoneDragLeave(event: React.DragEvent): void {
  const zone = event.currentTarget;
  if (zone instanceof Element) zone.classList.remove("is-over");
}

export function onRemoveZoneDrop(event: React.DragEvent): void {
  if (!dragged) return;
  event.preventDefault();
  const { track } = dragged;
  clearDragged();
  void removeTrack(track);
}

/** Remove a track from the playlist currently open. */
export async function removeTrack(track: Track): Promise<void> {
  const current = currentPlaylist();
  showStatus(`Removing “${track.title}” from “${current.title}”…`);
  try {
    const full = await getState().api!.getPlaylist(current.id);
    const before = (full.tracks ?? []).slice();
    const remainingIds = before.map((t) => t.id).filter((id) => String(id) !== String(track.id));
    await rewritePlaylist(current, remainingIds);
    pushUndo({ label: `Remove from “${current.title}”`, track, changes: [{ playlist: current, before }] });

    // Reflect the removal in the open view.
    const remaining = getState().tracks.filter((t) => String(t.id) !== String(track.id));
    current.track_count = remainingIds.length;
    setState({ tracks: remaining, currentPlaylist: { ...current } });
    showStatus(`Removed “${track.title}” from “${current.title}”.`, "success");
  } catch (err) {
    showStatus(`Could not remove the sound: ${(err as Error).message}`, "error");
    return;
  }
  setTimeout(clearStatus, 3000);
}

/**
 * Ask for a title, create an empty playlist on SoundCloud, and list it in the
 * sidebar so sounds can be dragged onto it right away.
 */
export async function createPlaylistFromSidebar(): Promise<void> {
  const title = (window.prompt("Title of the new playlist") ?? "").trim();
  if (!title) return;
  showStatus(`Creating playlist “${title}”…`);
  try {
    const playlist = await getState().api!.createPlaylist(title);
    // New playlist first, so it shows up at the top of the sidebar list.
    setState({
      playlists: [playlist, ...getState().playlists.filter((p) => String(p.id) !== String(playlist.id))],
    });
  } catch (err) {
    showStatus(`Could not create the playlist: ${(err as Error).message}`, "error");
    return;
  }
  showStatus(`Created “${title}”. Drag sounds onto it to fill it.`, "success");
  setTimeout(clearStatus, 3000);
}

/** Clicking a sidebar card opens that playlist. */
export function openSidebarPlaylist(id: string): void {
  const playlist = getState().playlists.find((p) => String(p.id) === id);
  if (playlist) navigateToPlaylist(playlist.id);
}

/** Forget transient sidebar state when leaving the playlist screen. */
export function resetOrganizeSidebar(): void {
  dragged = null;
  undoStack.length = 0;
  setState({ undoEntry: null });
}
