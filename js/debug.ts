/**
 * Troubleshooting log: a persistent ring buffer (localStorage) shown in the
 * on-page panel of the connect screen. Everything user-visible goes through
 * `dbg`, and the SoundCloudApi mirrors its requests into it as well.
 */

import { redactSecrets } from "./util.js";

const DEBUG_KEY = "playlist_updater.debug";
const DEBUG_MAX_LINES = 60;

function readDebugLog(): string[] {
  try {
    return JSON.parse(localStorage.getItem(DEBUG_KEY) ?? "null") ?? [];
  } catch {
    return [];
  }
}

/** Append a timestamped line to the log (console + panel + storage).
 *  Every line is redacted first: logged URLs can embed OAuth tokens
 *  (`?oauth_token=…` on stream URLs) or error bodies quoting secrets. */
export function dbg(message: string): void {
  const line = `${new Date().toISOString().slice(11, 19)} ${redactSecrets(message)}`;
  console.info(line);
  const log = readDebugLog();
  log.push(line);
  while (log.length > DEBUG_MAX_LINES) log.shift();
  try {
    localStorage.setItem(DEBUG_KEY, JSON.stringify(log));
  } catch { /* non-fatal */ }
  renderDebugPanel();
}

/** Redraw the `<pre id="debug-log">` panel with the current log. */
export function renderDebugPanel(): void {
  const panel = document.getElementById("debug-log");
  if (panel) panel.textContent = readDebugLog().join("\n") || "No events logged yet.";
}
