/**
 * Local development configuration (see `public/config.local.json.example`).
 *
 * On a loopback origin the app fetches `config.local.json` from the served
 * folder before anything reads the runtime config (main.tsx awaits it).
 * Two modes:
 * - "credentials" (default, also when the file is missing): use the app's
 *   own Client ID/Secret — token requests go straight to SoundCloud.
 * - "proxy": route token requests through the configured token proxy
 *   (worker/), which serves the Client ID and keeps the Secret server-side.
 *
 * The file is a local-only dev aid: gitignored, never shipped to production
 * (and only fetched at all on a loopback origin).
 */

import { isLocalOrigin, type AppConfig } from "./config";
import { dbg } from "./debug";

interface LocalConfigFile {
  mode?: "credentials" | "proxy";
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  tokenProxyUrl?: string;
}

const LOCAL_CONFIG_URL = "config.local.json";

/** Load `config.local.json` on a loopback origin and apply it to `config`. */
export async function loadLocalConfig(config: AppConfig): Promise<void> {
  if (!isLocalOrigin()) return;
  try {
    const response = await fetch(LOCAL_CONFIG_URL, { headers: { accept: "application/json; charset=utf-8" } });
    if (response.status === 404) {
      dbg("[config] no config.local.json — credentials mode, use stored/manual values");
      return;
    }
    if (!response.ok) {
      dbg(`[config] ${LOCAL_CONFIG_URL} fetch failed (${response.status}) — ignored`);
      return;
    }
    const file = (await response.json()) as LocalConfigFile;
    applyLocalConfig(config, file);
    dbg(`[config] ${LOCAL_CONFIG_URL} applied — mode=${config.localMode || "credentials"}`);
  } catch (err) {
    dbg(`[config] ${LOCAL_CONFIG_URL} unreadable (${err instanceof Error ? err.message : String(err)}) — ignored`);
  }
}

/** Apply a parsed config file. Missing fields keep their current values. */
function applyLocalConfig(config: AppConfig, file: LocalConfigFile): void {
  const mode = file.mode ?? "credentials";
  if (file.clientId) config.clientId = file.clientId.trim();
  if (file.clientSecret) config.clientSecret = file.clientSecret.trim();
  if (file.redirectUri) config.redirectUri = file.redirectUri.trim();
  if (file.tokenProxyUrl) config.tokenProxyUrl = file.tokenProxyUrl.trim();
  if (mode === "credentials") {
    config.localMode = "credentials";
  } else {
    config.localMode = "proxy";
  }
  config.save();
}
