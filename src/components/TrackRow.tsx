/**
 * One row of the track list: index, artwork, title/artist, waveform, meta
 * line and the play/pause preview button.
 */

import { Fragment, useRef } from "react";
import { getState } from "../services/store";
import { togglePreview } from "../services/preview";
import { analyzeTrackBpm } from "../services/bpm";
import { analyzeTrackChroma } from "../services/chroma";
import { onTrackDragStart, removeTrack } from "../services/organize";
import { isLikedView } from "../services/tracks";
import { escapeUrl, formatCount, formatDate, formatDuration } from "../services/util";
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
 * Button that estimates both the track's BPM (onset autocorrelation, see
 * services/bpm.ts) and its key (chroma, see services/chroma.ts). The results
 * are shown under the track title; the button shows ↻ once both are known.
 */
function AnalyzeButton({ track }: { track: Track }) {
  const state = getState();
  const analyzed = Boolean(state.bpmValues[track.id] ?? state.chromaKeys[track.id]);
  const isLoading = state.bpmLoadingTrackId === track.id
    || state.chromaLoadingTrackId === track.id;
  const label = analyzed
    ? "Re-analyze BPM and key"
    : "Estimate the BPM and the key from segments of the track";
  return (
    <button
      className={`track-analyze${analyzed ? " is-analyzed" : ""}${isLoading ? " is-loading" : ""}`}
      type="button"
      data-analyze-track={track.id}
      title={label}
      aria-label={`${label} of ${track.title ?? "track"}`}
      onClick={() => void analyzeTrack(track.id)}
    >
      {isLoading ? <span className="spinner" aria-hidden="true" /> : analyzed ? "↻" : "♪"}
    </button>
  );
}

/** Estimate both the BPM and the key of a track, sequentially. */
async function analyzeTrack(trackId: number): Promise<void> {
  await analyzeTrackBpm(trackId);
  await analyzeTrackChroma(trackId);
}

/**
 * Sub line of a track row: artist name, then the BPM/key pill once known,
 * then the like date — separated by " · ", hidden when all parts are empty.
 */
function TrackSub({ track, liked }: { track: Track; liked: string }) {
  const state = getState();
  const bpm = state.bpmValues[track.id];
  const key = state.chromaKeys[track.id];
  const username = track.user?.username;
  if (!username && !bpm && !key && !liked) return null;
  const parts = [
    username ? <span key="artist">{username}</span> : null,
    (bpm || key) && (
      <span key="analysis" className="track-analysis">
        {bpm ? <span title={`Estimated tempo: ${bpm} BPM`}>♩ {bpm} BPM</span> : null}
        {bpm && key ? " " : ""}
        {key ? <span title={`Estimated key: ${key}`}>♪ {key}</span> : null}
      </span>
    ),
    liked ? <span key="liked">{liked}</span> : null,
  ].filter(Boolean);
  return (
    <p className="muted track-sub">
      {parts.map((part, i) => (
        <Fragment key={i}>
          {i > 0 && "\u00a0·\u00a0"}
          {part}
        </Fragment>
      ))}
    </p>
  );
}

/** Distance in px a left swipe must cover before release removes the track. */
const SWIPE_THRESHOLD = 96;
/** Hard stop of the finger-follow translation so the row cannot fly away. */
const SWIPE_MAX = 140;

/** True on touch-driven devices, where HTML5 drag & drop is unavailable. */
function isTouchDevice(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;
}

