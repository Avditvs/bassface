/**
 * All DOM rendering: user badge, playlist grid (filters, sorting,
 * pagination), playlist detail header and the track list rows.
 */

import { TYPE_LABELS, state } from "./state.js";
import { escapeHtml, escapeUrl, formatCount, formatDate, formatDuration, playlistBucket, el, targetOf } from "./util.js";
import { previewButtonFor, updatePreviewTime } from "./preview.js";
import { renderWaveforms } from "./waveform.js";
import { observeTrackSentinel, forgetTrackSentinel } from "./tracks.js";
import type { Playlist, SortKey, Track } from "./types.js";

// --- Shared card/header helpers --------------------------------------------

/** Artwork image or a letter placeholder, as HTML. */
function artworkHtml(artworkUrl: string | null | undefined, title: string | undefined): string {
  return artworkUrl
    ? `<div class="artwork"><img src="${escapeUrl(artworkUrl)}" alt="" loading="lazy" /></div>`
    : `<div class="artwork-placeholder">${escapeHtml((title ?? "?").trim().charAt(0).toUpperCase() || "♪")}</div>`;
}

/** Type (+ private) badges and the count/likes/updated meta line. */
function badgesHtml(playlist: Playlist, type: string): { badges: string[]; meta: string } {
  const typeLabel = TYPE_LABELS[type] ?? type;
  const badges = [`<span class="badge type-${escapeHtml(type)}">${escapeHtml(typeLabel)}</span>`];
  if (playlist.sharing === "private") {
    badges.push(`<span class="badge type-private">Private</span>`);
  }
  const updatedAt = playlist.last_modified ?? playlist.created_at;
  const metaLines = [
    `<span>${formatCount(playlist.track_count ?? 0)} tracks</span>`,
    `<span>${formatCount(playlist.likes_count)} likes</span>`,
    updatedAt ? `<span>Updated ${formatDate(updatedAt)}</span>` : "",
  ].filter(Boolean).join("");
  return { badges, meta: `<div class="meta">${metaLines}</div>` };
}

// --- Playlist list (filters, sorting, pagination) --------------------------

const SORTERS: Record<SortKey, (a: Playlist, b: Playlist) => number> = {
  updated: (a, b) => new Date(b.last_modified ?? b.created_at ?? 0).getTime() - new Date(a.last_modified ?? a.created_at ?? 0).getTime(),
  name: (a, b) => (a.title ?? "").localeCompare(b.title ?? ""),
  tracks: (a, b) => (b.track_count ?? 0) - (a.track_count ?? 0),
  likes: (a, b) => (b.likes_count ?? 0) - (a.likes_count ?? 0),
};

/** Playlists of the current page after applying the toolbar filters. */
function visiblePlaylists(): Playlist[] {
  const query = el<HTMLInputElement>("search").value.trim().toLowerCase();
  const type = el<HTMLSelectElement>("type-filter").value;
  const sort = el<HTMLSelectElement>("sort").value as SortKey;

  const playlists = state.playlists.filter((playlist) => {
    const matchesQuery = !query || playlist.title?.toLowerCase().includes(query);
    const matchesType = !type || playlistBucket(playlist) === type;
    return matchesQuery && matchesType;
  });

  return playlists.sort(SORTERS[sort] ?? (() => 0));
}

/** Populate the type filter with the kinds actually present in the list. */
export function renderPlaylistControls(): void {
  const select = el<HTMLSelectElement>("type-filter");
  const types = [...new Set(state.playlists.map(playlistBucket))].sort();
  select.innerHTML = `<option value="">All types</option>` +
    types.map((type) => `<option value="${escapeHtml(type)}">${escapeHtml(TYPE_LABELS[type] ?? type)}</option>`).join("");
}

export function renderPlaylists(): void {
  const list = el("playlist-list");
  const visible = visiblePlaylists();
  el("summary").textContent =
    `${visible.length} playlist${visible.length === 1 ? "" : "s"} · ${state.playlists.length} total`;

  if (state.playlistsLoading) {
    list.innerHTML = `<li class="empty-state"><span class="spinner" aria-hidden="true"></span>Loading your playlists…</li>`;
    renderPagination(0);
    return;
  }
  if (visible.length === 0) {
    list.innerHTML = `<li class="empty-state">No playlists match your filters.`;
    renderPagination(0);
    return;
  }

  // Clamp the page in case the filters shrank the result set.
  const pageCount = Math.max(1, Math.ceil(visible.length / state.pageSize));
  state.page = Math.min(Math.max(1, state.page), pageCount);
  const start = (state.page - 1) * state.pageSize;
  list.innerHTML = visible.slice(start, start + state.pageSize).map(cardFor).join("");
  renderPagination(pageCount);
}

