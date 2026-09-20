# AGENTS.md

Guidance for AI coding agents working in this repository.

## Overview

**Bassface** — backend-free SoundCloud playlist manager. TypeScript + React 19
+ Vite (`src/`), served as static assets by a Cloudflare Worker
(`wrangler.jsonc`). A second small Worker (`worker/`) proxies OAuth tokens and
holds the Client Secret — never in the browser, bundle, or repo.

Docs: `README.md` (quick start), `DOCUMENTATION.md` (full technical
reference), `worker/README.md` (token proxy).

## Commands

```bash
npm run typecheck   # strict tsc --noEmit — run after every change
npm run dev         # Vite dev server (hot reload)
npm run build       # vite build → dist/
npm run serve       # build + serve dist/ on http://127.0.0.1:8080
```

CI/CD (`.github/workflows/`):
- `ci.yml` runs `npm ci`, typecheck, and build on every push/PR to `main`.
- `deploy.yml` typechecks, builds, and deploys the frontend to Cloudflare
  (via `wrangler deploy`, using `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`
  secrets) on every push to `main` — it updates the live pages automatically.
  It does not deploy the token proxy in `worker/`; that is still manual.

`npm run deploy` publishes to Cloudflare manually — never run it
unless explicitly asked.

## Architecture

- `src/components/` — React rendering only, fed by the immutable snapshot
  from `useApp()` (`src/services/store.ts`, `useSyncExternalStore`).
- `src/services/` — framework-agnostic logic: no React imports (except the
  store hook), no DOM beyond canvas + audio elements.
- Styling in `src/styles/` (focused modules); `index.html` carries the CSP
  meta tag — do not weaken it.
- Hash-based routing (`#/playlists`, `#/playlist/<id>`) via
  `src/services/router.ts`.

## Security invariants (do not break)

- OAuth 2.1 + PKCE (S256), single-use `state`; PKCE verifier in
  `sessionStorage` only. Client Secret never in frontend code, bundle, repo,
  or commits (`config.local.json` — see `config.local.json.example`).
- Bearer tokens only sent to `*.soundcloud.com` / `*.sndcdn.com`
  (`isTokenSafeUrl`, `src/services/api.ts`).
- SoundCloud data interpolation goes through React; URL-typed attributes go
  through `escapeUrl` (`src/services/util.ts`), which rejects
  `javascript:` / `data:` schemes.
- Logging goes through `dbg` → `redactSecrets`; never log raw tokens,
  secrets, or signed URLs.

## Testing

No unit test framework; sanity checks in `tests/bpm-test/` bundle the real
`src/services/` code with small shims:

```bash
for t in entry intro-check fallback-check rfft-check; do
  npx rolldown tests/bpm-test/$t.ts --format esm --platform node --file /tmp/$t.mjs && node /tmp/$t.mjs
done
```

Run the relevant check if you touch `bpm.ts`, `audio.ts`,
`analysis-source.ts`, or the FFT. `tests/librosa-compare/` compares estimates
against librosa.

## Conventions

- Strict TypeScript, typecheck clean; no `any` unless truly unavoidable.
- Match the existing style; one concern per file under `src/services/`.
- SoundCloud API shapes are typed in `src/types.ts` — extend those types
  instead of inlining ad-hoc shapes.
- `dist/`, `node_modules/`, `.wrangler/` are build artifacts; never edit.
