/**
 * Per-track waveform canvas: ensures the loudness bars are loaded and draws
 * them (with the played-portion highlight). Redraws on window resize; the
 * played portion is refreshed imperatively from the audio `timeupdate`
 * handler (see preview.ts `updatePreviewTime`).
 */

import { useEffect, useRef, useState } from "react";
import { drawWaveform, ensureWaveformBars } from "../services/waveform";
import { seekFromWaveform } from "../services/preview";
import type { Track } from "../services/types";

export function WaveformCanvas({ track, className = "track-waveform" }: { track: Track; className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  /** Loudness bars once loaded (empty array = no waveform for this track). */
  const [bars, setBars] = useState<number[] | null>(null);

  const redraw = (waveBars: number[]) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    try {
      drawWaveform(canvas, track.id, waveBars);
    } catch {
      /* audio element not mounted (playlist screen closing) */
    }
  };

  useEffect(() => {
    let cancelled = false;
    void ensureWaveformBars(track).then((resolved) => {
      if (!cancelled && resolved) setBars(resolved);
    });
    return () => { cancelled = true; };
  }, [track]);

  // Initial draw once the bars (and the layout) are available.
  useEffect(() => {
    if (bars) redraw(bars);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bars]);

  // Window resizes change the canvas width: redraw (debounced — a resize
  // fires dozens of times while dragging).
  useEffect(() => {
    let timer = 0;
    const onResize = () => {
      clearTimeout(timer);
      timer = window.setTimeout(() => bars && redraw(bars), 120);
    };
    window.addEventListener("resize", onResize);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("resize", onResize);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bars, track.id]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      data-waveform-track={track.id}
      title="Click the waveform to jump into this track"
      aria-hidden="true"
      onClick={(event) => seekFromWaveform(event.currentTarget, event.nativeEvent)}
    />
  );
}
