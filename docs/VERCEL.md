# Vercel setup reference

Everything Vercel-specific in one place: what `vercel.json` does, which
dashboard settings matter, and Vercel limits that affect this proxy.
For the step-by-step deploy flow, see `docs/DEPLOYMENT.md`.

## How routing works

Files under `api/` become Serverless Functions automatically:

| File | Native URL | Public URL (via rewrite) |
|---|---|---|
| `api/health.js` | `/api/health` | `/health` |
| `api/v1/models.js` | `/api/v1/models` | `/v1/models` |
| `api/v1/chat/completions.js` | `/api/v1/chat/completions` | `/v1/chat/completions` |
| `api/v1/messages.js` | `/api/v1/messages` | `/v1/messages` |

The `rewrites` in `vercel.json` map the public URLs to the functions, so
clients never need the `/api` prefix. Both URL forms work; document only the
public form to clients.

## `vercel.json` explained

```json
{
  "functions": {
    "api/**/*.js": { "maxDuration": 60 }
  },
  "rewrites": [ ... ]
}
```

- `functions."api/**/*.js".maxDuration: 60` — max execution time per request
  (60 s is the Hobby plan ceiling; matches `UPSTREAM_TIMEOUT_MS=55000`).
- `rewrites` — pure URL mapping, no redirect; request method, headers, and
  streaming body pass through unchanged.
- No `builds`, `routes`, or `headers` sections are needed. Don't add legacy
  `routes` alongside `rewrites` — they conflict.

## Dashboard settings

Project → **Settings**:

- **General → Node.js Version:** 18.x or newer (22.x works).
- **General → Region:** pick closest to your upstream to cut latency
  (e.g. `sin1` Singapore for Asia, `iad1` for US). Streaming time-to-first-byte
  follows region ↔ upstream distance.
- **Environment Variables:** add `PROXY_API_KEY`, `UPSTREAM_BASE_URL`,
  `UPSTREAM_API_KEY`, `MODELS` for **Production** (plus **Preview** if you want
  branch deployments tested). Redeploy after any change.
- **Git → Production Branch:** `main`. Every push auto-deploys; Preview
  Deployments get their own `*.vercel.app` URL for testing.
- **Security / Firewall** (optional, recommended): add rate-limit or bot rules
  in front of `/v1/*` — the in-repo limiter is per-instance only.

## Deploy via CLI (alternative to dashboard import)

```bash
npm i -g vercel
vercel login
vercel --prod
```

Then set env vars without the dashboard:

```bash
vercel env add PROXY_API_KEY production
vercel env add UPSTREAM_BASE_URL production
vercel env add UPSTREAM_API_KEY production
vercel env add MODELS production
vercel --prod   # redeploy to pick them up
```

## Observability

- **Deployments → Functions → Logs:** metadata-only lines (`[chat]`, `[auth]`,
  `[upstream]`) — method, route, model, statuses, durations. Bodies and keys
  are never logged by this code, but Vercel platform request logs still exist;
  don't claim zero logging.
- **Analytics / Speed Insights** (optional): useful to watch p50/p99 latency
  of `/v1/chat/completions` and 429/502 rates from the upstream.

## Limits to know (Hobby plan)

| Limit | Value | Impact here |
|---|---|---|
| Function duration | 60 s max | `UPSTREAM_TIMEOUT_MS` must stay ≤ 55000 |
| Response size | ~4.5 MB (Fluid) | fine for chat; huge `max_tokens` + long history could approach it — keep histories trimmed |
| Concurrent executions | 12 (Hobby) | burst traffic queues; add caching/rate limits or upgrade for team use |
| Bandwidth | 100 GB/mo | SSE streams count; personal use is far below this |

## Custom domain (optional)

Project → **Settings → Domains** → add `llm.example.com`. Client base URL
becomes `https://llm.example.com/v1`. No code change needed — rewrites are
path-based and domain-independent. Remember to update `opencode.json` and
9Router provider settings to the new base URL.
