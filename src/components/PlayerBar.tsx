/**
 * Bottom playback bar for the shared SoundCloud preview. It stays available
 * while a preview is loading, playing, or paused.
 */

import { useEffect, useRef, useState } from "react";
import { getState, useApp } from "../services/store";
import { stopPreview, togglePreview } from "../services/preview";
import { formatDuration } from "../services/util";
import { WaveformCanvas } from "./WaveformCanvas";

export function PlayerBar() {
  const state = useApp();
  const barRef = useRef<HTMLElement>(null);
  const [, setHeightTick] = useState(0);

  // Expose the bar's real height as a CSS variable: the mobile playlist
  // screen docks the pinned Reorganize panel exactly on top of the bar and
  // reserves the same room at the page end. Measuring (instead of guessing
  // pixels) keeps the stack seamless with any font size or content wrap.
  useEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const update = () => {
      document.documentElement.style.setProperty(
        "--player-bar-h",
        `${Math.ceil(bar.getBoundingClientRect().height)}px`,
      );
      setHeightTick((tick) => tick + 1); // re-render consumers after resize
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(bar);
    return () => {
      observer.disconnect();
      document.documentElement.style.removeProperty("--player-bar-h");
    };
  }, [Boolean(state.previewTrackId)]); // re-attach when the bar mounts/unmounts

  const track = state.previewTrack ?? (state.previewTrackId === null
    ? null
    : state.tracks.find((item) => item.id === state.previewTrackId) ?? null);

  if (!track) return null;

  const duration = Math.max(0, state.previewDurationMs || track.duration);
  const position = Math.min(Math.max(0, state.previewPositionMs), duration);
  const progress = duration ? (position / duration) * 100 : 0;
  const isLoading = state.previewLoading;
  const isPlaying = state.previewPlaying;
  const label = isLoading ? "Loading preview" : isPlaying ? "Now playing" : "Preview paused";
  const artist = track.user?.username ?? "Unknown artist";

  return (
    <aside ref={barRef} className="player-bar" aria-label="Current preview">
      <div className="player-progress" aria-hidden="true">
        <span style={{ width: `${progress}%` }} />
      </div>
      <div className="player-bar__content">
        {track.artwork_url ? (
          <img className="player-art" src={track.artwork_url} alt="" />
        ) : (
          <div className="player-art player-art--placeholder" aria-hidden="true">♪</div>
        )}
        <div className="player-track">
          <span className="player-indicator">
            {isLoading ? <span className="spinner" aria-hidden="true" /> : <span className={`player-equalizer${isPlaying ? " is-playing" : ""}`} aria-hidden="true"><i /><i /><i /></span>}
            {label}
          </span>
          <strong title={track.title ?? "Untitled"}>{track.title ?? "Untitled"}</strong>
          <span className="player-artist">{artist}{track.genre ? ` · ${track.genre}` : ""}</span>
        </div>
        {/* Keyed by track: a fresh canvas per track, so a switch can never
            leave the previous track's bars painted. */}
        <WaveformCanvas key={track.id} track={track} className="player-waveform" />
        <span className="player-time" aria-label={`Position ${formatDuration(position)} of ${formatDuration(duration)}`}>
          {formatDuration(position)} <span>/</span> {formatDuration(duration)}
        </span>
        <div className="player-actions">
          <button
            className="player-control player-control--primary"
            type="button"
            disabled={isLoading}
            aria-label={isPlaying ? "Pause preview" : "Resume preview"}
            title={isPlaying ? "Pause" : "Play"}
            onClick={() => void togglePreview(track.id)}
          >
            {isPlaying ? "❚❚" : "▶"}
          </button>
          <button
            className="player-control"
            type="button"
            aria-label="Close preview"
            title="Close preview"
            onClick={stopPreview}
          >
            ×
          </button>
        </div>
      </div>
    </aside>
  );
}
