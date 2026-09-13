/**
 * "Reorganize" sidebar (playlist detail screen): the user's other playlists
 * are listed on the right of the track list and accept drag & drop from the
 * track rows:
 *
 *   - drop on a playlist card        → add the track to that playlist (copy)
 *   - drop on the far-right ⇥ strip  → add it there AND remove it from the
 *                                      playlist currently open (move)
 *
 * SoundCloud's `PUT /playlists/:id` replaces a playlist's whole track list,
 * so every operation reads the target playlist first, then writes the
 * modified id list back.
 */

import { state } from "./state.js";
import { escapeHtml, formatCount } from "./util.js";
import { showStatus, clearStatus } from "./screens.js";
import { renderTrackList, renderPlaylistHeader } from "./render.js";

/** Sidebar filter text (cleared when the playlist screen is left). */
let filter = "";

/**
 * Which playlists the sidebar shows as drop targets: null = all, otherwise a
 * Set of playlist ids chosen by the user (persisted in localStorage).
 */
let selection = loadSelection();

/** Whether the sidebar is currently in "choose playlists" mode. */
let selectionMode = false;

const SELECTION_KEY = "pu.organize.selected";

function loadSelection() {
  try {
    const raw = localStorage.getItem(SELECTION_KEY);
    if (raw === null) return null;
    return new Set(JSON.parse(raw).map(String));
  } catch {
    return null;
  }
}

function saveSelection() {
  if (selection === null) {
    localStorage.removeItem(SELECTION_KEY);
  } else {
    localStorage.setItem(SELECTION_KEY, JSON.stringify([...selection]));
  }
}

/** All playlists eligible for the sidebar (everything but the open one). */
function candidatePlaylists() {
  const currentId = String(state.currentPlaylist?.id ?? "");
  return state.playlists.filter((playlist) => String(playlist.id) !== currentId);
}

/** Track being dragged: { track, fromPlaylistId } — set by dragstart. */
let dragged = null;

// --- Rendering ---------------------------------------------------------------

/** The user's playlists minus the one currently open, filtered by the search box. */
function visiblePlaylists() {
  const query = filter.trim().toLowerCase();
  return candidatePlaylists()
    .filter((playlist) => !selection || selection.has(String(playlist.id)))
    .filter((playlist) => !query || playlist.title?.toLowerCase().includes(query));
}

/** Rebuild the sidebar for the open playlist (filter + entries + drop zones). */
export function renderOrganizeSidebar() {
  const aside = document.getElementById("organize");
  if (!aside || !state.currentPlaylist) return;

  aside.innerHTML = `
    <div class="org-head">
      <h2 class="org-title">Reorganize</h2>
      <button id="organize-choose" class="button button-quiet" type="button">${selectionMode ? "Done" : "Choose…"}</button>
    </div>
    ${selectionMode ? selectionModeHtml() : dropModeHtml()}`;
}

/** Normal mode: filter box + drop targets + how many are shown. */
function dropModeHtml() {
  const candidates = candidatePlaylists();
  const playlists = visiblePlaylists();
  return `
    <p class="muted org-help">Drag a sound onto a playlist to add it, or onto the ⇥ strip to move it there.</p>
    <input id="organize-filter" class="search org-filter" type="search"
           placeholder="Filter playlists…" value="${escapeHtml(filter)}" />
    <ul id="organize-list" class="org-list">
      ${playlists.length === 0
        ? `<li class="empty-state">No playlists match.</li>`
        : playlists.map(organizationEntryHtml).join("")}
    </ul>
    <p class="muted org-shown">${playlists.length} of ${candidates.length} playlists shown</p>`;
}

