/**
 * The track list: rows, empty/error/loading states and the infinite-scroll
 * sentinel (IntersectionObserver fetches the next page on approach).
 */

import { useEffect, useRef } from "react";
import { useApp } from "../services/store";
import { formatCount } from "../services/util";
import { isLikedView, loadMoreTracks } from "../services/tracks";
import { TrackRow } from "./TrackRow";

export function TrackList() {
  const state = useApp();
  const sentinelRef = useRef<HTMLLIElement>(null);
  const hasMore = state.trackPager !== null && !state.trackPager.done && !state.tracksError;

  // Watch the sentinel row at the end of the list; fetch when it nears view.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!hasMore || !sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loadMoreTracks();
      },
      { rootMargin: "600px 0px" }, // start fetching before the user arrives
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, state.tracks.length]);

  if (!state.tracksLoaded) {
    return (
      <ul id="track-list" className="track-list">
        <li className="empty-state"><span className="spinner" aria-hidden="true" />Loading tracks…</li>
      </ul>
    );
  }
  if (state.tracksError) {
    return (
      <ul id="track-list" className="track-list">
        <li className="empty-state">Could not load the track list — see the message above.</li>
      </ul>
    );
  }

  return (
    <>
      <p className="muted" id="track-summary">
        {state.tracks.length
          ? `${formatCount(state.tracks.length)} liked sound${state.tracks.length === 1 ? "" : "s"}${hasMore ? " — scroll for more" : " in total"}`
          : ""}
      </p>
      <ul id="track-list" className="track-list">
        {state.tracks.length === 0 && (
          <li className="empty-state">{isLikedView() ? "You have not liked any sounds (yet)." : "This playlist has no sounds (yet)."}</li>
        )}
        {state.tracks.map((track, index) => (
          <TrackRow key={track.id} track={track} index={index} />
        ))}
        {hasMore && (
          <li ref={sentinelRef} id="track-sentinel" className="track-sentinel" aria-hidden="true">
            <span className="spinner" />
            Loading more tracks…
          </li>
        )}
      </ul>
    </>
  );
}
