/**
 * Screen switching and the shared status bar.
 */

import { escapeHtml } from "./util.js";
import type { ScreenName, StatusKind } from "./types.js";

const screens: Record<ScreenName, HTMLElement> = {
  connect: document.getElementById("connect-screen")!,
  playlists: document.getElementById("playlists-screen")!,
  playlist: document.getElementById("playlist-screen")!,
};

/** Show exactly one of the three app screens (`connect`|`playlists`|`playlist`). */
export function showScreen(name: ScreenName): void {
  for (const screenKey of Object.keys(screens) as ScreenName[]) {
    screens[screenKey].hidden = screenKey !== name;
  }
}

/** Message bar above the content: a spinner while loading, colour by kind. */
export function showStatus(message: string, kind: StatusKind = "loading"): void {
  const bar = document.getElementById("status-bar")!;
  bar.hidden = false;
  bar.className = kind ? `status-bar ${kind}` : "status-bar";
  bar.innerHTML = kind === "loading"
    ? `<span class="spinner" aria-hidden="true"></span>${escapeHtml(message)}`
    : escapeHtml(message);
}

export function clearStatus(): void {
  document.getElementById("status-bar")!.hidden = true;
}
