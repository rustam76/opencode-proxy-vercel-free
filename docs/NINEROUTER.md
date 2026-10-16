# 9Router integration

9Router's Providers page supports custom OpenAI-compatible providers: you give
it an endpoint + API key and it routes through that base URL.

## Register the Vercel proxy

1. Deploy first and note your base URL (no trailing path beyond `/v1`):

   ```
   https://YOUR-PROJECT.vercel.app/v1
   ```

2. In 9Router, open the **Providers** page → add a **custom OpenAI-compatible
   provider** (wording varies by version; look for "Add custom provider" /
   "OpenAI Compatible").
3. Fill in:
   - **Base URL / Endpoint:** `https://YOUR-PROJECT.vercel.app/v1`
   - **API key:** your `PROXY_API_KEY` value (not the upstream key).
   - **Models:** the IDs from `GET https://YOUR-PROJECT.vercel.app/v1/models`.
4. Save, then send a test chat completion through 9Router.

## Verify model availability

Do not trust the five legacy IDs blindly — they mirrored the old server and
upstream support may change. The source of truth is live:

```bash
curl -s https://YOUR-PROJECT.vercel.app/v1/models
```

Only register IDs that appear there **and** that your configured upstream
(`UPSTREAM_BASE_URL`) actually serves. Requests for anything else return:

```json
{ "error": { "message": "Unknown model: x. Available: ...", "code": "model_not_found" } }
```

## Notes / limits

- If your 9Router version has no custom-provider option, it cannot use this
  proxy — use OpenCode CLI (see `docs/OPENCODE.md`) or another client that
  allows overriding the base URL.
- Streaming works when both 9Router and the upstream support SSE; otherwise
  use `stream: false`.
- Rate limits from the upstream surface as 429 with the upstream message plus
  ` (upstream rate limit)`; configure retries/fallbacks in 9Router.