/** Choose mode: checkboxes deciding which playlists appear as drop targets. */
function selectionModeHtml() {
  const entries = candidatePlaylists()
    .map((playlist) => {
      const checked = !selection || selection.has(String(playlist.id));
      return `<li>
        <label class="org-check">
          <input type="checkbox" data-org-select-id="${playlist.id}" ${checked ? "checked" : ""} />
          <span class="org-check-title" title="${escapeHtml(playlist.title)}">${escapeHtml(playlist.title)}</span>
        </label>
      </li>`;
    })
    .join("");
  return `
    <p class="muted org-help">Tick the playlists you want as drop targets in the sidebar.</p>
    <div class="org-actions">
      <button class="button button-quiet" type="button" data-org-selection="all">All</button>
      <button class="button button-quiet" type="button" data-org-selection="none">None</button>
    </div>
    <ul class="org-check-list">${entries || `<li class="empty-state">You have no other playlists.</li>`}</ul>`;
}

/** One sidebar entry: the card is the "add" drop zone, the strip is "move". */
function organizationEntryHtml(playlist) {
  const letter = (playlist.title ?? "?").trim().charAt(0).toUpperCase() || "♪";
  const artwork = playlist.artwork_url
    ? `<img class="org-art" src="${escapeHtml(playlist.artwork_url)}" alt="" loading="lazy" />`
    : `<span class="org-art org-art-placeholder">${escapeHtml(letter)}</span>`;
  const privateBadge = playlist.sharing === "private" ? ` <span class="badge type-private">Private</span>` : "";

  return `<li class="org-item" data-org-playlist-id="${playlist.id}">
    <div class="org-drop" data-org-action="add" title="Drop to add the dragged sound to this playlist">
      ${artwork}
      <span class="org-body">
        <span class="org-title" title="${escapeHtml(playlist.title)}">${escapeHtml(playlist.title)}</span>
        <span class="org-count muted">${formatCount(playlist.track_count ?? 0)} tracks${privateBadge}</span>
      </span>
    </div>
    <div class="org-move" data-org-action="move" title="Drop to add the sound here and remove it from the current playlist">⇥</div>
  </li>`;
}

// --- Drag & drop -------------------------------------------------------------

/** Track rows start the drag; the dragged track is kept in module state. */
export function onTrackDragStart(event) {
  const row = event.target.closest?.(".track-row");
  const trackId = row?.dataset.trackId;
  const track = trackId && state.tracks.find((t) => String(t.id) === trackId);
  if (!track) return;
  dragged = { track };
  event.dataTransfer.effectAllowed = "copyMove";
  event.dataTransfer.setData("text/plain", String(track.id));
  row.classList.add("is-dragging");
  event.dataTransfer.setDragImage?.(row, 24, 24);
  window.addEventListener("dragend", clearDragged, { once: true });
}

function clearDragged() {
  dragged = null;
  document.querySelectorAll(".track-row.is-dragging").forEach((el) => el.classList.remove("is-dragging"));
  document.querySelectorAll(".org-item .is-over").forEach((el) => el.classList.remove("is-over"));
}

/** Sidebar dragover: allow the drop and highlight the hovered zone. */
export function onOrganizeDragOver(event) {
  if (!dragged) return;
  const zone = event.target.closest("[data-org-action]");
  const item = event.target.closest(".org-item");
  if (!zone || !item) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = zone.dataset.orgAction === "move" ? "move" : "copy";
  item.querySelectorAll(".is-over").forEach((el) => el.classList.remove("is-over"));
  zone.classList.add("is-over");
}

/** Sidebar dragleave: drop the highlight when leaving a zone. */
export function onOrganizeDragLeave(event) {
  const zone = event.target.closest("[data-org-action]");
  if (zone) zone.classList.remove("is-over");
}

/** Sidebar drop: "add" copies the track, "move" copies + removes from here. */
export function onOrganizeDrop(event) {
  if (!dragged) return;
  const zone = event.target.closest("[data-org-action]");
  const item = event.target.closest(".org-item");
  if (!zone || !item) return;
  event.preventDefault();
  const { track } = dragged;
  clearDragged();

  const playlist = state.playlists.find((p) => String(p.id) === item.dataset.orgPlaylistId);
  if (!playlist) return;
  if (zone.dataset.orgAction === "move") {
    void moveTrack(track, playlist);
  } else {
    void addTrack(track, playlist);
  }
}

