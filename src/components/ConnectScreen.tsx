/**
 * Connect screen: configuration form, validation and the redirect to
 * SoundCloud (OAuth 2.1 + PKCE).
 */

import { useState } from "react";
import { buildAuthUrl, fetchClientIdFromProxy } from "../services/oauth";
import { runtime } from "../services/store";
import { showStatus } from "../services/store";
import { DebugPanel } from "./DebugPanel";

/** Validate the form, persist it, then send the user to SoundCloud. */
async function onConnectSubmit(
  values: { clientId: string; clientSecret: string; redirectUri: string; tokenProxyUrl: string },
  { onRedirecting, onClientId }: { onRedirecting: () => void; onClientId: (clientId: string) => void },
): Promise<void> {
  runtime.config.clientId = values.clientId.trim();
  runtime.config.clientSecret = values.clientSecret.trim();
  runtime.config.redirectUri = values.redirectUri.trim();
  runtime.config.tokenProxyUrl = values.tokenProxyUrl.trim();
  runtime.config.save();

  const viaProxy = Boolean(runtime.config.tokenProxyUrl);
  if (viaProxy && !runtime.config.tokenProxyUrl.startsWith("https://")) {
    showStatus("The token proxy URL must use https (worker URLs are https by default).", "error");
    return;
  }

  // The Client ID may also live on the proxy: when the field is left empty
  // and a proxy is configured, ask the worker for it (GET <worker>).
  if (!runtime.config.clientId) {
    if (!viaProxy) {
      showStatus("A Client ID is required. Register an app on SoundCloud first.", "error");
      return;
    }
    showStatus("Fetching the Client ID from your token proxy…");
    const clientId = await fetchClientIdFromProxy(runtime.config.tokenProxyUrl);
    if (!clientId) {
      showStatus("No Client ID entered, and the proxy returned none — set SOUNDCLOUD_CLIENT_ID on the worker, or paste your Client ID here.", "error");
      return;
    }
    runtime.config.clientId = clientId;
    runtime.config.save();
    onClientId(clientId);
  }

  if (!viaProxy && !runtime.config.clientSecret) {
    showStatus("Heads up: SoundCloud treats apps as confidential clients — if the next step fails with \"invalid_client\", add your Client Secret (or deploy the token proxy in worker/) and retry.", "info");
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
  const [tokenProxyUrl, setTokenProxyUrl] = useState(runtime.config.tokenProxyUrl);
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
        To keep the Client Secret out of the browser entirely, deploy the
        tiny token proxy in <code>worker/</code> and fill in its URL below
        instead of the secret.
      </p>

      <form
        className="form-stack"
        onSubmit={(event) => {
          event.preventDefault();
          void onConnectSubmit(
            { clientId, clientSecret, redirectUri, tokenProxyUrl },
            {
              onRedirecting: () => setRedirecting(true),
              onClientId: (id) => setClientId(id),
            },
          );
        }}
      >
        <label>
          <span>Client ID</span>
          <input
            type="text"
            autoComplete="off"
            placeholder={tokenProxyUrl.trim() ? "e.g. AbC123xYz… — or leave empty to fetch it from the proxy" : "e.g. AbC123xYz…"}
            value={clientId}
            onChange={(event) => setClientId(event.target.value)}
          />
        </label>
        <label>
          <span>Client secret</span>
          <input
            type="password"
            autoComplete="off"
            placeholder={tokenProxyUrl.trim() ? "Not needed — your proxy injects it server-side" : "Required for the token exchange (or use the token proxy below)"}
            value={clientSecret}
            onChange={(event) => setClientSecret(event.target.value)}
          />
        </label>
        <label>
          <span>Token proxy URL (optional)</span>
          <input
            type="url"
            autoComplete="off"
            placeholder="e.g. https://soundcloud-token-proxy.your-account.workers.dev — see worker/"
            value={tokenProxyUrl}
            onChange={(event) => setTokenProxyUrl(event.target.value)}
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
