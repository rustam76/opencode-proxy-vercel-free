# opencode-free-proxy (Vercel serverless)

OpenAI-compatible (`POST /v1/chat/completions`, `GET /v1/models`) and
Anthropic-compatible (`POST /v1/messages`) proxy as **Vercel Serverless Functions**,
plus `GET /health`. No persistent server, no filesystem writes, secrets via env vars.

> **Upstream honesty.** The legacy Zen transport (`ALLOW_ZEN_LEGACY=true`,
> `lib/upstream.js`) talks to `https://opencode.ai/zen/v1/chat/completions` with
> `Authorization: Bearer public` plus reverse-engineered `x-opencode-*` headers
> (deleted local Express server `server.mjs` used the same mechanism; it remains
> in git history for analysis). That integration is **not officially
> supported** — it emulates a first-party client and can break or be
> rate-limited at any time. The Vercel functions default to an **officially
> supported** OpenAI-compatible upstream you configure via `UPSTREAM_BASE_URL`
> + `UPSTREAM_API_KEY`. Only set `ALLOW_ZEN_LEGACY=true` if you accept that risk
> (see `.env.example`).

## Directory structure

```
api/
  health.js                  GET /health (via rewrite)
  v1/
    models.js                GET /v1/models (via rewrite)
    chat/
      completions.js         POST /v1/chat/completions (via rewrite)
    messages.js              POST /v1/messages (via rewrite)
lib/
  config.js                  env config, model list, upstream mode
  auth.js                    Bearer / x-api-key validation
  http.js                    body parsing, validation, error shapes, CORS
  convert.js                 Anthropic <-> OpenAI translation (incl. SSE)
  upstream.js                official vs zen-legacy adapter, SSRF-safe URLs
  url-safety.js              upstream URL validation
  log.js                     metadata-only logging + secret redaction
  rate-limit.js              best-effort per-instance limiter
tests/
  health-models.test.js      health + model listing
  auth.test.js               auth success/failure, missing env
  validation-errors.test.js  invalid bodies, bad models, upstream errors
  chat-anthropic.test.js     non-streaming, streaming, Anthropic endpoint
  upstream-security.test.js  SSRF, adapter, redaction, vercel.json routes
vercel.json                  functions + rewrites to exact public URLs
.env.example                 placeholder env vars only (no secrets)
opencode.json.example        OpenCode CLI config (`@ai-sdk/openai-compatible`)
docs/
  DEPLOYMENT.md              GitHub + Vercel deploy, env vars
  VERCEL.md                  vercel.json, dashboard, limits, custom domain
  NINEROUTER.md              register in 9Router as custom provider
  OPENCODE.md                OpenCode CLI setup, /models selection
  TROUBLESHOOTING.md         errors, streaming, rate limits
```

## Quick start (local)
npm install
cp .env.example .env   # fill in PROXY_API_KEY + UPSTREAM_* (see below)
npm test               # 34 tests, must all pass
```

Local smoke test of a function (example: health):

```bash
PROXY_API_KEY=test MODELS=m1 node -e "
import('./api/health.js').then(async ({default: h}) => {
  const {createServer} = await import('node:http');
  createServer((req, res) => h(req, res)).listen(3001, () =>
    console.log('http://localhost:3001/health'));
});"
```

## Configuration

See `.env.example`. Required:

| Variable | Purpose |
|---|---|
| `PROXY_API_KEY` | **Required.** Comma-separated proxy secrets. Clients send one via `Authorization: Bearer …` or `x-api-key`. |
| `UPSTREAM_BASE_URL` | **Required (recommended).** Authorized OpenAI-compatible base, e.g. `https://api.example.com/v1`. |
| `UPSTREAM_API_KEY` | **Required (recommended).** Upstream key. Never sent to clients. |
| `MODELS` | Comma list returned by `GET /v1/models`. Must match upstream IDs. Defaults to the 5 legacy IDs. |
| `ALLOW_ZEN_LEGACY` | `true` only to opt into the unsupported Zen transport. `UPSTREAM_BASE_URL` wins when set. |
| `MAX_BODY_BYTES` | Default `2097152`. |
| `UPSTREAM_TIMEOUT_MS` | Default `55000` (under Vercel limits). |
| `RATE_LIMIT_PER_MINUTE` | Default `60`. Per-instance only — see below. |

## API

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/health` | none | `{status, version, models, upstreamMode, endpoints}` |
| `GET` | `/v1/models` | none | actual configured `MODELS`, OpenAI list shape |
| `POST` | `/v1/chat/completions` | `Bearer` or `x-api-key` | OpenAI errors; SSE passthrough when `stream:true` |
| `POST` | `/v1/messages` | `Bearer` or `x-api-key` | Anthropic errors; OpenAI SSE translated to Anthropic SSE when `stream:true` |

Tool/function calling is forwarded when the upstream supports it; the
Anthropic endpoint translates `tools`/`tool_use`/`tool_result` both ways.
Capabilities depend on the upstream — nothing is faked. If the upstream lacks
a capability, its error is propagated.

### Rate limiting

`lib/rate-limit.js` is a best-effort per-instance fixed window. Serverless
instances don't share memory, so for production put Vercel Firewall, Upstash
Redis, or Cloudflare in front. Responses include `Retry-After` on 429.

### What is logged

Metadata only: method, route, model, stream flag, message count, statuses,
durations. Never prompts, message contents, bodies, or keys. `lib/log.js`
additionally redacts key-like patterns. There is **no** claim of zero logging —
Vercel's platform logs still apply.

## Docs

- `docs/DEPLOYMENT.md` — deploy + env vars + route verification
- `docs/VERCEL.md` — vercel.json, dashboard settings, limits, custom domain
- `docs/NINEROUTER.md` — 9Router custom provider
- `docs/OPENCODE.md` — OpenCode CLI config + `/models`
- `docs/TROUBLESHOOTING.md` — common failures

## Limitations

- Model availability is whatever the upstream actually serves. The 5 default
  IDs mirror the legacy server; verify with `GET /v1/models` and upstream docs.
- Streaming uses SSE chunk passthrough (no full buffering); Vercel plan
  limits (`maxDuration: 60`, response sizes) still apply.
- No shared state across instances (sessions are per-request in serverless;
  the legacy 30-min session cache was intentionally not ported).
