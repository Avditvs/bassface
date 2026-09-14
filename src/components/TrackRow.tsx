/**
 * One row of the track list: index, artwork, title/artist, waveform, meta
 * line and the play/pause preview button.
 */

import { useRef } from "react";
import { getState } from "../services/store";
import { togglePreview } from "../services/preview";
import { analyzeTrackChroma } from "../services/chroma";
import { onTrackDragStart } from "../services/organize";
import { escapeUrl, formatCount, formatDuration } from "../services/util";
import { WaveformCanvas } from "./WaveformCanvas";
import type { Track } from "../services/types";

/** Glyph + classes for the row's play/pause preview button. */
function PreviewButton({ track }: { track: Track }) {
  const state = getState();
  const isActive = state.previewTrackId === track.id && !state.previewLoading;
  const isLoading = state.previewTrackId === track.id && state.previewLoading;
  const glyph = isActive && state.previewPlaying ? "⏸" : "▶";
  const label = isActive && state.previewPlaying ? "Pause the preview" : "Play the preview";
  const className = [
    "track-preview",
    isActive ? "is-active" : "",
    isLoading ? "is-loading" : "",
  ].filter(Boolean).join(" ");

  return (
    <button
      className={className}
      type="button"
      data-preview-track={track.id}
      title={label}
      aria-label={`${label} of ${track.title ?? "track"}`}
      onClick={() => void togglePreview(track.id)}
    >
      {isLoading ? <span className="spinner" aria-hidden="true" /> : glyph}
    </button>
  );
}

/**
 * Button that estimates the track's key from 1–2 HLS segments (chroma).
 * Shows ♪ until a key is known, then the key label itself (still clickable
 * to re-analyze).
 */
function ChromaButton({ track }: { track: Track }) {
  const state = getState();
  const key = state.chromaKeys[track.id];
  const isLoading = state.chromaLoadingTrackId === track.id;
  const label = key
    ? `Estimated key: ${key} — re-analyze`
    : "Estimate the key from 1–2 HLS segments (chroma analysis)";
  return (
    <button
      className={`track-chroma${key ? " has-key" : ""}${isLoading ? " is-loading" : ""}`}
      type="button"
      data-chroma-track={track.id}
      title={label}
      aria-label={`${label} of ${track.title ?? "track"}`}
      onClick={() => void analyzeTrackChroma(track.id)}
    >
      {isLoading ? <span className="spinner" aria-hidden="true" /> : key ?? "♪"}
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
        <ChromaButton track={track} />
        <PreviewButton track={track} />
      </span>
    </li>
  );
}