/** Windowed page numbers: 1 … 4 5 6 … 12 (context around the current page). */
export function renderPagination(pageCount: number): void {
  const nav = el("playlist-pagination");
  if (pageCount <= 1) {
    nav.hidden = true;
    nav.innerHTML = "";
    return;
  }

  const numbers: (number | "…")[] = [];
  for (let p = 1; p <= pageCount; p += 1) {
    if (p === 1 || p === pageCount || Math.abs(p - state.page) <= 1) {
      numbers.push(p);
    } else if (numbers[numbers.length - 1] !== "…") {
      numbers.push("…");
    }
  }

  const pageButton = (p: number) =>
    `<button class="page-number${p === state.page ? " is-current" : ""}" type="button" data-goto-page="${p}" aria-current="${p === state.page ? "page" : "false"}">${p}</button>`;
  const ellipsis = `<span class="page-ellipsis" aria-hidden="true">…</span>`;

  nav.hidden = false;
  nav.innerHTML = [
    `<button class="page-number page-prev" type="button" data-goto-page="${state.page - 1}" ${state.page === 1 ? "disabled" : ""} aria-label="Previous page">‹ Prev</button>`,
    ...numbers.map((n) => (n === "…" ? ellipsis : pageButton(n))),
    `<button class="page-number page-next" type="button" data-goto-page="${state.page + 1}" ${state.page === pageCount ? "disabled" : ""} aria-label="Next page">Next ›</button>`,
    `<span class="page-info">Page ${state.page} of ${pageCount}</span>`,
  ].join("");
}

export function onPaginationClick(event: Event): void {
  const button = targetOf(event)?.closest<HTMLButtonElement>("[data-goto-page]");
  if (!button || button.disabled) return;
  const target = Number(button.dataset.gotoPage);
  if (!Number.isInteger(target)) return;
  state.page = target;
  renderPlaylists();
  // Keep the (re-rendered) grid in view after jumping pages.
  el("playlists-screen").scrollIntoView({ behavior: "smooth", block: "start" });
}

/** One playlist card of the grid. */
function cardFor(playlist: Playlist): string {
  const type = playlistBucket(playlist);
  const typeLabel = TYPE_LABELS[type] ?? type;
  const { badges, meta } = badgesHtml(playlist, type);

  const description = playlist.description
    ? `<p class="muted card-desc">${escapeHtml(playlist.description.length > 120 ? playlist.description.slice(0, 120) + "…" : playlist.description)}</p>`
    : "";

  return `<li data-playlist-id="${playlist.id}" title="View the tracks in this playlist">
    ${artworkHtml(playlist.artwork_url, playlist.title)}
    <div class="card-body">
      <h3 class="card-title" title="${escapeHtml(playlist.title ?? "")}">${escapeHtml(playlist.title ?? "")}</h3>
      <div class="badges">${badges.join("")}</div>
      ${description}
      ${meta}
      <div class="card-actions">
        <button class="button card-open" type="button" data-open-playlist>View tracks</button>
        <a href="${escapeUrl(playlist.permalink_url)}" target="_blank" rel="noreferrer" title="Open on SoundCloud">SoundCloud ↗</a>
      </div>
    </div>
  </li>`;
}

/** Cards are clickable, except the external SoundCloud links. */
export function onPlaylistListClick(event: Event): void {
  if (targetOf(event)?.closest("a")) return;
  const card = targetOf(event)?.closest<HTMLElement>("li[data-playlist-id]");
  if (card?.dataset.playlistId) window.location.hash = `#/playlist/${card.dataset.playlistId}`;
}

// --- Playlist detail (header + track list) ---------------------------------

export function renderPlaylist(): void {
  if (!state.currentPlaylist) return;
  renderPlaylistHeader();
  renderTrackList();
}

