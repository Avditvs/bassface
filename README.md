# Playlist Updater (frontend)

A small, backend-free web app that connects to **SoundCloud** through the
[official API](https://developers.soundcloud.com/docs/api/guide) and lists your
playlists. OAuth 2.1 (authorization code + PKCE) runs entirely in the browser —
there is no server to deploy.

## How it works

```
browser ──▶ secure.soundcloud.com/authorize   (login + consent, PKCE S256)
browser ◀── redirect ?code&state
browser ──▶ secure.soundcloud.com/oauth/token (code ⇄ access/refresh tokens)
browser ──▶ api.soundcloud.com/me/playlists   (list playlists, paginated)
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
sorting.

> **Playlist Updater** stores your credentials and OAuth tokens in
> `localStorage` of your own browser. They never leave your machine. This is a
> personal tool — the Client Secret (if provided) is only sent to
> SoundCloud's token endpoint, but be aware that anything embedded in a
> frontend cannot be kept secret.

## Project layout

```
index.html    – single page UI (connect + playlist views)
styles.css    – styling
js/
  util.js     – base64url / PKCE / formatting helpers
  config.js   – localStorage persistence (credentials, tokens, profile)
  oauth.js    – OAuth 2.1 + PKCE: authorize URL, token exchange, refresh
  api.js      – SoundCloud API client (401 auto-refresh, pagination)
  app.js      – app controller / rendering
```

## SoundCloud API reference (used here)

| Step | Reference |
|------|-----------|
| Register app | <https://developers.soundcloud.com/docs/api/register-app> |
| OAuth guide | <https://developers.soundcloud.com/docs/api/guide#authentication> |
| `GET /me/playlists` | <https://developers.soundcloud.com/docs/api/explorer/open-api> |
| OpenAPI spec | <https://github.com/soundcloud/api/blob/master/openapi/api.yaml> |

## Next steps (roadmap)

- View / edit a playlist's tracks (`GET /playlists/:id?show_tracks=true`,
  `PUT /playlists/:id`)
- Create and delete playlists (`POST /playlists`, `DELETE /playlists/:id`)
- Reorder tracks — the "updater" part, currently the app is a read-only
  playlist explorer.