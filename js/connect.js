/**
 * Connect screen: config form, validation and the redirect to SoundCloud.
 */

import { buildAuthUrl } from "./oauth.js";
import { state } from "./state.js";
import { showStatus } from "./screens.js";

/** Hint under the redirect field: explains what must be registered where. */
export function renderRedirectHint() {
  const hint = document.getElementById("redirect-hint");
  const resolved = state.config.redirectUri || state.config.resolveRedirectUri();
  if (state.config.redirectUri) {
    hint.textContent = "This exact URI (including trailing slash) must be registered as a redirect URI.";
  } else {
    hint.textContent = resolved
      ? `Registered redirect: ${resolved} — or enter another address above.`
      : "Serve this folder over http(s) (e.g. `python3 -m http.server 8080`) to enable the OAuth redirect.";
  }
}

/** Fill the config form from the stored (or default) settings. */
export function fillConfigForm() {
  document.getElementById("client-id").value = state.config.clientId;
  document.getElementById("client-secret").value = state.config.clientSecret;
  document.getElementById("redirect-uri").value = state.config.redirectUri;
  renderRedirectHint();
}

/** Validate the form, persist it, then send the user to SoundCloud. */
export async function onConnectSubmit(event) {
  event.preventDefault();

  state.config.clientId = document.getElementById("client-id").value.trim();
  state.config.clientSecret = document.getElementById("client-secret").value.trim();
  state.config.redirectUri = document.getElementById("redirect-uri").value.trim();
  state.config.save();

  if (!state.config.clientId) {
    showStatus("A Client ID is required. Register an app on SoundCloud first.", "error");
    return;
  }
  if (!state.config.clientSecret) {
    showStatus("Heads up: SoundCloud treats apps as confidential clients — if the next step fails with \"invalid_client\", add your Client Secret and retry.", "info");
  }
  const redirectUri = state.config.resolveRedirectUri();
  if (!redirectUri) {
    showStatus("OAuth needs an http(s) redirect URI. Serve the folder over http and reload.", "error");
    return;
  }
  if (!redirectUri.startsWith("http://") && !redirectUri.startsWith("https://")) {
    showStatus(`Invalid redirect URI: ${redirectUri}`, "error");
    return;
  }

  const button = document.getElementById("connect");
  button.disabled = true;
  button.textContent = "Redirecting to SoundCloud…";

  // Keep PKCE state in sessionStorage, then send the user to SoundCloud.
  const authUrl = await buildAuthUrl(state.config);
  window.location.href = authUrl;
}
