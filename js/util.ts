/**
 * Small shared helpers (base64url, randomness, formatting, DOM lookups).
 */

import type { Playlist } from "./types.js";

/** Look up a static element by id; throws when the HTML is broken. */
export function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id} element`);
  return node as T;
}

/** The event target as an Element (null for non-Element targets). */
export function targetOf(event: Event): Element | null {
  return event.target instanceof Element ? event.target : null;
}

/** Encode bytes as RFC 4648 base64url without padding. */
export function base64UrlEncode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

/** Return `length` cryptographically random bytes. */
export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

/** Return a random URL-safe string (used for the OAuth `state` nonce). */
export function randomState(): string {
  return base64UrlEncode(randomBytes(24));
}

/** Compute a SHA-256 based S256 PKCE code challenge from a code verifier. */
export async function sha256Of(text: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return new Uint8Array(digest);
}

export function formatDate(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function formatCount(count?: number | null): string {
  return new Intl.NumberFormat().format(count ?? 0);
}

/** Format a millisecond duration as `m:ss` (e.g. 245000 → "4:05"). */
export function formatDuration(ms?: number | null): string {
  const totalSeconds = Math.max(0, Math.round((ms ?? 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

/** Classify a playlist `kind`/`playlist_type` in one of the displayed buckets. */
export function playlistBucket(playlist: Playlist): string {
  return playlist.playlist_type ?? playlist.kind ?? "playlist";
}

/**
 * Escape a value for safe interpolation anywhere in an HTML template,
 * *including attribute contexts*: `& < > " '` are all escaped, so a value
 * like `x" onerror="…` cannot break out of a quoted attribute.
 */
export function escapeHtml(text: unknown): string {
  return String(text ?? "").replace(/[&<>"'`]/g, (char) => (
    char === "&" ? "&amp;"
    : char === "<" ? "&lt;"
    : char === ">" ? "&gt;"
    : char === '"' ? "&quot;"
    : char === "'" ? "&#39;"
    : "&#96;"
  ));
}

/** Escape a value for safe use inside a URL-typed attribute (`href`/`src`).
 *  Additionally blocks `javascript:` / `data:` (except safe media types)
 *  schemes so API-provided URLs cannot carry script URIs. */
export function escapeUrl(url: unknown): string {
  const value = String(url ?? "").trim();
  const scheme = value.match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase() ?? "";
  const blocked = scheme !== "" && scheme !== "http" && scheme !== "https"
    && !(scheme === "data" && /^data:image\/(png|jpe?g|gif|webp);/i.test(value));
  return blocked ? "" : escapeHtml(value);
}

/**
 * Redact credential-bearing query parameters (oauth_token, access_token,
 * client_secret, …) from a string before it is logged. SoundCloud stream
 * URLs embed `?oauth_token=…`, which must never reach the persistent debug
 * log or the console.
 */
export function redactSecrets(text: unknown): string {
  return String(text ?? "")
    // any credentialed query parameter → keep the name, drop the value
    .replace(/([?&](?:oauth_)?(?:access_)?token|client_secret)=([^&\s"']+)/gi, "$1=REDACTED")
    // bearer tokens pasted verbatim
    .replace(/\bOAuth [A-Za-z0-9._-]{8,}/g, "OAuth REDACTED")
    // signed path segments used by sndcdn stream URLs (hmac + expiry)
    .replace(/\/(?:[A-Za-z0-9_-]*hmac[A-Za-z0-9_-]*|\d{10,})\//g, "/REDACTED/");
}