/**
 * Stack of reversible operations, newest last. Each entry snapshots the full
 * track list of every playlist it touched, so reverting restores both the
 * membership AND the original track order via a single PUT per playlist.
 */
const undoStack = [];

/** Show/hide the toolbar Revert button after every operation. */
export function renderUndoButton() {
  const button = document.getElementById("undo-action");
  if (!button) return;
  const entry = undoStack[undoStack.length - 1];
  button.hidden = !entry;
  if (entry) button.textContent = `↩ Revert: ${entry.label}`;
}

/** Undo the most recent add/move/remove (button in the toolbar). */
export async function revertLastAction() {
  const entry = undoStack.pop();
  if (!entry) return;
  renderUndoButton();
  showStatus(`Reverting: ${entry.label}…`);
  try {
    for (const change of entry.changes) {
      await state.api.updatePlaylistTracks(change.playlist.id, change.before.map((t) => t.id));
      change.playlist.track_count = change.before.length;
    }
  } catch (err) {
    undoStack.push(entry); // still revertible — let the user retry
    renderUndoButton();
    showStatus(`Could not revert: ${err.message}`, "error");
    return;
  }
  renderOrganizeSidebar();
  // If the open playlist was touched, restore its view straight from the
  // snapshot (full track list, original order — no refetch needed).
  const currentChange = entry.changes.find(
    (change) => String(change.playlist.id) === String(state.currentPlaylist?.id),
  );
  if (currentChange) {
    state.tracks = [...currentChange.before];
    state.tracksLoaded = true;
    state.trackPager = { get done() { return true; }, async next() { return null; } };
    renderPlaylistHeader();
    renderTrackList();
  }
  showStatus(`Reverted: ${entry.label}.`, "success");
  setTimeout(clearStatus, 3000);
}

// --- Operations (read playlist → modify id list → PUT) ------------------------

async function rewritePlaylist(playlist, trackIds) {
  const updated = await state.api.updatePlaylistTracks(playlist.id, trackIds);
  // Keep the sidebar counts in sync with what SoundCloud now reports.
  playlist.track_count = updated?.track_count ?? trackIds.length;
  renderOrganizeSidebar();
}

/** Add a track to a target playlist (no-op when it is already there). */
async function addTrack(track, playlist) {
  showStatus(`Adding “${track.title}” to “${playlist.title}”…`);
  try {
    const full = await state.api.getPlaylist(playlist.id);
    const before = (full.tracks ?? []).slice(); // full track objects — the revert snapshot
    const ids = before.map((t) => t.id);
    if (ids.some((id) => String(id) === String(track.id))) {
      showStatus(`“${track.title}” is already in “${playlist.title}”.`, "info");
      setTimeout(clearStatus, 3000);
      return;
    }
    ids.push(track.id);
    await rewritePlaylist(playlist, ids);
    undoStack.push({ label: `Add to “${playlist.title}”`, track, changes: [{ playlist, before }] });
    renderUndoButton();
    showStatus(`Added “${track.title}” to “${playlist.title}”.`, "success");
  } catch (err) {
    showStatus(`Could not add the sound: ${err.message}`, "error");
    return;
  }
  setTimeout(clearStatus, 3000);
}

