/**
 * Connect screen: configuration form, validation and the redirect to
 * SoundCloud (OAuth 2.1 + PKCE).
 *
 * - Served remotely (GitHub Pages): proxy-only. The token proxy (worker/)
 *   serves the Client ID and holds the Client Secret server-side.
 * - Served from a loopback origin (local development): the Client ID and
 *   Client Secret can be entered directly (the secret is only ever sent to
 *   SoundCloud's own token endpoint).
 */

import { useState } from "react";
import { buildAuthUrl, fetchClientIdFromProxy, isLocalOrigin } from "../services/oauth";
import { runtime } from "../services/store";
import { showStatus } from "../services/store";
import { DebugPanel } from "./DebugPanel";

type ConnectValues = { clientId: string; clientSecret: string; redirectUri: string };

/** Validate the form, persist it, then send the user to SoundCloud. */
async function onConnectSubmit(
  values: ConnectValues,
  { onRedirecting, onClientId }: { onRedirecting: () => void; onClientId: (clientId: string) => void },
): Promise<void> {
  runtime.config.clientId = values.clientId.trim();
  runtime.config.clientSecret = values.clientSecret.trim();
  runtime.config.redirectUri = values.redirectUri.trim();
  runtime.config.save();

  const viaProxy = Boolean(runtime.config.tokenProxyUrl);
  if (viaProxy && !runtime.config.tokenProxyUrl.startsWith("https://")) {
    showStatus("The token proxy URL must use https (worker URLs are https by default).", "error");
    return;
  }

  if (viaProxy && !runtime.config.clientId) {
    // The Client ID may also live on the proxy: ask the worker for it.
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

  if (!viaProxy && !runtime.config.clientId) {
    showStatus("A Client ID is required. Register an app on SoundCloud first.", "error");
    return;
  }
  if (!viaProxy && !runtime.config.clientSecret && !isLocalOrigin()) {
    showStatus("SoundCloud treats apps as confidential clients — without a proxy or a Client Secret the token exchange will fail with \"invalid_client\".", "error");
    return;
  }
  if (!viaProxy && !runtime.config.clientSecret && isLocalOrigin()) {
    showStatus("Heads up: SoundCloud treats apps as confidential clients — if the next step fails with \"invalid_client\", add your Client Secret.", "info");
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
  const local = isLocalOrigin();
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
      {local ? (
        <p className="muted">
          Local development mode (loopback origin): open the dropdown below to
          enter your app's credentials directly — the Client Secret is only
          ever sent to SoundCloud's own token endpoint. When served remotely
          (GitHub Pages), this screen connects through the token proxy with
          nothing to configure.
        </p>
      ) : (
        <p className="muted">
          This app connects to SoundCloud through a token proxy — a tiny
          Cloudflare Worker in <code>worker/</code> that holds the Client
          Secret server-side and serves the (public) Client ID. It is
          already configured; just click the button below.
        </p>
      )}

      <form
        className="form-stack"
        onSubmit={(event) => {
          event.preventDefault();
          void onConnectSubmit(
            { clientId, clientSecret, redirectUri },
            {
              onRedirecting: () => setRedirecting(true),
              onClientId: (id) => setClientId(id),
            },
          );
        }}
      >
        <details className="debug">
          <summary>
            {local ? "Advanced options — Client ID / Secret / Redirect URI" : "Advanced options (Client ID / Redirect URI)"}
          </summary>
          <div className="form-stack">
            {local ? (
              <>
                <label>
                  <span>Client ID</span>
                  <input
                    type="text"
                    autoComplete="off"
                    placeholder="e.g. AbC123xYz…"
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
              </>
            ) : (
              <label>
                <span>Client ID</span>
                <input
                  type="text"
                  autoComplete="off"
                  placeholder="Fetched from the token proxy when left empty"
                  value={clientId}
                  onChange={(event) => setClientId(event.target.value)}
                />
              </label>
            )}
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
          </div>
        </details>
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
