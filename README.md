# Bassface (frontend)

A small, backend-free web app that connects to **SoundCloud** through the
[official API](https://developers.soundcloud.com/docs/api/guide), lists your
playlists and lets you open one to browse the sounds inside it. OAuth 2.1
(authorization code + PKCE) runs entirely in the browser —
there is no server to deploy.

> See [DOCUMENTATION.md](DOCUMENTATION.md) for the full technical reference
> (architecture, audio pipeline, analysis algorithms, storage, security).

## How it works

```
browser ──▶ secure.soundcloud.com/authorize   (login + consent, PKCE S256)
browser ◀── redirect ?code&state
browser ──▶ token proxy (Cloudflare Worker)    (code ⇄ tokens, no secret sent)
worker  ──▶ secure.soundcloud.com/oauth/token  (Client Secret added from env)
browser ──▶ api.soundcloud.com/me/playlists   (list playlists, paginated)
browser ──▶ api.soundcloud.com/playlists/:id  (open one, list its tracks)
```

Access tokens expire after ~1 hour; the app refreshes them automatically
with the (single-use) refresh token. The token exchange needs your **Client
Secret** (SoundCloud treats registered apps as confidential clients) — it
is held by the token proxy in [`worker/`](worker/), never in the browser.
See [Token proxy](#token-proxy-keeping-the-client-secret-server-side).

## Requirements

1. A SoundCloud account with an **Artist Pro** subscription (required by
   SoundCloud to create API apps).
2. Register an app at the
   [SoundCloud developer portal](https://developers.soundcloud.com/docs/api/register-app)
   to get a **Client ID** and **Client Secret**.

   For the redirect URI, register the address you will serve the app from,
   for example `http://127.0.0.1:8080/` (trailing slash matters — it must
   match what the app sends).

3. Deploy the **token proxy** (see [worker/](worker/), ~5 minutes on the
   Cloudflare free tier): it serves the (public) Client ID and injects the
   Client Secret server-side. **The Client Secret never goes into the
   app, the browser, or this repo** — only into the worker via
   `npx wrangler secret put SOUNDCLOUD_CLIENT_SECRET`.

## Run it

The app is written in **TypeScript + React** and bundled with **Vite**:

```bash
cd playlist_updater
npm install
npm run build        # vite build → dist/
npm run serve        # build, then serve dist/ on http://127.0.0.1:8080
```

Or serve `dist/` over http(s) with any static server. For a fast edit loop,
use `npm run dev` (Vite dev server with hot reload). Other useful scripts:
`npm run typecheck` (tsc --noEmit, strict).

Then open <http://127.0.0.1:8080/>, paste your **token proxy URL** (the
worker must be deployed first, see the previous section) and click
**Connect with SoundCloud**. After authorizing you
are redirected back and your playlists are listed with search / type filter /
sorting. Click a card (or its **View tracks** button) to open the playlist and
browse the sounds it contains — each row has a **▶** button that plays the
track from the start, a **♪** button that analyzes its BPM and key in the
browser (see Features below), and a **waveform you can click** to jump
into the track at any position. When SoundCloud exposes a full-length source
(an mp3 **or AAC** HLS playlist or direct file — HLS playlists are reassembled
in the browser, and tracks whose `/streams` response has no entries are
resolved through their HLS transcodings), the whole track plays; tracks that
expose nothing else fall back to SoundCloud's ~30 s snippet.

The **Reorganize** button on a playlist opens a sidebar listing your other
playlists: drag a track row onto a card to copy it there, or onto the
far-right **⇥** strip to move it (copied there and removed from the open
playlist). A **+ New** button in the sidebar creates an empty playlist.

## Token proxy (keeping the Client Secret server-side)

Cloudflare (static-assets Worker) only serves static files, so anything entered in the browser —
including a Client Secret — is inherently visible to the page. The
[`worker/`](worker/) directory contains a ~80-line **Cloudflare Worker**
(free tier, no cold starts) that holds the secret in its environment instead:

```
browser ──▶ <worker>.workers.dev        (grant params, no secret)
worker  ──▶ secure.soundcloud.com/oauth/token   (secret added from env)
worker  ◀── tokens
browser ◀── tokens
```

Deploy once (`cd worker && npm install && npx wrangler login`, set the secret
with `npx wrangler secret put SOUNDCLOUD_CLIENT_SECRET`, fill in
`SOUNDCLOUD_CLIENT_ID` + `ALLOWED_ORIGINS` in `wrangler.toml`, then `npm run
deploy` — full steps in [worker/README.md](worker/README.md)). The worker
URL is already built into the app (`CONFIG_DEFAULTS.tokenProxyUrl` in
`src/services/config.ts`), so the connect screen has nothing to configure:
just click **Connect with SoundCloud**. The proxy serves the (public)
Client ID to the app and injects the secret server-side. Code exchange and
token refresh flow through the proxy; the secret never reaches the browser,
the bundle, or the repo. Everything else stays purely static. (Exception:
when served from a loopback origin — `localhost`/`127.0.0.1` — the connect
screen offers a local development mode where credentials can be entered
directly.)

## Security

- **OAuth 2.1 + PKCE (S256)** with a single-use `state` nonce validated on
  callback; the verifier lives in `sessionStorage` only.
- **CSP** (`index.html`): `script-src 'self'`, SoundCloud-only
  `connect-src`/`img-src`, `frame-ancestors 'none'` — contains the blast
  radius of any future injection bug.
- **All SoundCloud-data interpolation goes through React**, which escapes
  text and attribute values by construction; URL-typed attributes (`href`,
  `src`) additionally pass through `escapeUrl` in `util.ts`, which rejects
  `javascript:`/`data:` schemes.
- **The OAuth bearer token is only sent to `*.soundcloud.com` / `*.sndcdn.com`
  hosts** (`isTokenSafeUrl` in `api.ts`) — API/HLS responses pointing
  elsewhere are refused.
- **Log redaction** (`redactSecrets` in `util.ts` applied by `dbg`): token
  query params, secrets and signed URL fragments are stripped before anything
  reaches the troubleshooting log.
- **Redirect URIs must be https** (loopback http allowed, RFC 8252 §8.3);
  `npm run serve` binds `127.0.0.1` only.
- Credentials and tokens are stored in `localStorage` of your own browser —
  they never leave your machine. The **Client Secret is never stored or
  sent by the app**: it lives only in the token proxy's environment.
  Only run this app from a trusted origin, and sign out when done on a
  shared machine.

> **Bassface** stores the token proxy URL and OAuth tokens in
> `localStorage` of your own browser. They never leave your machine. The
> Client Secret is held server-side by the token proxy (see `worker/`) and
> never enters the browser, the bundle, or the repo.
>
> See the **Security** section below for the protections built into the app.

## Project layout

```
index.html              – Vite entry (CSP meta tag + #root)
vite.config.ts          – Vite + React plugin configuration
src/
  main.tsx              – entry point: mounts the React root, imports styles
  types.ts              – shared domain types (SoundCloud API shapes, contracts)
  components/
    App.tsx             – boot sequence, hash routing, screen switching
    Header.tsx          – brand + user badge (avatar, sign out)
    StatusBar.tsx       – message bar (spinner / info / success / error)
    ConnectScreen.tsx   – config form, validation, authorize redirect
    DebugPanel.tsx      – troubleshooting log (live view of the ring buffer)
    PlaylistsScreen.tsx – toolbar (search / type / sort), card grid, pagination
    PlaylistScreen.tsx  – detail layout: toolbar, remove zone, audio, sidebar
    PlaylistHeader.tsx  – artwork, title, badges, meta
    TrackList.tsx       – track rows + infinite-scroll sentinel
    TrackRow.tsx        – one sound row (artwork, waveform, preview buttons)
    WaveformCanvas.tsx  – per-track loudness waveform canvas
    OrganizeSidebar.tsx – "Reorganize" sidebar (drop targets, choose mode)
    shared.tsx          – artwork / badges / meta presentational helpers
  services/             – framework-agnostic logic (no React imports except
                          the store hook, no DOM beyond canvas + audio)
    store.ts            – central state snapshot + `useApp()` (useSyncExternalStore)
    config.ts           – localStorage persistence (proxy URL, tokens, user)
    oauth.ts            – OAuth 2.1 + PKCE: authorize URL, token exchange, refresh
    api.ts              – SoundCloud API client (401 auto-refresh, pagination,
                          read-modify-write helpers)
    session.ts          – OAuth callback, token refresh, sign-in/out lifecycle
    router.ts           – hash routing (#/playlists, #/playlist/<id>)
    tracks.ts           – open playlist, track pagination (infinite scroll)
    preview.ts          – preview playback controller (buttons, audio element)
    preview-runtime.ts  – shared <audio> element + non-reactive preview fields
    audio-engine.ts     – audio source resolution for previews and waveform
                          jumps: HLS reassembly + MediaSource streaming (mp3 & AAC)
    analysis-source.ts  – shared audio loader for the in-browser analyzers:
                          HLS segments, or windows sliced from the whole-track
                          source when the track exposes no HLS playlist
    chroma.ts           – in-browser chroma analysis: key estimation from
                          segments spread across the track (FFT → pitch
                          classes → Krumhansl–Kessler profile)
    bpm.ts              – in-browser tempo estimation from segments spread
                          across the track (spectral flux → autocorrelation)
    audio.ts            – shared analysis primitives (radix-2 FFT, Hann
                          window, mono mixdown, HLS blob decoding)
    waveform.ts         – waveform fetch/cache/draw for the track rows
    organize.ts         – drag & drop between playlists, create playlist, undo
    debug.ts            – persistent troubleshooting log (subscribable)
    util.ts             – base64url / PKCE / formatting helpers
  styles/               – styling split into focused modules (base, layout,
                          components, forms, playlists, playlist-detail, tracks,
                          organize, debug)
```

The data layer (config, oauth, api, debug) is untouched framework-agnostic
TypeScript; the old hand-rolled DOM rendering lives on as React components
fed by a single store snapshot (`useSyncExternalStore`).

## SoundCloud API reference (used here)

| Step | Reference |
|------|-----------|
| Register app | <https://developers.soundcloud.com/docs/api/register-app> |
| OAuth guide | <https://developers.soundcloud.com/docs/api/guide#authentication> |
| `GET /me/playlists` | <https://developers.soundcloud.com/docs/api/explorer/open-api> |
| `GET /playlists/{id}?show_tracks=true` | <https://developers.soundcloud.com/docs/api/explorer/open-api> |
| `PUT /playlists/:id` (reorganize) | <https://developers.soundcloud.com/docs/api/explorer/open-api> |
| `POST /playlists` (create) | <https://developers.soundcloud.com/docs/api/explorer/open-api> |
| OpenAPI spec | <https://github.com/soundcloud/api/blob/master/openapi/api.yaml> |

## Features

- Browse your playlists with search / type filter / sorting and pagination
  (`GET /me/playlists`), with `#/playlist/<id>` deep links
- Open a playlist and page through its tracks with infinite scroll
  (`GET /playlists/{id}?show_tracks=true`)
- In-browser audio previews (`/tracks/:id/streams`, played in `<audio>`):
  full track when SoundCloud exposes one (mp3 or AAC HLS — reassembled —
  or a direct progressive file; tracks with empty `/streams` are resolved
  through their HLS transcodings), ~30 s snippet as last resort; ▶ plays
  from the start and the waveform is clickable to jump into the track
- **Reorganize** mode: drag & drop tracks onto your other playlists to copy
  them there (drop on a card) or move them (drop on the far-right ⇥ strip,
  which also removes them from the open playlist) — all via read-modify-write
  `PUT /playlists/:id`
- Create a new, empty playlist (`POST /playlists`)
- **Key estimation (♪ button)**: in-browser chroma analysis from 4 source
  windows spread across the track (HLS segments, or 25 s windows sliced
  from the whole-track source when no HLS playlist exists — so every track
  that can play can be analyzed), each split into ~4 s chunks (FFT
  pitch-class energy → per-chunk chroma vectors, silent chunks dropped →
  average → best Krumhansl–Kessler major/minor match), shown on the row with
  its correlation. **Analyze all keys** in the playlist toolbar batches the
  whole track list (3 in parallel, click again to stop). Results persist in
  `localStorage` (`playlist_updater.chromas`), so keys are computed once per
  track, ever
- **BPM estimation (♩ button)**: in-browser tempo analysis from the track's
  most intense passages (HLS segments — or whole-track windows, same
  fallback as keys — chosen at the loudest moments of the SoundCloud
  waveform bars, even spread as fallback), then each is decoded to
  an onset strength envelope (2× decimated to 22.05 kHz, 1024-sample Hann
  FFT, hop 512 → ~43 fps spectral flux, silent frames muted), autocorrelated
  over 60–200 BPM lags; the segments' autocorrelations are averaged per lag
  and the winning peak (parabolically refined) is folded into the 85–180 BPM
  window by octaves.
  Both analyzers share a segment blob + decoded-mono cache keyed by segment
  URL, so running BPM after keys (or re-analyzing) costs no network and no
  decode. **Analyze all BPMs** in the playlist toolbar batches the whole
  track list (3 in parallel, click again to stop). Results persist in
  `localStorage` (`playlist_updater.bpms`)

## Development

- `npm run typecheck` — strict TypeScript, no emit
- `npm run build` / `npm run serve` — production bundle / serve it locally
- `tests/bpm-test/` — Node sanity checks that bundle the real `services/`
  code (with small `localStorage` / `OfflineAudioContext` / DOM shims):
  tempo estimates on synthesized click tracks (`entry.ts`, helpers in
  `entry-helpers.ts`), the intensity-guided segment picker, a quiet-intro /
  loud-drop track (`intro-check.ts`), the analyzers' whole-track fallback
  when no HLS playlist exists (`fallback-check.ts`), and the FFT against a
  reference implementation (`rfft-check.ts`):

  ```sh
  npx rolldown tests/bpm-test/entry.ts --format esm --platform node --file /tmp/bpm-test.mjs && node /tmp/bpm-test.mjs
  npx rolldown tests/bpm-test/intro-check.ts --format esm --platform node --file /tmp/intro-check.mjs && node /tmp/intro-check.mjs
  npx rolldown tests/bpm-test/fallback-check.ts --format esm --platform node --file /tmp/fallback-check.mjs && node /tmp/fallback-check.mjs
  npx rolldown tests/bpm-test/rfft-check.ts --format esm --platform node --file /tmp/rfft-check.mjs && node /tmp/rfft-check.mjs
  ```

## Next steps (roadmap)

- Remove tracks from a playlist without moving them
- Reorder tracks within a playlist
- Edit playlist metadata (title, description, sharing)
- Delete playlists (`DELETE /playlists/:id`)
