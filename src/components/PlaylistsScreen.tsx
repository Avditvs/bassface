/**
 * Playlists screen: search / type filter / sorting toolbar, the card grid
 * and windowed pagination. The toolbar state (filter text, sort, page) is
 * component-local; the playlists themselves come from the store.
 */

import { useMemo, useState } from "react";
import { TYPE_LABELS, useApp } from "../services/store";
import { navigateToLiked, navigateToPlaylist } from "../services/router";
import { escapeUrl, playlistBucket } from "../services/util";
import { Artwork, Badges, CardMeta } from "./shared";
import type { Playlist, SortKey } from "../services/types";

const SORTERS: Record<SortKey, (a: Playlist, b: Playlist) => number> = {
  updated: (a, b) => new Date(b.last_modified ?? b.created_at ?? 0).getTime() - new Date(a.last_modified ?? a.created_at ?? 0).getTime(),
  name: (a, b) => (a.title ?? "").localeCompare(b.title ?? ""),
  tracks: (a, b) => (b.track_count ?? 0) - (a.track_count ?? 0),
  likes: (a, b) => (b.likes_count ?? 0) - (a.likes_count ?? 0),
};

const PAGE_SIZE = 24;

/** One playlist card of the grid. */
function PlaylistCard({ playlist }: { playlist: Playlist }) {
  return (
    <li
      data-playlist-id={playlist.id}
      title="View the tracks in this playlist"
      onClick={(event) => {
        if ((event.target as Element).closest("a")) return;
        navigateToPlaylist(playlist.id);
      }}
    >
      <Artwork artworkUrl={playlist.artwork_url} />
      <div className="card-body">
        <h3 className="card-title" title={playlist.title ?? ""}>{playlist.title ?? ""}</h3>
        <Badges playlist={playlist} />
        {playlist.description && (
          <p className="muted card-desc">
            {playlist.description.length > 120 ? playlist.description.slice(0, 120) + "…" : playlist.description}
          </p>
        )}
        <CardMeta playlist={playlist} />
        <div className="card-actions">
          <button
            className="button card-open"
            type="button"
            onClick={() => navigateToPlaylist(playlist.id)}
          >
            View tracks
          </button>
          <a href={escapeUrl(playlist.permalink_url)} target="_blank" rel="noreferrer" title="Open on SoundCloud">SoundCloud ↗</a>
        </div>
      </div>
    </li>
  );
}

/** Windowed page numbers: 1 … 4 5 6 … 12 (context around the current page). */
function Pagination({ page, pageCount, onPage }: {
  page: number;
  pageCount: number;
  onPage: (page: number) => void;
}) {
  if (pageCount <= 1) return null;

  const numbers: (number | "…")[] = [];
  for (let p = 1; p <= pageCount; p += 1) {
    if (p === 1 || p === pageCount || Math.abs(p - page) <= 1) {
      numbers.push(p);
    } else if (numbers[numbers.length - 1] !== "…") {
      numbers.push("…");
    }
  }

  return (
    <nav className="pagination" aria-label="Playlist pages">
      <button
        className="page-number page-prev"
        type="button"
        disabled={page === 1}
        aria-label="Previous page"
        onClick={() => onPage(page - 1)}
      >
        ‹ Prev
      </button>
      {numbers.map((n, index) => (n === "…"
        ? <span key={`ellipsis-${index}`} className="page-ellipsis" aria-hidden="true">…</span>
        : (
          <button
            key={n}
            className={`page-number${n === page ? " is-current" : ""}`}
            type="button"
            aria-current={n === page ? "page" : "false"}
            onClick={() => onPage(n)}
          >
            {n}
          </button>
        )))}
      <button
        className="page-number page-next"
        type="button"
        disabled={page === pageCount}
        aria-label="Next page"
        onClick={() => onPage(page + 1)}
      >
        Next ›
      </button>
      <span className="page-info">Page {page} of {pageCount}</span>
    </nav>
  );
}

export function PlaylistsScreen() {
  const { playlists, playlistsLoading } = useApp();
  const [search, setSearch] = useState("");
  const [type, setType] = useState("");
  const [sort, setSort] = useState<SortKey>("updated");
  const [page, setPage] = useState(1);

  const types = useMemo(
    () => [...new Set(playlists.map(playlistBucket))].sort(),
    [playlists],
  );

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    const filtered = playlists.filter((playlist) => {
      const matchesQuery = !query || playlist.title?.toLowerCase().includes(query);
      const matchesType = !type || playlistBucket(playlist) === type;
      return matchesQuery && matchesType;
    });
    return filtered.sort(SORTERS[sort] ?? (() => 0));
  }, [playlists, search, type, sort]);

  // Clamp the page in case the filters shrank the result set.
  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const currentPage = Math.min(Math.max(1, page), pageCount);
  const start = (currentPage - 1) * PAGE_SIZE;
  const pageItems = visible.slice(start, start + PAGE_SIZE);

  const changePage = (target: number) => {
    setPage(target);
    document.getElementById("playlists-screen")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const resetPageAndRender = (apply: () => void) => {
    apply();
    setPage(1);
  };

  return (
    <section id="playlists-screen">
      <div className="toolbar">
        <button
          className="button button-quiet"
          type="button"
          title="List every track you liked on SoundCloud, most recently liked first — drag them onto playlists in the Reorganize sidebar"
          onClick={navigateToLiked}
        >
          ♥ Liked tracks
        </button>
        <input
          className="search"
          type="search"
          placeholder="Filter playlists…"
          value={search}
          onChange={(event) => resetPageAndRender(() => setSearch(event.target.value))}
        />
        <select
          className="select"
          aria-label="Playlist type"
          value={type}
          onChange={(event) => resetPageAndRender(() => setType(event.target.value))}
        >
          <option value="">All types</option>
          {types.map((t) => (
            <option key={t} value={t}>{TYPE_LABELS[t] ?? t}</option>
          ))}
        </select>
        <select
          className="select"
          aria-label="Sort order"
          value={sort}
          onChange={(event) => resetPageAndRender(() => setSort(event.target.value as SortKey))}
        >
          <option value="updated">Recently updated</option>
          <option value="name">Name (A–Z)</option>
          <option value="tracks">Track count</option>
          <option value="likes">Most liked</option>
        </select>
      </div>

      <p className="muted" id="summary">
        {`${visible.length} playlist${visible.length === 1 ? "" : "s"} · ${playlists.length} total`}
      </p>

      <ul id="playlist-list" className="playlist-grid">
        {playlistsLoading && (
          <li className="empty-state"><span className="spinner" aria-hidden="true" />Loading your playlists…</li>
        )}
        {!playlistsLoading && visible.length === 0 && (
          <li className="empty-state">No playlists match your filters.</li>
        )}
        {!playlistsLoading && pageItems.map((playlist) => (
          <PlaylistCard key={playlist.id} playlist={playlist} />
        ))}
      </ul>

      <Pagination page={currentPage} pageCount={pageCount} onPage={changePage} />
    </section>
);
}
