/**
 * App shell: boot sequence, hash routing, screen switching, header and
 * status bar. Screen selection follows the sign-in state and the parsed
 * route (see router.ts).
 */

import { useEffect } from "react";
import { route } from "../services/router";
import { dbg } from "../services/debug";
import { handleOAuthCallback, enterApp } from "../services/session";
import { runtime, showStatus, tokenSummary, useApp } from "../services/store";
import { SoundCloudApi } from "../services/api";
import { Header } from "./Header";
import { StatusBar } from "./StatusBar";
import { ConnectScreen } from "./ConnectScreen";
import { PlaylistsScreen } from "./PlaylistsScreen";
import { PlaylistScreen } from "./PlaylistScreen";

/** Wire diagnostics, handle an OAuth callback, or restore the session. */
let booted = false;
function boot(): void {
  if (booted) return; // StrictMode double-mount in dev must not double-boot
  booted = true;
  // Mirrors every API request into the on-page troubleshooting log (visible
  // on the connect screen) — status codes, URLs and failure bodies.
  SoundCloudApi.logger = (message) => dbg(message);

  // Surface unexpected runtime errors in the on-page log as well.
  window.addEventListener("error", (event) => dbg(`[page error] ${event.message}`));
  window.addEventListener("unhandledrejection", (event) => dbg(`[page rejection] ${event.reason instanceof Error ? event.reason.message : String(event.reason)}`));

  const query = new URLSearchParams(window.location.search);
  const callback = {
    code: query.get("code"),
    state: query.get("state"),
    error: query.get("error"),
  };

  if (callback.code || callback.error) {
    dbg(`[init] callback present — code=${Boolean(callback.code)} error=${callback.error ?? ""} ${tokenSummary()}`);
    void handleOAuthCallback(callback);
    return;
  }

  dbg(`[init] no callback — ${tokenSummary()} configComplete=${runtime.config.isComplete()}`);
  if (runtime.config.isComplete() && runtime.tokens.hasAccessToken()) {
    if (runtime.tokens.isFresh() || runtime.tokens.canRefresh()) {
      void enterApp();
    } else {
      showStatus("Your stored session expired and cannot be restored — please connect again.", "error");
    }
  } else if (runtime.config.isComplete()) {
    showStatus("Not connected yet — click “Connect with SoundCloud” to sign in.", "info");
  }
}

export function App() {
  const state = useApp();

  // Hash routing: parse on change (and once at boot) into the store.
  useEffect(() => {
    route();
    const onHashChange = () => route();
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  // Boot once: diagnostics, OAuth callback or session restore.
  useEffect(() => {
    boot();
  }, []);

  const screen = !state.api
    ? "connect"
    : state.route.name === "playlist" && state.currentPlaylist
      ? "playlist"
      : "playlists";

  return (
    <>
      <Header />
      <main>
        <StatusBar />
        {screen === "connect" && <ConnectScreen />}
        {screen === "playlists" && <PlaylistsScreen />}
        {screen === "playlist" && <PlaylistScreen />}
      </main>
      <footer className="app-footer">
        <p className="muted">
          Unofficial client for the{" "}
          <a href="https://developers.soundcloud.com/docs/api/guide" target="_blank" rel="noreferrer">SoundCloud API</a>
          {" "}— no backend, tokens never leave your browser.
        </p>
      </footer>
    </>
  );
}