/** Add the track to the target playlist and remove it from the open one. */
async function moveTrack(track, playlist) {
  showStatus(`Moving “${track.title}” to “${playlist.title}”…`);
  try {
    const target = await state.api.getPlaylist(playlist.id);
    const targetBefore = (target.tracks ?? []).slice();
    const targetIds = targetBefore.map((t) => t.id);
    if (!targetIds.some((id) => String(id) === String(track.id))) {
      targetIds.push(track.id);
      await rewritePlaylist(playlist, targetIds);
    }

    const current = await state.api.getPlaylist(state.currentPlaylist.id);
    const currentBefore = (current.tracks ?? []).slice();
    const remainingIds = currentBefore.map((t) => t.id).filter((id) => String(id) !== String(track.id));
    await rewritePlaylist(state.currentPlaylist, remainingIds);

    undoStack.push({
      label: `Move to “${playlist.title}”`,
      track,
      changes: [
        { playlist, before: targetBefore },
        { playlist: state.currentPlaylist, before: currentBefore },
      ],
    });
    renderUndoButton();

    // Reflect the removal in the open view (the track is gone from here).
    state.tracks = state.tracks.filter((t) => String(t.id) !== String(track.id));
    state.currentPlaylist.track_count = remainingIds.length;
    renderPlaylistHeader();
    renderTrackList();
    showStatus(`Moved “${track.title}” to “${playlist.title}”.`, "success");
  } catch (err) {
    showStatus(`Could not move the sound: ${err.message}`, "error");
    return;
  }
  setTimeout(clearStatus, 3000);
}

/**
 * Drop zone above the track list: dropping a sound here removes it from the
 * playlist currently open.
 */
export function onRemoveZoneDragOver(event) {
  if (!dragged) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
}

export function onRemoveZoneDragLeave(event) {
  event.currentTarget.classList.remove("is-over");
}

export function onRemoveZoneDrop(event) {
  if (!dragged) return;
  event.preventDefault();
  const { track } = dragged;
  clearDragged();
  void removeTrack(track);
}

/** Remove a track from the playlist currently open. */
async function removeTrack(track) {
  const current = state.currentPlaylist;
  showStatus(`Removing “${track.title}” from “${current.title}”…`);
  try {
    const full = await state.api.getPlaylist(current.id);
    const before = (full.tracks ?? []).slice();
    const remainingIds = before.map((t) => t.id).filter((id) => String(id) !== String(track.id));
    await rewritePlaylist(current, remainingIds);
    undoStack.push({ label: `Remove from “${current.title}”`, track, changes: [{ playlist: current, before }] });
    renderUndoButton();

    // Reflect the removal in the open view.
    state.tracks = state.tracks.filter((t) => String(t.id) !== String(track.id));
    current.track_count = remainingIds.length;
    renderPlaylistHeader();
    renderTrackList();
    showStatus(`Removed “${track.title}” from “${current.title}”.`, "success");
  } catch (err) {
    showStatus(`Could not remove the sound: ${err.message}`, "error");
    return;
  }
  setTimeout(clearStatus, 3000);
}

// --- Sidebar lifecycle -------------------------------------------------------

/** Live-apply the filter text (re-renders only the entry list). */
export function onOrganizeFilterInput() {
  const input = document.getElementById("organize-filter");
  if (!input) return;
  filter = input.value;
  const list = document.getElementById("organize-list");
  const playlists = visiblePlaylists();
  list.innerHTML = playlists.length === 0
    ? `<li class="empty-state">No playlists match.</li>`
    : playlists.map(organizationEntryHtml).join("");
}

/** Header buttons: toggle choose mode, or apply All/None from it. */
export function onOrganizeClick(event) {
  if (event.target.closest("#organize-choose")) {
    selectionMode = !selectionMode;
    renderOrganizeSidebar();
    return;
  }
  const bulk = event.target.closest("[data-org-selection]");
  if (bulk) {
    selection = bulk.dataset.orgSelection === "all" ? null : new Set();
    saveSelection();
    renderOrganizeSidebar();
  }
}

/** Checkbox toggles in choose mode update the persisted selection. */
export function onOrganizeChange(event) {
  const box = event.target.closest("input[data-org-select-id]");
  if (!box) return;
  if (selection === null) {
    // "All" is implicit — materialize it before unchecking the first box.
    selection = new Set(candidatePlaylists().map((playlist) => String(playlist.id)));
  }
  const id = box.dataset.orgSelectId;
  if (box.checked) {
    selection.add(id);
  } else {
    selection.delete(id);
  }
  saveSelection();
}

/** Forget the filter when leaving the playlist screen. */
export function resetOrganizeSidebar() {
  filter = "";
  dragged = null;
  selectionMode = false;
  undoStack.length = 0;
  renderUndoButton();
}