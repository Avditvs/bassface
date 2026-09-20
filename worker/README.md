# SoundCloud token proxy (Cloudflare Worker)

A ~80-line fetch forwarder that keeps your SoundCloud **client secret
server-side**. The Cloudflare-hosted frontend sends its token requests (code
exchange and refresh) to this worker *without* the secret; the worker
injects `SOUNDCLOUD_CLIENT_SECRET` from its environment and forwards the
request to `https://secure.soundcloud.com/oauth/token`.

The secret is never in the repo, never in the Pages bundle, and never in
the browser. The worker also **serves the Client ID** (public value):
`GET <worker>` returns `{ "client_id": "…" }`, which the connect screen
fetches automatically — the browser only ever needs the worker URL.

```
browser ──▶ <worker>.workers.dev        (grant params, no secret)
worker  ──▶ secure.soundcloud.com/oauth/token   (secret added from env)
worker  ◀── tokens
browser ◀── tokens
```

## Deploy (5 minutes, free tier)

1. **Install the CLI** (once):

   ```bash
   cd worker
   npm install
   npx wrangler login
   ```

2. **Configure** in `wrangler.toml`:
   - `ALLOWED_ORIGINS` — your frontend origin(s), e.g.
     `"https://bassface.germain-louis-80.workers.dev,http://127.0.0.1:8080"`.
   - `SOUNDCLOUD_CLIENT_ID` — your app's Client ID (public value). When set,
     the worker serves it to the browser via `GET` and injects it into every
     token request.

3. **Set the secret** (never in the file):

   ```bash
   npx wrangler secret put SOUNDCLOUD_CLIENT_SECRET
   # paste the Client Secret when prompted
   ```

4. **Deploy**:

   ```bash
   npm run deploy
   ```

   The worker URL looks like
   `https://soundcloud-token-proxy.<your-subdomain>.workers.dev`.

5. **Point the app at it**: the Bassface build already contains the worker
   URL (`CONFIG_DEFAULTS.tokenProxyUrl` in `src/services/config.ts`) — on
   the deployed site, just click **Connect with SoundCloud**. The Client ID
   is fetched from the proxy at connect time (requires
   `SOUNDCLOUD_CLIENT_ID` on the worker), and the secret is injected by it.

## Local development

```bash
npm run dev          # local dev server (http://localhost:8787)
```

For local testing, create a `.dev.vars` file (git-ignored) with:

```
SOUNDCLOUD_CLIENT_SECRET=your-secret
SOUNDCLOUD_CLIENT_ID=your-client-id
ALLOWED_ORIGINS=http://127.0.0.1:8080
```

## Hardening notes

- Only the `authorization_code` and `refresh_token` grants are accepted.
- When `SOUNDCLOUD_CLIENT_ID` is set, the worker **overrides** the
  `client_id` sent by the browser — the proxy can only mint tokens for
  your own app (and it also hands the ID out via `GET`, for auto-fill).
- `ALLOWED_ORIGINS` restricts CORS to your Pages origin. Note that CORS is
  a browser-only control: for a personal app this is fine, but the worker
  URL is technically reachable by non-browser clients too. If you want a
  stronger lock, add a shared `PROXY_KEY` header check in `index.js`.
- Custom worker domain? If you deploy the worker on a domain other than
  `*.workers.dev`, add it to `connect-src` in the app's `index.html` CSP
  (this repo already allows `soundcloud-token-proxy.louis-germain.fr`).
