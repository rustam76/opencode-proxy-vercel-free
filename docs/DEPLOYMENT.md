# Deployment (GitHub + Vercel)

## 1. Push to GitHub

```bash
git add -A
git commit -m "Migrate to Vercel serverless functions"
git push origin main
```

Never commit `.env`, `api-keys.json`, or real keys. `.gitignore` already covers
`node_modules/`, `api-keys.json`, `*.log`, `.env`.

## 2. Import into Vercel

1. https://vercel.com/new → import the repo.
2. Framework preset: **Other**. Root directory: repo root.
3. Node.js runtime: 18+ (22 works).
4. Deploy once (it will boot, but return 500s until env vars are set — expected).

## 3. Configure environment variables

Vercel Dashboard → Project → **Settings → Environment Variables**.
Add for **Production** (and Preview if you test there):

| Name | Value (example placeholder) |
|---|---|
| `PROXY_API_KEY` | a long random secret, e.g. output of `openssl rand -hex 32` |
| `UPSTREAM_BASE_URL` | `https://api.your-provider.com/v1` |
| `UPSTREAM_API_KEY` | your authorized upstream key |
| `MODELS` | `model-id-a,model-id-b` (must match upstream) |
| `ALLOW_ZEN_LEGACY` | leave unset/`false` unless you opt into the unsupported path |

Generate a proxy secret locally (never paste real keys into chat/logs):

```bash
openssl rand -hex 32
```

Multiple clients can share one key (personal use) or use comma-separated keys:

```
PROXY_API_KEY=key-for-laptop,key-for-desktop
```

Redeploy after changing env vars (or use **Redeploy** in the dashboard).

> Do **not** set `ALLOW_ZEN_LEGACY=true` alongside real credentials thinking it
> adds models — it switches to the unsupported reverse-engineered transport and
> is preserved for analysis only.

## 4. Verify routes

Replace `YOUR-PROJECT` with your deployment URL:

```bash
BASE=https://YOUR-PROJECT.vercel.app

curl -s $BASE/health | head -c 500; echo
curl -s $BASE/v1/models | head -c 500; echo

# Auth failure must be 401 (proves no open relay):
curl -s -o /dev/null -w "%{http_code}\n" -X POST $BASE/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"x","messages":[]}'

# Auth success (non-streaming):
curl -s $BASE/v1/chat/completions \
  -H "Authorization: Bearer $PROXY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"<id-from-/v1/models>","messages":[{"role":"user","content":"Say ok"}]}' \
  | head -c 500; echo

# Anthropic shape:
curl -s $BASE/v1/messages \
  -H "x-api-key: $PROXY_API_KEY" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"<id-from-/v1/models>","max_tokens":64,"messages":[{"role":"user","content":"Say ok"}]}' \
  | head -c 500; echo
```

Expected: `/health` and `/v1/models` are public; both `POST` routes require the
proxy key; unknown models return 400 listing available models; upstream outages
return 502 (or 429 on rate limits) with the upstream message preserved.

## 5. No actual deployment was verified by the agent

Nothing here was deployed during development. The first real deployment and the
`curl` checks above are manual tasks for you.
