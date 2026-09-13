# Playlist Updater (frontend)

A small, backend-free web app that connects to **SoundCloud** through the
[official API](https://developers.soundcloud.com/docs/api/guide), lists your
playlists and lets you open one to browse the sounds inside it. OAuth 2.1
(authorization code + PKCE) runs entirely in the browser —
there is no server to deploy.

## How it works

```
browser ──▶ secure.soundcloud.com/authorize   (login + consent, PKCE S256)
browser ◀── redirect ?code&state
browser ──▶ secure.soundcloud.com/oauth/token (code ⇄ access/refresh tokens)
browser ──▶ api.soundcloud.com/me/playlists   (list playlists, paginated)
browser ──▶ api.soundcloud.com/playlists/:id  (open one, list its tracks)
```

SoundCloud supports [CORS for browser JavaScript](https://developers.soundcloud.com/docs/api/guide#crossdomain),
including the token endpoint, so the whole flow is client-side. Access tokens
expire after ~1 hour; the app refreshes them automatically with the
(single-use) refresh token.

## Requirements

1. A SoundCloud account with an **Artist Pro** subscription (required by
   SoundCloud to create API apps).
2. Register an app at the
   [SoundCloud developer portal](https://developers.soundcloud.com/docs/api/register-app)
   to get a **Client ID** (and optionally a **Client Secret**).

   For the redirect URI, register the address you will serve the app from,
   for example `http://127.0.0.1:8080/` (trailing slash matters — it must
   match what the app sends).

   > **Enter both the Client ID and Client Secret, from the same app,**
   > copied exactly with no trailing spaces. SoundCloud treats registered
   > apps as confidential clients and rejects the token exchange with
   > `invalid_client` when the secret is missing or wrong. (The client_id-
   > only flow that SoundCloud's own CLI uses only works for their bundled
   > public client.)

## Run it

No build step. Serve the folder over http(s) — Python, Node, or anything else:

```bash
cd playlist_updater
python3 -m http.server 8080
```

Then open <http://127.0.0.1:8080/>, paste your Client ID (and secret if you
registered one) and click **Connect with SoundCloud**. After authorizing you
are redirected back and your playlists are listed with search / type filter /
sorting. Click a card (or its **View tracks** button) to open the playlist and
browse the sounds it contains — each row has two buttons: **▶** plays the
track from the start and **⏫** jumps straight to its loudest part (computed
in-browser with an RMS scan). When SoundCloud exposes a full-length
progressive mp3 (directly or via HLS, which the app reassembles), the whole
track plays; otherwise it falls back to SoundCloud's ~30 s snippet.

The **Reorganize** button on a playlist opens a sidebar listing your other
playlists: drag a track row onto a card to copy it there, or onto the
far-right **⇥** strip to move it (copied there and removed from the open
playlist). A **+ New** button in the sidebar creates an empty playlist.

> **Playlist Updater** stores your credentials and OAuth tokens in
> `localStorage` of your own browser. They never leave your machine. This is a
> personal tool — the Client Secret (if provided) is only sent to
> SoundCloud's token endpoint, but be aware that anything embedded in a
> frontend cannot be kept secret.

## Project layout

```
index.html          – single page UI (connect + playlist views)
css/                – styling split into focused modules (base, layout,
                      components, forms, playlists, playlist-detail, tracks,
                      organize, debug)
js/
  app.js            – entry point: boot sequence, event wiring
  state.js          – central mutable app state + shared labels
  config.js         – localStorage persistence (credentials, tokens, user)
  oauth.js          – OAuth 2.1 + PKCE: authorize URL, token exchange, refresh
  api.js            – SoundCloud API client (401 auto-refresh, pagination,
                      read-modify-write helpers)
  router.js         – hash routing (#/playlists, #/playlist/<id>)
  screens.js        – screen switching + shared status bar
  connect.js        – connect screen (config form, validation, redirect)
  render.js         – DOM rendering (playlist grid, detail header, track rows)
  tracks.js         – playlist detail: paging, infinite scroll
  organize.js       – "Reorganize" sidebar: drag & drop between playlists,
                      create playlist
  preview.js        – audio preview UI (▶ snippet, ⏫ loudest part, click-to-jump)
  audio-engine.js   – audio source resolution: waveform-guided peak seek,
                      HLS reassembly
  waveform.js       – waveform fetch/cache/draw for the track rows
  debug.js          – persistent troubleshooting log shown on the connect screen
  util.js           – base64url / PKCE / formatting helpers
```

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
  full track when SoundCloud exposes a progressive mp3 (directly or via HLS,
  which the app reassembles), ~30 s snippet otherwise; ▶ plays from the start,
  ⏫ jumps to the loudest part, and the waveform is clickable
- **Reorganize** mode: drag & drop tracks onto your other playlists to copy
  them there (drop on a card) or move them (drop on the far-right ⇥ strip,
  which also removes them from the open playlist) — all via read-modify-write
  `PUT /playlists/:id`
- Create a new, empty playlist (`POST /playlists`)

## Next steps (roadmap)

- Remove tracks from a playlist without moving them
- Reorder tracks within a playlist
- Edit playlist metadata (title, description, sharing)
- Delete playlists (`DELETE /playlists/:id`)
