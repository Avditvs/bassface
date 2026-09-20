# AGENTS.md

Guidance for AI coding agents working in this repository.

## Project overview

**Bassface** — a backend-free SoundCloud playlist manager. TypeScript + React
19 + Vite frontend (`src/`), served as static assets from a Cloudflare Worker
(`wrangler.jsonc`). A separate small Cloudflare Worker (`worker/`) acts as an
OAuth token proxy and holds the SoundCloud Client Secret — it is **never**
stored in the browser, the bundle, or this repo.

Key references:
- `README.md` — quick start, features, project layout
- `DOCUMENTATION.md` — full technical reference (architecture, state,
  OAuth, audio pipeline, analysis algorithms, testing, module map)
- `worker/README.md` — token proxy deployment

## Commands

```bash
npm install                 # install dependencies (Node >= 24)
npm run typecheck           # strict tsc --noEmit — run this after every change
npm run build               # vite build → dist/
npm run dev                 # Vite dev server with hot reload (fast edit loop)
npm run serve               # build + serve dist/ on http://127.0.0.1:8080
```

CI (`.github/workflows/ci.yml`) runs `npm ci`, `npm run typecheck`, and
`npm run build` on every push/PR to `main`. `npm run deploy` deploys to
Cloudflare — do not run it unless explicitly asked.

## Architecture rules

- `src/components/` — React rendering only, fed by the immutable snapshot
  from `useApp()` (`src/services/store.ts`, `useSyncExternalStore`).
- `src/services/` — framework-agnostic logic: no React imports (except the
  store hook), no DOM beyond canvas + audio elements.
- Styling lives in `src/styles/`, split into focused modules; `index.html`
  carries the CSP meta tag — do not weaken it.
- Routing is hash-based (`#/playlists`, `#/playlist/<id>`) via
  `src/services/router.ts`.

## Security invariants (do not break)

- OAuth 2.1 + PKCE (S256) with single-use `state`; PKCE verifier lives in
  `sessionStorage` only.
- The Client Secret must never enter the frontend code, bundle, or repo.
- Bearer tokens are only ever sent to `*.soundcloud.com` / `*.sndcdn.com`
  hosts (`isTokenSafeUrl` in `src/services/api.ts`).
- All SoundCloud data interpolation goes through React; URL-typed attributes
  pass through `escapeUrl` (`src/services/util.ts`), which rejects
  `javascript:` / `data:` schemes.
- Log output goes through `dbg` → `redactSecrets` (`src/services/util.ts`);
  never log raw tokens, secrets, or signed URLs.
- Never commit `config.local.json` (see `config.local.json.example`).

## Testing

There is no unit test framework; sanity checks live in `tests/bpm-test/`
and bundle the real `src/services/` code with small shims:

```bash
npx rolldown tests/bpm-test/entry.ts --format esm --platform node --file /tmp/bpm-test.mjs && node /tmp/bpm-test.mjs
npx rolldown tests/bpm-test/intro-check.ts --format esm --platform node --file /tmp/intro-check.mjs && node /tmp/intro-check.mjs
npx rolldown tests/bpm-test/fallback-check.ts --format esm --platform node --file /tmp/fallback-check.mjs && node /tmp/fallback-check.mjs
npx rolldown tests/bpm-test/rfft-check.ts --format esm --platform node --file /tmp/rfft-check.mjs && node /tmp/rfft-check.mjs
```

If you touch `bpm.ts`, `audio.ts`, `analysis-source.ts`, or the FFT, run the
relevant check. `tests/librosa-compare/` compares estimates against librosa.

## Conventions

- Strict TypeScript — keep `npm run typecheck` clean; no `any` unless truly
  unavoidable.
- Match the existing code style of the file you edit; keep modules focused
  (one concern per file under `src/services/`).
- The SoundCloud API shapes are typed in `src/types.ts` — extend those types
  rather than inlining ad-hoc shapes.
- `dist/`, `node_modules/`, `.wrangler/` are build artifacts; never edit them.
