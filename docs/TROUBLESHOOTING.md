# Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `401 Invalid API key` | wrong/missing proxy key | Send `Authorization: Bearer $PROXY_API_KEY` or `x-api-key`; check for whitespace/newlines when pasting from Vercel dashboard. |
| `500 PROXY_API_KEY is not set` | env var missing on Vercel | Add `PROXY_API_KEY` in Settings → Environment Variables (Production), then Redeploy. |
| `500 upstream-not-configured` | no upstream | Set `UPSTREAM_BASE_URL` + `UPSTREAM_API_KEY`, or explicitly `ALLOW_ZEN_LEGACY=true`. |
| `400 Unknown model … Available: …` | stale model ID | Use only IDs from `GET /v1/models`; update `MODELS` to match the upstream. |
| `400 'messages' must be …` etc. | malformed body | Check required fields (`model`, `messages`, and `max_tokens` for `/v1/messages`). |
| `429 … (upstream rate limit)` | upstream quota | Back off, retry, reduce concurrency; add external rate limiting / fallback provider. |
| `502 Invalid upstream response` | upstream returned non-JSON | Upstream may be down or the model ID unsupported there; retry and check upstream status. |
| `504 Upstream timeout` | slow upstream / cold start | Retry; lower `max_tokens`; check `UPSTREAM_TIMEOUT_MS` (≤ 55000). |
| Stream stalls or truncates | proxy/CDN buffering, client timeout | Ensure client accepts `text/event-stream`; try `stream:false` to isolate; Vercel `maxDuration` is 60s. |
| `405 Method not allowed` | wrong verb | `GET` for `/health`, `/v1/models`; `POST` for the two completion endpoints. |
| `413 Request body too large` | huge payload | Shrink messages/attachments; raise `MAX_BODY_BYTES` (≤ 10MB). |
| Anthropic stream missing `message_stop` | upstream closed early | Retry non-streaming to see the real error; check upstream tool-use support. |
| Routes 404 on Vercel | rewrites not applied | Confirm `vercel.json` at repo root with the four rewrites; redeploy; test `/api/health` vs `/health`. |

## Getting unstuck

1. `curl $BASE/health` — confirms the deployment is up and shows `upstreamMode`.
2. `curl $BASE/v1/models` — confirms the real model list.
3. Repeat the failing call with `stream:false` — surfaces JSON errors clearly.
4. Run `npm test` locally after any change — 34 tests cover auth, validation,
   streaming, conversion, SSRF safety, and redaction.

## What NOT to do

- Don't set `ALLOW_ZEN_LEGACY=true` to "fix" a 502 from your official upstream —
  it swaps to a different, unsupported backend and hides the real problem.
- Don't log or paste full request bodies or keys when asking for help; the
  server intentionally never logs them.