export function renderPlaylistHeader(): void {
  const playlist = state.currentPlaylist;
  if (!playlist) return;
  const type = playlistBucket(playlist);
  const typeLabel = TYPE_LABELS[type] ?? type;
  const { badges, meta } = badgesHtml(playlist, type);

  const description = playlist.description
    ? `<p class="muted playlist-desc">${escapeHtml(playlist.description)}</p>`
    : "";

  el("playlist-header").innerHTML = `
    <div class="playlist-header-art">${artworkHtml(playlist.artwork_url, playlist.title)}</div>
    <div class="playlist-header-body">
      <h2 class="playlist-title">${escapeHtml(playlist.title ?? "")}</h2>
      <div class="badges">${badges.join("")}</div>
      ${description}
      ${meta}
      <p class="playlist-link"><a href="${escapeUrl(playlist.permalink_url)}" target="_blank" rel="noreferrer">Open on SoundCloud →</a></p>
    </div>`;
}

export function renderTrackList(): void {
  const list = el("track-list");
  const summary = el("track-summary");
  const tracks = state.tracks;
  const hasMore = state.trackPager !== null && !state.trackPager.done && !state.tracksError;
  const totalCount = state.currentPlaylist?.track_count ?? tracks.length;

  if (!state.tracksLoaded) {
    forgetTrackSentinel();
    list.innerHTML = `<li class="empty-state"><span class="spinner" aria-hidden="true"></span>Loading tracks…</li>`;
    return;
  }
  if (state.tracksError) {
    forgetTrackSentinel();
    list.innerHTML = `<li class="empty-state">Could not load the track list — see the message above.</li>`;
    return;
  }

  summary.textContent = tracks.length
    ? `${formatCount(tracks.length)} of ${formatCount(totalCount)} sound${totalCount === 1 ? "" : "s"} in this playlist${hasMore ? " — scroll for more" : ""}`
    : "";

  if (tracks.length === 0) {
    forgetTrackSentinel();
    list.innerHTML = `<li class="empty-state">This playlist has no sounds (yet).</li>`;
    return;
  }
  list.innerHTML = tracks.map(trackRowFor).join("") +
    (hasMore
      ? `<li id="track-sentinel" class="track-sentinel" aria-hidden="true"><span class="spinner"></span>Loading more tracks…</li>`
      : "");
  if (hasMore) {
    observeTrackSentinel();
  } else {
    forgetTrackSentinel();
  }
  updatePreviewTime();
  renderWaveforms();
}

/** One row of the track list. */
function trackRowFor(track: Track, index: number): string {
  const letter = (track.title ?? "?").trim().charAt(0).toUpperCase() || "♪";
  const artwork = track.artwork_url
    ? `<div class="track-art"><img src="${escapeHtml(track.artwork_url)}" alt="" loading="lazy" /></div>`
    : `<div class="track-art track-art-placeholder">${escapeHtml(letter)}</div>`;

  const byLine = [track.user?.username, track.genre].filter(Boolean).join(" · ");
  const title = escapeHtml(track.title ?? "Untitled");
  const permalink = escapeUrl(track.permalink_url);

  return `<li class="track-row" draggable="true" data-track-id="${track.id}" title="Drag onto a playlist in the Reorganize sidebar to add or move it">
    <span class="track-index">${index + 1}</span>
    ${artwork}
    <div class="track-body">
      <a class="track-title" href="${permalink}" target="_blank" rel="noreferrer">${title}</a>
      ${byLine ? `<p class="muted track-sub">${escapeHtml(byLine)}</p>` : ""}
    </div>
    <canvas class="track-waveform" data-waveform-track="${track.id}" title="Click the waveform to jump into this track" aria-hidden="true"></canvas>
    <div class="track-meta">
      <span class="track-time" data-track-time="${track.id}">${formatDuration(track.duration)}</span>
      <span>${formatCount(track.playback_count)} plays</span>
      <span>${formatCount(track.likes_count ?? track.favoritings_count)} likes</span>
    </div>
    <span class="track-preview-group">${previewButtonFor(track, "start")}${previewButtonFor(track, "peak")}</span>
  </li>`;
}

// --- Misc ------------------------------------------------------------------

export function renderUser(): void {
  if (!state.user) return;
  el("user-area").hidden = false;
  const avatar = el<HTMLImageElement>("user-avatar");
  if (state.user.avatar_url) avatar.src = state.user.avatar_url;
  el("user-name").textContent = state.user.username;
}
