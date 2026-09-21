/**
 * Home screen: landing page shown before signing in — hero, feature
 * overview and the redirect to SoundCloud (OAuth 2.1 + PKCE).
 *
 * - Served remotely (Cloudflare static-assets Worker): proxy-only. The token proxy (worker/)
 *   serves the Client ID and holds the Client Secret server-side.
 * - Served from a loopback origin (local development): the Client ID and
 *   Client Secret can be entered directly (the secret is only ever sent to
 *   SoundCloud's own token endpoint).
 */

import { useState } from "react";
import { buildAuthUrl, fetchClientIdFromProxy, isLocalOrigin } from "../services/oauth";
import { runtime } from "../services/store";
import { showStatus } from "../services/store";

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

  // Local (loopback) or credentials entered directly → no proxy; the
  // secret goes inline to SoundCloud's own token endpoint.
  const viaProxy = Boolean(runtime.config.resolveTokenProxyUrl());
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
  const isLoopback = /^http:\/\/(localhost|127(?:\.\d+){1,3}|\[::1\])(:\d+)?\/$/i.test(redirectUri);
  if (redirectUri.startsWith("http://") && !isLoopback) {
    showStatus(`Redirect URI must use https (loopback http is allowed): ${redirectUri}`, "error");
    return;
  }

  onRedirecting();
  // Keep PKCE state in sessionStorage, then send the user to SoundCloud.
  const authUrl = await buildAuthUrl(runtime.config);
  window.location.href = authUrl;
}

/** One card of the feature grid: emoji, title, description. */
function Feature({ icon, title, children }: { icon: string; title: string; children: string }) {
  return (
    <div className="feature-card">
      <div className="feature-icon" aria-hidden="true">{icon}</div>
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}

export function HomeScreen() {
  const local = isLocalOrigin();
  const [clientId, setClientId] = useState(runtime.config.clientId);
  const [clientSecret, setClientSecret] = useState(runtime.config.clientSecret);
  const [redirectUri, setRedirectUri] = useState(runtime.config.redirectUri);
  const [redirecting, setRedirecting] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Hint under the redirect field: explains what must be registered where.
  const resolved = redirectUri.trim() || runtime.config.resolveRedirectUri();
  const hint = redirectUri.trim()
    ? "This exact URI (including trailing slash) must be registered as a redirect URI."
    : resolved
      ? `Registered redirect: ${resolved} — or enter another address above.`
      : "Serve this folder over http(s) (e.g. `python3 -m http.server 8080`) to enable the OAuth redirect.";

  return (
    <section id="home-screen" className="home">
      <div className="hero">
        <div className="hero-badge" aria-hidden="true">
          <span className="hero-badge-dot" /> Nothing to install · Runs in your browser
        </div>
        <h2>
          Manage your SoundCloud<br />
          <span className="hero-title-accent">playlists</span> like a pro
        </h2>
        <p className="hero-tagline">
          Browse, preview and reorganize your playlists — fast, safe and
          all in your browser.
        </p>
        {local && (
          <p className="muted">
            Local development mode (loopback origin): token requests go
            straight to SoundCloud with your own credentials by default —
            enter them below, or drop a <code>public/config.local.json</code>{" "}
            (see <code>config.local.json.example</code>) to configure this
            automatically, including a proxy mode. The Client Secret is only
            ever sent to SoundCloud's own token endpoint.
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
          <button
            className="button button-primary button-block"
            type="submit"
            disabled={redirecting}
          >
            {redirecting ? "Redirecting to SoundCloud…" : "Connect with SoundCloud"}
          </button>
          <p className="advanced-toggle">
            <span className="tooltip-anchor">
              <button
                type="button"
                className="link-quiet"
                onClick={() => setShowAdvanced((visible) => !visible)}
              >
                Advanced options
              </button>
              <span className="tooltip" role="tooltip">
                Only needed if you host your own copy: register an app on the{" "}
                <a href="https://developers.soundcloud.com/docs/api/register-app" target="_blank" rel="noreferrer">SoundCloud developer portal</a>
                {" "}(requires an Artist Pro subscription) to get a Client ID,
                and deploy the token proxy in <code>worker/</code> for the Client Secret.
              </span>
            </span>
          </p>
          {showAdvanced && (
          <div className="form-stack advanced-panel">
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
          )}
        </form>
        {!local && (
          <p className="muted">
            You sign in securely on SoundCloud itself — we never see your
            password, and nothing is stored on any server.
          </p>
        )}
      </div>

      <h2 className="features-title">What you can do</h2>
      <div className="features-rule" aria-hidden="true" />
      <div className="features-grid">
        <Feature icon="📚" title="All your playlists in one place">
          Instantly search, sort and flip through every playlist — and share
          any of them with its own direct link.
        </Feature>
        <Feature icon="▶" title="Listen before you decide">
          Play any track right on the page, with a sound wave you can click
          through — no switching tabs needed.
        </Feature>
        <Feature icon="♪" title="Match tracks by key & tempo">
          One click finds the key and BPM of every track in a playlist —
          perfect for planning a smooth DJ set.
        </Feature>
        <Feature icon="↔" title="Rearrange by drag & drop">
          Move or copy tracks between playlists with a simple drag, and spin
          up brand-new playlists in one click.
        </Feature>
        <Feature icon="🔒" title="Private by design">
          Everything happens in your browser. Your sign-in stays between you
          and SoundCloud — nobody else ever sees it.
        </Feature>
      </div>
    </section>
  );
}
