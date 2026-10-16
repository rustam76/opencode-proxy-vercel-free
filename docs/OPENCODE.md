# OpenCode CLI integration

Uses the current OpenCode config schema: a custom provider with
`npm: "@ai-sdk/openai-compatible"`, `options.baseURL`, and an explicit
`models` map. A ready-made file is in `opencode.json.example`.

## Setup (macOS)

1. Copy the example to your OpenCode config:

   ```bash
   # global config:
   cp opencode.json.example ~/.config/opencode/opencode.json
   # then edit baseURL + models (see below)
   ```

   Or merge just the `vercel-proxy` provider into an existing config.

2. Edit:

   ```json
   {
     "$schema": "https://opencode.ai/config.json",
     "provider": {
       "vercel-proxy": {
         "npm": "@ai-sdk/openai-compatible",
         "name": "Vercel Proxy",
         "options": {
           "baseURL": "https://YOUR-PROJECT.vercel.app/v1"
         },
         "models": {
           "deepseek-v4-flash-free": { "name": "DeepSeek V4 Flash (proxy)" }
         }
       }
     }
   }
   ```

   - `baseURL` must be `https://YOUR-PROJECT.vercel.app/v1` (with `/v1`).
   - Keep only model IDs returned by `GET https://YOUR-PROJECT.vercel.app/v1/models`.
   - No obsolete fields are used (no top-level `type: "openai"`, `apiKey`, or
     `baseURL` outside `options`).

3. Authenticate with the **proxy** secret (not the upstream key):

   ```bash
   export OPENCODE_VERCE_PROXY_API_KEY="<PROXY_API_KEY>"
   # or run /connect in the TUI and paste the proxy key when prompted
   ```

   The provider reads credentials from the environment or `auth.json`; the
   exact env var name follows `<provider-id>_API_KEY` upper-cased with dashes
   → underscores. `/connect` is the simplest path if unsure.

4. Select the model:

   ```
   /models
   ```

   Pick `vercel-proxy / <model-id>`. Send a test prompt; a 401 means the proxy
   key is wrong, a 400 `model_not_found` means the ID isn't in `/v1/models`, a
   429/502 means the upstream is throttling or down (see TROUBLESHOOTING).

## Notes

- `attachment`/`reasoning` flags from old configs are optional model
  capabilities — add them only if the model actually supports them.
- Streaming and tool calls depend on the upstream; failures propagate as
  OpenAI-style errors rather than fake successes.
