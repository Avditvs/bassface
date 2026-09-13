/**
 * Connect screen: configuration form, validation and the redirect to
 * SoundCloud (OAuth 2.1 + PKCE).
 */

import { useState } from "react";
import { buildAuthUrl } from "../services/oauth";
import { runtime } from "../services/store";
import { showStatus } from "../services/store";
import { DebugPanel } from "./DebugPanel";

/** Validate the form, persist it, then send the user to SoundCloud. */
async function onConnectSubmit(
  values: { clientId: string; clientSecret: string; redirectUri: string },
  { onRedirecting }: { onRedirecting: () => void },
): Promise<void> {
  runtime.config.clientId = values.clientId.trim();
  runtime.config.clientSecret = values.clientSecret.trim();
  runtime.config.redirectUri = values.redirectUri.trim();
  runtime.config.save();

  if (!runtime.config.clientId) {
    showStatus("A Client ID is required. Register an app on SoundCloud first.", "error");
    return;
  }
  if (!runtime.config.clientSecret) {
    showStatus("Heads up: SoundCloud treats apps as confidential clients — if the next step fails with \"invalid_client\", add your Client Secret and retry.", "info");
  }
  const redirectUri = runtime.config.resolveRedirectUri();
  if (!redirectUri) {
    showStatus("OAuth needs an http(s) redirect URI. Serve the folder over http and reload.", "error");
    return;
  }
  if (!redirectUri.startsWith("http://") && !redirectUri.startsWith("https://")) {
    showStatus(`Invalid redirect URI: ${redirectUri}`, "error");
    return;
  }
  // OAuth redirect URIs must be https, except loopback (RFC 8252 §8.3):
  // sending the authorization code over plaintext HTTP elsewhere would
  // expose it to anyone on the path.
  const isLoopback = /^http:\/\/(localhost|127\.\.?1|\[::1\])(:\d+)?\//i.test(redirectUri);
  if (redirectUri.startsWith("http://") && !isLoopback) {
    showStatus(`Redirect URI must use https (loopback http is allowed): ${redirectUri}`, "error");
    return;
  }

  onRedirecting();
  // Keep PKCE state in sessionStorage, then send the user to SoundCloud.
  const authUrl = await buildAuthUrl(runtime.config);
  window.location.href = authUrl;
}

export function ConnectScreen() {
  const [clientId, setClientId] = useState(runtime.config.clientId);
  const [clientSecret, setClientSecret] = useState(runtime.config.clientSecret);
  const [redirectUri, setRedirectUri] = useState(runtime.config.redirectUri);
  const [redirecting, setRedirecting] = useState(false);

  // Hint under the redirect field: explains what must be registered where.
  const resolved = redirectUri.trim() || runtime.config.resolveRedirectUri();
  const hint = redirectUri.trim()
    ? "This exact URI (including trailing slash) must be registered as a redirect URI."
    : resolved
      ? `Registered redirect: ${resolved} — or enter another address above.`
      : "Serve this folder over http(s) (e.g. `python3 -m http.server 8080`) to enable the OAuth redirect.";

  return (
    <section id="connect-screen" className="panel">
      <h2>Connect to SoundCloud</h2>
      <p className="muted">
        This app runs entirely in your browser. Register an application on{" "}
        <a href="https://developers.soundcloud.com/docs/api/register-app" target="_blank" rel="noreferrer">SoundCloud</a>
        {" "}(Artist Pro required), then paste your credentials below.
      </p>

      <form
        className="form-stack"
        onSubmit={(event) => {
          event.preventDefault();
          void onConnectSubmit(
            { clientId, clientSecret, redirectUri },
            { onRedirecting: () => setRedirecting(true) },
          );
        }}
      >
        <label>
          <span>Client ID</span>
          <input
            type="text"
            autoComplete="off"
            placeholder="e.g. AbC123xYz…"
            required
            value={clientId}
            onChange={(event) => setClientId(event.target.value)}
          />
        </label>
        <label>
          <span>Client secret</span>
          <input
            type="password"
            autoComplete="off"
            placeholder="Required for the token exchange (confidential client)"
            value={clientSecret}
            onChange={(event) => setClientSecret(event.target.value)}
          />
        </label>
        <label>
          <span>Redirect URI</span>
          <input
            type="text"
            autoComplete="off"
            placeholder="Default: the address this page is served from"
            value={redirectUri}
            onChange={(event) => setRedirectUri(event.target.value)}
          />
        </label>
        <p className="muted" id="redirect-hint">{hint}</p>
        <button
          className="button button-primary button-block"
          type="submit"
          disabled={redirecting}
        >
          {redirecting ? "Redirecting to SoundCloud…" : "Connect with SoundCloud"}
        </button>
      </form>

      <details className="debug">
        <summary>Troubleshooting log</summary>
        <DebugPanel />
      </details>
    </section>
  );
}
