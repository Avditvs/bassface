/**
 * Small shared helpers (base64url, randomness, formatting).
 */

/** Encode bytes as RFC 4648 base64url without padding. */
export function base64UrlEncode(bytes) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

/** Return `length` cryptographically random bytes. */
export function randomBytes(length) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

/** Return a random URL-safe string (used for the OAuth `state` nonce). */
export function randomState() {
  return base64UrlEncode(randomBytes(24));
}

/** Compute a SHA-256 based S256 PKCE code challenge from a code verifier. */
export async function sha256Of(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return new Uint8Array(digest);
}

export function formatDate(iso) {
  const date = new Date(iso);
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function formatCount(count) {
  return new Intl.NumberFormat().format(count ?? 0);
}

/** Format a millisecond duration as `m:ss` (e.g. 245000 → "4:05"). */
export function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round((ms ?? 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

/** Classify a playlist `kind`/`playlist_type` in one of the displayed buckets. */
export function playlistBucket(playlist) {
  return playlist.playlist_type ?? playlist.kind ?? "playlist";
}

export function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = String(text ?? "");
  return div.innerHTML;
}