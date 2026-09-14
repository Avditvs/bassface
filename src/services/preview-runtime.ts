/**
 * Non-reactive preview internals: the shared `<audio>` element (registered by
 * the React component that renders it), the object-URL bookkeeping and the
 * mutable fields of the active preview that never need to re-render.
 */

import type { JumpState, PreviewMode } from "../services/types";

let audioEl: HTMLAudioElement | null = null;

/** Called by the `<AudioPreview>` component with its element (null on unmount). */
export function registerAudioElement(element: HTMLAudioElement | null): void {
  audioEl = element;
}

/** The shared `<audio>` element; throws when the playlist screen is not mounted. */
export function getAudio(): HTMLAudioElement {
  if (!audioEl) throw new Error("Preview audio element is not mounted");
  return audioEl;
}

/** Mutable internals of the preview currently being prepared/played. */
export interface PreviewRuntime {
  /** Track the preview is for (null = none). */
  trackId: number | null;
  mode: PreviewMode;
  blob: Blob | null;
  pendingSeekSec: number | null;
  /** Track time (seconds) at which the blob audio begins. */
  originSec: number | null;
  /** Total length (seconds) of the timeline the element plays: the HLS
   *  stream total when segments exist, the full-mp3 duration on the fallback
   *  path — null while unknown (the metadata duration is used instead). */
  streamTotalSec: number | null;
  jump: JumpState | null;
  extending: boolean;
  objectUrl: string | null;
}

export const previewRuntime: PreviewRuntime = {
  trackId: null,
  mode: "start",
  blob: null,
  pendingSeekSec: null,
  originSec: null,
  streamTotalSec: null,
  jump: null,
  extending: false,
  objectUrl: null,
};

/** Free the blob backing the current preview, if any. */
export function revokePreviewObjectUrl(): void {
  if (previewRuntime.objectUrl) {
    URL.revokeObjectURL(previewRuntime.objectUrl);
    previewRuntime.objectUrl = null;
  }
}
