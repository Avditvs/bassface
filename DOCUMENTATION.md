# Bassface — Technical Documentation

Full technical reference for the Bassface frontend: a backend-free
web app (TypeScript + React + Vite) that connects to the SoundCloud API
entirely from the browser, lists your playlists, plays full-length previews
and estimates the **musical key** and **BPM** of each track in-browser.

For a quick start (registering the SoundCloud app, running the dev server),
see the [README](README.md). This document describes **how the code works**.

## Table of contents

1. [Architecture](#architecture)
2. [State management](#state-management)
3. [OAuth 2.1 flow](#oauth-21-flow)
4. [API client](#api-client)
5. [Audio playback pipeline](#audio-playback-pipeline)
6. [In-browser audio analysis](#in-browser-audio-analysis)
7. [Playlist reorganization](#playlist-reorganization)
8. [Routing and screens](#routing-and-screens)
9. [Persistence and storage keys](#persistence-and-storage-keys)
10. [Security model](#security-model)
11. [Testing](#testing)
12. [Module map](#module-map)

---

## Architecture

```
components/          React rendering, fed by an immutable state snapshot
   │  useApp() ──────────────┐
   │                         │
services/            framework-agnostic TypeScript (no React imports
   │                  except the store hook, no DOM beyond canvas/audio)
   │  store.ts  ←─ central snapshot + runtime (mutable, non-rendering)
   │  api.ts    ←─ SoundCloud REST client (auth, pagination, HLS)
   │  oauth.ts  ←─ token lifecycle
   │  audio-engine.ts / preview.ts ←─ playback
   │  chroma.ts / bpm.ts / analysis-source.ts ←─ analysis
   │  organize.ts ←─ drag & drop between playlists
   └─ router.ts, tracks.ts, waveform.ts, debug.ts, config.ts, util.ts
```

Two hard rules keep the codebase testable:

- **`services/` never imports React** (except `useSyncExternalStore` inside
  `store.ts`) and never touches the DOM beyond `<audio>` and `<canvas>`.
- **Components never call the API directly** — they dispatch through
  services and re-render from the store snapshot.

The analyzers (`chroma.ts`, `bpm.ts`) and their shared loader
(`analysis-source.ts`) can therefore be bundled and exercised in Node with
small shims (see [Testing](#testing)).

## State management

`store.ts` holds two distinct kinds of state:

- **`AppState`** — an immutable UI snapshot (route, status, playlists,
  pager, analysis results, preview state…). Components read it through
  `useApp()` (React's `useSyncExternalStore` over a subscribe/getSnapshot
  pair), so every UI change is one `setState(partial)` away from a
  consistent re-render.
- **`runtime`** — a plain mutable object for non-rendering resources:
  the `SoundCloudApi` instance, persisted config/tokens, waveform caches,
  the shared `<audio>` element (via `preview-runtime.ts`). Mutating it
  never triggers a render.

Status messages (spinner / info / success / error) flow through
`showStatus()` into the snapshot and render in `StatusBar.tsx`; the
troubleshooting log (see [Debug log](#debug-log)) records a superset.

## OAuth 2.1 flow

Implemented in `oauth.ts` (+ callback handling in `session.ts`), fully
client-side:

1. **Authorize URL** — `https://secure.soundcloud.com/authorize` with
   `response_type=code`, a PKCE code verifier (32 random bytes,
   base64url, stored in `sessionStorage` only) hashed with S256 as the
   challenge, and a single-use `state` nonce.
2. **Callback** — the redirect lands back on the app with `?code&state`;
   `state` is compared (and consumed) before anything else happens.
3. **Token exchange** — `POST` to the configured **token proxy** (a
   ~80-line Cloudflare Worker, see `worker/`), which injects the Client
   Secret from its environment and forwards to
   `https://secure.soundcloud.com/oauth/token`. SoundCloud treats registered
   apps as confidential clients, so the secret must be present — but on the
   deployed site it lives only on the worker: it never ships in the bundle
   or reaches the browser. Loopback origins (local development) may send
   the secret inline instead. `tokenEndpoint()` in `oauth.ts` picks the
   URL and enforces this.
4. **Refresh** — access tokens expire after ~1 hour; the single-use
   refresh token is exchanged automatically (`grant_type=refresh_token`),
   including transparently on a 401 mid-session (see
   [API client](#api-client)).

PKCE verifier and state live in `sessionStorage` (die with the tab); tokens
live in `localStorage` (`playlist_updater.tokens`) so sign-in survives
reloads. Redirect URIs must be https (loopback http allowed, RFC 8252 §8.3).

## API client

`api.ts` (`SoundCloudApi`) wraps every REST call:

- **Auth** — `request()` attaches the bearer token and, on a 401, performs
  one token refresh then replays the request once.
- **Rate limits** — HTTP 429 (or the legacy 403 body SoundCloud sometimes
  sends) is detected and surfaced as a "rate limited" status with retry
  guidance.
- **Pagination** — playlists and tracks are paged with the `linked_partitioning`
  scheme; `GET /playlists/{id}?show_tracks=true` pages tracks for the
  detail view (infinite scroll through `TrackPager`).
- **Token confinement** — `isTokenSafeUrl()` refuses to attach the bearer
  token to any host other than `*.soundcloud.com` / `*.sndcdn.com`.

Read-modify-write helpers back the reorganize feature (see
[Playlist reorganization](#playlist-reorganization)).

### Full-length audio source resolution

`previewSource(track)` resolves **the best playable source** with this
priority:

1. **`/tracks/:id/streams`** — all `hls_*` / `http_*` `_url` fields are
   scanned generically (SoundCloud adds transcode tiers without notice),
   filtered to mp3/AAC, ordered *mp3 HLS → mp3 direct → AAC HLS → AAC
   direct*. HLS playlists are downloaded segment by segment (auth required
   per segment) and concatenated into one Blob, capped at ~120 segments
   (longer playlists are truncated from the middle; `complete` reports
   whether position 0 is really the start). Direct files are one request,
   whole track.
2. **The track's own HLS transcodings** (`media.transcodings` with
   `protocol: "hls"` — the URLs the SoundCloud web player itself resolves),
   mp3 before AAC, each transcoding URL resolving to an actual m3u8.
   Needed for tracks whose `/streams` exposes nothing.
3. **`preview_mp3_128_url`** — the ~30 s snippet, last resort for tracks
   with no full-length source (`complete: false`).
4. **Legacy `stream_url` / first progressive transcoding** — no Blob, played
   directly (may fail when it still requires auth), `kind: "legacy"`.

## Audio playback pipeline

`preview.ts` (controller) + `preview-runtime.ts` (shared `<audio>`) +
`audio-engine.ts` (source loading) implement previews over a single hidden
audio element:

- **▶ (from the start)** — resolves `previewSource()`; a Blob plays via an
  object URL, a legacy URL plays directly.
- **Waveform click** — jumps into the track at the clicked position,
  streaming from that segment:
  - **MediaSource path** (preferred when the codec is supported): the first
    2 segments are appended to a `SourceBuffer`, playback starts
    immediately, and `extendJumpWindow()` keeps appending ahead of the
    playhead (windows capped at ~60 segments) — gapless streaming.
  - **Blob path** (Safari/older browsers): the window's segments are
    concatenated into a Blob; on extension the object URL is hot-swapped
    under a paused, resumed playhead.

The codec MIME (`audio/mpeg` for mp3 transcodes, `audio/aac` for ADTS AAC)
flows from the source resolution into MediaSource, Blob types and the
extension bookkeeping (`JumpState.mime`).

## In-browser audio analysis

Two analyzers estimate the **key** and **BPM** of a track fully in the
browser — no audio leaves the machine. They share one loader
(`analysis-source.ts`) and its caches, so running BPM after keys (or
re-analyzing) costs no network and no decode:

- **Source windows** — `loadHlsStream()` returns the track's best HLS
  playlist (`hlsStream()` in `api.ts`: mp3 preferred over AAC, `/streams`
  first, track transcodings as fallback); `segmentMono()` fetches/decodes
  segments at the shared 44.1 kHz analysis rate, caching blobs and decodes
  by segment URL.
- **Whole-track fallback** — tracks with no HLS playlist are analyzed from
  **4 × 25 s windows** sliced from the whole-track source playback would
  use (the direct mp3 Blob, or the legacy stream downloaded for the
  purpose), centred at `(i+1)/5` of the timeline so quiet lead-in/outro
  stay clear. Short sources (e.g. the ~30 s snippet) are split into equal
  ≥5 s windows covering them entirely. Decoded tracks (a few tens of MB)
  are cached for the last 2 tracks and shared between both analyzers —
  every track that can play can be analyzed.

### Key estimation (`chroma.ts`)

1. Four source windows spread across the track → ~4 s chunks →
   overlapping **8192-sample Hann windows** (≈5.4 Hz resolution at
   44.1 kHz — enough to separate neighbouring semitones down to ~C2).
2. FFT magnitude bins (≈C2–A6 range) are folded onto the **12 pitch
   classes** → per-chunk chroma vectors; silent chunks are dropped.
3. Chunk vectors are averaged (equal weight per window), normalized, and
   correlated against the **Krumhansl–Kessler major/minor profiles**; the
   best match names the key (confidence = the correlation).

Results persist in `playlist_updater.chromas` — a key is computed once per
track, ever. The toolbar's **Analyze all keys** batches the track list
(3 in parallel, click again to stop).

### BPM estimation (`bpm.ts`)

1. Segments are picked at the **loudest moments** of the waveform bars
   (even spread as fallback) — `pickIntenseSegments()` (unit-tested).
2. Each segment is decimated 2× to 22.05 kHz, framed with 1024-sample
   Hann FFTs (hop 512 → ~43 fps, librosa's default frame rate), and reduced
   to a **spectral-flux onset envelope**; silent frames are muted.
3. Each envelope is **autocorrelated** over 60–200 BPM lags; per-lag the
   segments' autocorrelations are weighted-averaged (a segment where the
   beat drops out contributes nothing instead of injecting a fake period —
   segments are never concatenated, which would fake periodicity at the
   seams).
4. The winning lag is refined by parabolic interpolation and folded into
   the DJ-friendly **85–180 BPM** window by octaves.

Results persist in `playlist_updater.bpms`.

## Playlist reorganization

`organize.ts` backs the **Reorganize** sidebar (`OrganizeSidebar.tsx`):

- **Copy** — drop a track row on a playlist card: `GET` that playlist's
  track list, append the track, `PUT /playlists/:id` (SoundCloud replaces
  the whole list, hence read-modify-write).
- **Move** — drop on the far-right ⇥ strip: same, plus removal from the
  currently open playlist (a second read-modify-write).
- **Create** — `+ New` posts `POST /playlists` and selects it.
- **Undo** — an undo stack records each operation's inverse; the toolbar
  button reverts the last one.
- The drop-target filter (which playlists show as cards) is persisted in
  `pu.organize.selected`.

SoundCloud-side conflicts are tolerated: a failed `PUT` is pushed onto the
undo stack so the user can retry.

## Routing and screens

`router.ts` — hash routing (works from any static host):

| Route | Screen |
|-------|--------|
| `#/playlists` | `PlaylistsScreen` — search / type filter / sorting, card grid, pagination |
| `#/playlist/<id>` | `PlaylistScreen` — header, track list, reorganize sidebar |
| `#/liked` | liked-tracks view (virtual playlist, same detail screen) |

`App.tsx` runs the boot sequence (config check → OAuth callback handling →
token/session restore → playlist load) and switches screens. Deep links to
a playlist survive sign-in: the callback stores the route and restores it.

## Persistence and storage keys

| Key | Store | Contents |
|-----|-------|----------|
| `playlist_updater.config` | localStorage | Client ID / secret (local dev only) / redirect URI / token proxy URL |
| `playlist_updater.tokens` | localStorage | OAuth access + refresh tokens |
| `playlist_updater.user` | localStorage | Signed-in user profile |
| `playlist_updater.chromas` | localStorage | Per-track key analyses |
| `playlist_updater.bpms` | localStorage | Per-track BPM analyses |
| `pu.organize.selected` | localStorage | Reorganize sidebar drop-target filter |
| `playlist_updater.code_verifier` | sessionStorage | PKCE verifier (tab-scoped) |
| `playlist_updater.state` | sessionStorage | OAuth state nonce (single-use) |

Storage failures are never fatal (`config.ts` warns and continues).

## Security model

- **OAuth 2.1 + PKCE (S256)**, single-use `state` validated on callback;
  verifier/state in `sessionStorage` only.
- **CSP** in `index.html`: `script-src 'self'` plus the Cloudflare Web
  Analytics beacon (`static.cloudflareinsights.com`, included as an explicit
  script tag in `index.html`), SoundCloud-only
  `connect-src`/`img-src` (plus `cloudflareinsights.com` for the analytics
  beacon), `frame-ancestors 'none'` — contains the blast radius of any
  future injection bug.
- **React-escaped interpolation** for all SoundCloud data; URL-typed
  attributes (`href`, `src`) pass through `escapeUrl()` (`util.ts`),
  which rejects `javascript:` / `data:` schemes.
- **Token confinement** — the bearer token is only ever sent to
  `*.soundcloud.com` / `*.sndcdn.com` (`isTokenSafeUrl()`).
- **Log redaction** — `redactSecrets()` (`util.ts`) strips token query
  params, secrets and signed URL fragments before anything reaches the
  debug log.
- **Token proxy** (`worker/`) — a Cloudflare Worker that injects the client
  secret server-side and serves the (public) Client ID via `GET`; the
  deployed app always goes through it, so the secret never appears in the
  bundle or the browser. Only the authorization-code and refresh-token
  grants are accepted, the `client_id` is pinned to the owner's app, and
  CORS is limited to the configured origin(s). A loopback origin
  (local development) may instead connect with credentials entered directly.

### Debug log

`debug.ts` keeps a subscribable ring buffer of troubleshooting entries;
`DebugPanel.tsx` renders it live. Everything is piped through `dbg()`,
which applies `redactSecrets()` — tokens and signed URL fragments never
appear in the log.

## Testing

`tests/bpm-test/` — Node sanity checks that bundle the **real** `services/`
code (shims in `shims.ts` fake `localStorage`, `OfflineAudioContext`, DOM
basics):

| File | Verifies |
|------|----------|
| `entry.ts` | BPM estimates on synthesized click tracks + the intensity-guided segment picker |
| `intro-check.ts` | A quiet-intro / loud-drop track does not fool the picker |
| `fallback-check.ts` | With no HLS playlist, chroma and BPM fall back to whole-track windows instead of failing |
| `rfft-check.ts` | The real-input FFT against a reference complex FFT |
| `entry-helpers.ts` | Shared WAV/click-track synthesis helpers |

Run them with rolldown + node (see the README's Development section).

## Module map

| Module | Role |
|--------|------|
| `main.tsx` | Entry: mounts the React root, imports styles |
| `components/App.tsx` | Boot sequence, hash routing, screen switching |
| `components/Header.tsx` | Brand + user badge (avatar, sign out) |
| `components/StatusBar.tsx` | Message bar (spinner / info / success / error) |
| `components/ConnectScreen.tsx` | Config form, validation, authorize redirect |
| `components/PlaylistsScreen.tsx` | Toolbar (search / type / sort), card grid, pagination |
| `components/PlaylistScreen.tsx` | Detail layout: toolbar, remove zone, audio, sidebar |
| `components/PlaylistHeader.tsx` | Artwork, title, badges, meta |
| `components/TrackList.tsx` | Track rows + infinite-scroll sentinel |
| `components/TrackRow.tsx` | One sound row (artwork, waveform, preview buttons) |
| `components/WaveformCanvas.tsx` | Per-track loudness waveform canvas |
| `components/OrganizeSidebar.tsx` | Reorganize sidebar (drop targets, choose mode) |
| `components/DebugPanel.tsx` | Live view of the troubleshooting log |
| `components/shared.tsx` | Artwork / badges / meta presentational helpers |
| `services/store.ts` | State snapshot + `useApp()` + `runtime` |
| `services/config.ts` | localStorage persistence (config, tokens, user, analyses) |
| `services/oauth.ts` | OAuth 2.1 + PKCE: authorize URL, exchange, refresh |
| `services/session.ts` | OAuth callback, refresh, sign-in/out lifecycle |
| `services/api.ts` | SoundCloud REST client: auth, refresh, pagination, source resolution, HLS |
| `services/router.ts` | Hash routing |
| `services/tracks.ts` | Open playlist, track pagination, liked view |
| `services/preview.ts` | Preview playback controller |
| `services/preview-runtime.ts` | Shared `<audio>` element + non-reactive preview fields |
| `services/audio-engine.ts` | Jump-source loading, HLS reassembly, MediaSource streaming |
| `services/analysis-source.ts` | Shared analyzer loader: HLS segments / whole-track windows |
| `services/chroma.ts` | Key estimation (chroma + Krumhansl–Kessler) |
| `services/bpm.ts` | Tempo estimation (spectral flux + autocorrelation) |
| `services/audio.ts` | FFT, Hann window, mono mixdown, decode/slice/cache primitives |
| `services/waveform.ts` | Waveform fetch/cache/draw for the track rows |
| `services/organize.ts` | Drag & drop between playlists, create, undo |
| `services/debug.ts` | Subscribable redacted troubleshooting log |
| `services/util.ts` | base64url / PKCE / formatting helpers |
| `services/types.ts` | Shared domain types (SoundCloud API shapes, contracts) |
