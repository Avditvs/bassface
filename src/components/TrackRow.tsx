/**
 * One row of the track list: index, artwork, title/artist, waveform, meta
 * line and the two preview buttons (▶ snippet, ⏫ loudest part).
 */

import { useRef } from "react";
import { getState } from "../services/store";
import { togglePreview } from "../services/preview";
import { onTrackDragStart } from "../services/organize";
import { escapeUrl, formatCount, formatDuration } from "../services/util";
import { WaveformCanvas } from "./WaveformCanvas";
import type { PreviewMode, Track } from "../services/types";

/** Glyph + classes for one of the two preview buttons of the row. */
function PreviewButton({ track, mode }: { track: Track; mode: "start" | "peak" }) {
  const state = getState();
  // A jump preview (waveform click) is a full-track source like "peak".
  const activeMode: PreviewMode = state.previewMode === "jump" ? "peak" : state.previewMode;
  const isActive = state.previewTrackId === track.id && !state.previewLoading && activeMode === mode;
  const isLoading = state.previewTrackId === track.id && state.previewLoading && activeMode === mode;
  const glyph = isActive && state.previewPlaying ? "⏸" : mode === "peak" ? "⏫" : "▶";
  const label = mode === "peak" ? "Play from the loudest part" : "Play the ~30 s preview";
  const className = [
    "track-preview",
    state.previewTrackId === track.id && activeMode === mode ? "is-active" : "",
    isLoading ? "is-loading" : "",
  ].filter(Boolean).join(" ");

  return (
    <button
      className={className}
      type="button"
      data-preview-track={track.id}
      data-preview-mode={mode}
      title={label}
      aria-label={`${label} of ${track.title ?? "track"}`}
      onClick={() => void togglePreview(track.id, mode)}
    >
      {isLoading ? <span className="spinner" aria-hidden="true" /> : glyph}
    </button>
  );
}

export function TrackRow({ track, index }: { track: Track; index: number }) {
  const rowRef = useRef<HTMLLIElement>(null);
  const byLine = [track.user?.username, track.genre].filter(Boolean).join(" · ");

  return (
    <li
      ref={rowRef}
      className="track-row"
      draggable
      data-track-id={track.id}
      title="Drag onto a playlist in the Reorganize sidebar to add or move it"
      onDragStart={(event) => {
        if (rowRef.current) onTrackDragStart(event, track, rowRef.current);
      }}
    >
      <span className="track-index">{index + 1}</span>
      {track.artwork_url
        ? <div className="track-art"><img src={track.artwork_url} alt="" loading="lazy" /></div>
        : (
          <div className="track-art track-art-placeholder">
            {(track.title ?? "?").trim().charAt(0).toUpperCase() || "♪"}
          </div>
        )}
      <div className="track-body">
        <a className="track-title" href={escapeUrl(track.permalink_url)} target="_blank" rel="noreferrer">
          {track.title ?? "Untitled"}
        </a>
        {byLine && <p className="muted track-sub">{byLine}</p>}
      </div>
      <WaveformCanvas track={track} />
      <div className="track-meta">
        {/* data-track-time is updated imperatively by updatePreviewTime */}
        <span className="track-time" data-track-time={track.id}>{formatDuration(track.duration)}</span>
        <span>{formatCount(track.playback_count)} plays</span>
        <span>{formatCount(track.likes_count ?? track.favoritings_count)} likes</span>
      </div>
      <span className="track-preview-group">
        <PreviewButton track={track} mode="start" />
        <PreviewButton track={track} mode="peak" />
      </span>
    </li>
  );
}
