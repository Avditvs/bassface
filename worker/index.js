/**
 * SoundCloud OAuth token proxy (Cloudflare Worker).
 *
 * The browser sends token requests WITHOUT the client secret; this worker
 * injects SOUNDCLOUD_CLIENT_SECRET from its environment and forwards them
 * to SoundCloud's token endpoint. The secret never ships in the static
 * bundle, and the browser never sees it.
 *
 *   browser ──▶ POST <worker>                        (grant params, no secret)
 *   worker  ──▶ POST secure.soundcloud.com/oauth/token  (secret added)
 *   worker  ◀── tokens
 *   browser ◀── tokens
 *
 * Environment:
 *   SOUNDCLOUD_CLIENT_SECRET (secret — `npx wrangler secret put
 *     SOUNDCLOUD_CLIENT_SECRET`): required, the app's client secret.
 *   SOUNDCLOUD_CLIENT_ID (var): the app's public Client ID. When set, it is
 *     served to the browser via `GET <worker>` (so the connect screen can
 *     auto-fill it) and injected into every token request — the proxy can
 *     then only ever mint tokens for your own app, and nothing but the
 *     proxy URL needs to be configured in the browser.
 *   ALLOWED_ORIGINS (var): comma-separated origins allowed via CORS, e.g.
 *     "https://bassface.pages.dev,http://127.0.0.1:8080". Empty = any origin
 *     (fine for local development; set it in production).
 */

const TOKEN_URL = "https://secure.soundcloud.com/oauth/token";
const ALLOWED_GRANTS = new Set(["authorization_code", "refresh_token"]);

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function corsHeaders(requestOrigin, allowed) {
  const headers = {
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
    vary: "origin",
  };
  // Empty ALLOWED_ORIGINS = dev mode: reflect any origin.
  if (allowed.length === 0 || allowed.includes(requestOrigin)) {
    headers["access-control-allow-origin"] = requestOrigin || "*";
  }
  return headers;
}

function fail(status, message, cors) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...cors },
  });
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request.headers.get("origin") ?? "", allowedOrigins(env));

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    // GET: hand the browser the Client ID configured on this worker, so the
    // connect screen can auto-fill it (public value — only the URL is secret-ish).
    if (request.method === "GET") {
      if (!env.SOUNDCLOUD_CLIENT_ID) {
        return fail(404, "worker not configured: missing SOUNDCLOUD_CLIENT_ID", cors);
      }
      return new Response(JSON.stringify({ client_id: env.SOUNDCLOUD_CLIENT_ID }), {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          ...cors,
        },
      });
    }

    if (request.method !== "POST") {
      return fail(405, "GET or POST only", cors);
    }
    if (!env.SOUNDCLOUD_CLIENT_SECRET) {
      return fail(500, "worker not configured: missing SOUNDCLOUD_CLIENT_SECRET", cors);
    }

    let params;
    try {
      params = new URLSearchParams(await request.text());
    } catch {
      return fail(400, "invalid form body", cors);
    }

    // Only the two browser-driven grants; anything else (e.g.
    // client_credentials) is refused.
    const grantType = params.get("grant_type");
    if (!ALLOWED_GRANTS.has(grantType)) {
      return fail(400, `unsupported grant_type: ${grantType ?? "(none)"}`, cors);
    }

    // Pin the request to your own app: when SOUNDCLOUD_CLIENT_ID is set it
    // overrides whatever the browser sent (the browser may even omit it).
    if (env.SOUNDCLOUD_CLIENT_ID) {
      params.set("client_id", env.SOUNDCLOUD_CLIENT_ID);
    } else if (!params.get("client_id")) {
      return fail(400, "missing client_id (set SOUNDCLOUD_CLIENT_ID on the worker or send it from the browser)", cors);
    }
    params.set("client_secret", env.SOUNDCLOUD_CLIENT_SECRET);

    const upstream = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        accept: "application/json; charset=utf-8",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });

    // Pass SoundCloud's answer through untouched — including errors, so the
    // browser can show the real reason for a failure.
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "content-type": upstream.headers.get("content-type") ?? "application/json; charset=utf-8",
        "cache-control": "no-store",
        ...cors,
      },
    });
  },
};