export function TrackRow({ track, index }: { track: Track; index: number }) {
  const rowRef = useRef<HTMLLIElement>(null);
  const swipe = useRef<{ startX: number; startY: number; shift: number } | null>(null);
  const liked = isLikedView() && track.created_at
    ? `♥ Liked ${formatDate(track.created_at)}`
    : "";
  // HTML5 drag & drop does not fire on touch screens: offer a left swipe
  // instead, like the swipe-to-delete gesture of native list apps.
  const removable = !isLikedView() && isTouchDevice();

  /** Follow the finger: slide the row left and reveal the remove hint. */
  function applySwipeShift(shift: number): void {
    const row = rowRef.current;
    if (!row || !swipe.current) return;
    swipe.current.shift = shift;
    row.style.transform = `translateX(${shift}px)`;
    const hint = row.querySelector<HTMLElement>(".swipe-hint");
    if (!hint) return;
    hint.style.opacity = String(Math.min(1, -shift / SWIPE_THRESHOLD));
    // Counter-translate so the hint stays pinned near the right edge while
    // the row itself slides under the finger.
    hint.style.transform = `translateY(-50%) translateX(${-shift}px)`;
    row.classList.toggle("is-beyond", -shift >= SWIPE_THRESHOLD);
  }

  /** Clear the gesture visuals (row back to rest, hint hidden). */
  function resetSwipeVisuals(): void {
    const row = rowRef.current;
    if (!row) return;
    row.classList.remove("is-swiping", "is-beyond");
    row.style.transform = "";
    const hint = row.querySelector<HTMLElement>(".swipe-hint");
    if (hint) {
      hint.style.opacity = "";
      hint.style.transform = "";
    }
  }

  /** Release: slide the row away and remove it, or spring back to rest. */
  function endSwipe(): void {
    const start = swipe.current;
    swipe.current = null;
    const row = rowRef.current;
    if (!row || !start) return;
    if (start.shift <= -SWIPE_THRESHOLD) {
      row.classList.remove("is-swiping");
      row.classList.add("is-leaving");
      row.style.transform = "translateX(-110%)";
      setTimeout(() => void removeTrack(track), 180); // let the slide finish
      return;
    }
    resetSwipeVisuals();
  }

  return (
    <li
      ref={rowRef}
      className="track-row"
      draggable
      data-track-id={track.id}
      title={removable
        ? "Swipe left to remove this sound from the playlist"
        : "Drag onto a playlist in the Reorganize sidebar to add or move it"}
      onDragStart={(event) => {
        if (rowRef.current) onTrackDragStart(event, track, rowRef.current);
      }}
      onTouchStart={removable ? (event) => {
        const t = event.touches[0];
        swipe.current = { startX: t.clientX, startY: t.clientY, shift: 0 };
        rowRef.current?.classList.add("is-swiping"); // no transition while following
      } : undefined}
      onTouchMove={removable ? (event) => {
        const start = swipe.current;
        if (!start) return;
        const t = event.touches[0];
        const dx = t.clientX - start.startX;
        const dy = t.clientY - start.startY;
        if (Math.abs(dy) > Math.abs(dx)) {
          // Vertical intent: give the gesture back to native scrolling.
          swipe.current = null;
          resetSwipeVisuals();
          return;
        }
        // Leftward only, clamped so the row cannot travel too far.
        applySwipeShift(Math.max(Math.min(dx, 0), -SWIPE_MAX));
      } : undefined}
      onTouchEnd={removable ? () => endSwipe() : undefined}
      onTouchCancel={removable ? () => {
        swipe.current = null;
        resetSwipeVisuals();
      } : undefined}
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
        <TrackSub track={track} liked={liked} />
      </div>
      <WaveformCanvas track={track} />
      <div className="track-meta">
        {/* data-track-time is updated imperatively by updatePreviewTime */}
        <span className="track-time" data-track-time={track.id}>{formatDuration(track.duration)}</span>
        <span>{formatCount(track.playback_count)} plays</span>
        <span>{formatCount(track.likes_count ?? track.favoritings_count)} likes</span>
      </div>
      <span className="track-preview-group">
        <AnalyzeButton track={track} />
        <PreviewButton track={track} />
      </span>
      {removable && (
        <span className="swipe-hint" aria-hidden="true">🗑 Remove</span>
      )}
    </li>
  );
}
