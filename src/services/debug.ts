/**
 * Troubleshooting log: a persistent ring buffer (localStorage) shown in the
 * on-page panel of the connect screen. Everything user-visible goes through
 * `dbg`, and the SoundCloudApi mirrors its requests into it as well.
 *
 * The React panel subscribes with `useSyncExternalStore(subscribeDebugLog, getDebugLog)`.
 */

import { redactSecrets } from "./util";

const DEBUG_KEY = "playlist_updater.debug";
const DEBUG_MAX_LINES = 60;

let logLines: string[] = readDebugLog();
const listeners = new Set<() => void>();

function readDebugLog(): string[] {
  try {
    return JSON.parse(localStorage.getItem(DEBUG_KEY) ?? "null") ?? [];
  } catch {
    return [];
  }
}

/** Snapshot for React's `useSyncExternalStore` (must be referentially stable). */
export function getDebugLog(): string[] {
  return logLines;
}

export function subscribeDebugLog(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function persist(): void {
  try {
    localStorage.setItem(DEBUG_KEY, JSON.stringify(logLines));
  } catch { /* non-fatal */ }
  listeners.forEach((listener) => listener());
}

/** Append a timestamped line to the log (console + panel + storage).
 *  Every line is redacted first: logged URLs can embed OAuth tokens
 *  (`?oauth_token=…` on stream URLs) or error bodies quoting secrets. */
export function dbg(message: string): void {
  const line = `${new Date().toISOString().slice(11, 19)} ${redactSecrets(message)}`;
  console.info(line);
  logLines = [...logLines, line];
  while (logLines.length > DEBUG_MAX_LINES) logLines = logLines.slice(1);
  persist();
}

/** Rendered text of the log for the `<pre>` panel. */
export function debugLogText(): string {
  return logLines.join("\n") || "No events logged yet.";
}
