import { getModels, getUpstreamMode, getUpstreamTimeoutMs } from "../../../lib/config.js";
import { authenticate } from "../../../lib/auth.js";
import { buildUpstreamRequest, fetchUpstream } from "../../../lib/upstream.js";
import {
  anthropicError,
  getClientIp,
  handleOptions,
  openAIError,
  readJsonBody,
  requireMethod,
  sendJson,
  setCors,
  validateChatBody,
} from "../../../lib/http.js";
import { checkRateLimit } from "../../../lib/rate-limit.js";
import { logSafe, requestId } from "../../../lib/log.js";

async function pipeSse(upstreamRes, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  if (typeof res.flushHeaders === "function") res.flushHeaders();
  // Stream chunk-by-chunk; never buffer the whole response.
  const reader = upstreamRes.body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // Pass through text; decode streaming to avoid splitting multi-byte chars.
      res.write(Buffer.from(decoder.decode(value, { stream: true })));
    }
    res.write(decoder.decode());
  } finally {
    reader.releaseLock();
  }
  res.end();
}

export default async function handler(req, res) {
  setCors(res);
  if (handleOptions(req, res)) return;
  if (!requireMethod(req, res, ["POST"])) return;
  const started = Date.now();

  const ip = getClientIp(req);
  const rl = checkRateLimit(ip);
  if (!rl.allowed) {
    res.setHeader("Retry-After", String(rl.retryAfterSec));
    return openAIError(res, 429, "Rate limit exceeded", "rate_limit_error", "rate_limit_exceeded");
  }

  const auth = authenticate(req);
  if (!auth.ok) {
    if (auth.reason === "missing-env") {
      logSafe("auth", { method: "POST", route: "/v1/chat/completions", status: 500, reason: "missing-env" });
      return openAIError(res, 500, "Server misconfigured: PROXY_API_KEY is not set", "server_error");
    }
    logSafe("auth", { method: "POST", route: "/v1/chat/completions", status: 401, reason: auth.reason });
    return openAIError(res, 401, "Invalid API key", "authentication_error", "invalid_api_key");
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    if (e.code === "BODY_TOO_LARGE") return openAIError(res, 413, "Request body too large");
    return openAIError(res, 400, "Invalid JSON body");
  }

  const models = getModels();
  const v = validateChatBody(body, models);
  if (!v.ok) {
    const status = v.status || 400;
    return openAIError(res, status, v.message, status === 400 && v.code ? "invalid_request_error" : "invalid_request_error", v.code);
  }

  const { model, messages, stream, tools, tool_choice } = body;
  logSafe("chat", {
    method: "POST",
    route: "/v1/chat/completions",
    model,
    stream: !!stream,
    msgCount: messages.length,
    upstreamMode: getUpstreamMode(),
  });

  let upstream;
  try {
    upstream = buildUpstreamRequest({
      model,
      messages,
      stream,
      tools,
      tool_choice,
      sessionId: requestId("ses"),
    });
  } catch (e) {
    if (e.code === "UPSTREAM_NOT_CONFIGURED") {
      return openAIError(res, 500, e.detail, "server_error");
    }
    return openAIError(res, 500, "Failed to build upstream request", "server_error");
  }

  let upstreamRes;
  try {
    upstreamRes = await fetchUpstream(upstream, getUpstreamTimeoutMs());
  } catch (e) {
    logSafe("upstream", { method: "POST", route: "/v1/chat/completions", model, reason: "fetch-failed", status: 502 });
    if (e?.name === "AbortError") return openAIError(res, 504, "Upstream timeout", "timeout_error");
    return openAIError(res, 502, "Upstream error: " + (e?.message || "fetch failed"), "upstream_error");
  }

  // Detect upstream JSON error on first bytes for non-OK statuses without buffering streams.
  if (!upstreamRes.ok) {
    let text = "";
    try {
      text = await upstreamRes.text();
    } catch {
      text = "";
    }
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* non-JSON upstream error */
    }
    const msg = parsed?.error?.message || parsed?.message || text.slice(0, 500) || "Upstream error";
    const status = upstreamRes.status === 429 ? 429 : upstreamRes.status >= 500 ? 502 : upstreamRes.status;
    logSafe("upstream", {
      method: "POST",
      route: "/v1/chat/completions",
      model,
      status,
      upstreamStatus: upstreamRes.status,
      durationMs: Date.now() - started,
    });
    if (upstreamRes.status === 429) {
      return openAIError(res, 429, msg + " (upstream rate limit)", "rate_limit_error", "rate_limit_exceeded");
    }
    return openAIError(res, status, msg, "upstream_error");
  }

  // Also sniff streaming first-chunk JSON errors (e.g. FreeUsageLimitError) — read
  // only the first chunk, then continue passthrough. Implemented by checking
  // content-type: JSON errors come back as application/json even when stream=true.
  const ctype = upstreamRes.headers.get("content-type") || "";

  try {
    if (stream) {
      if (ctype.includes("application/json")) {
        const text = await upstreamRes.text();
        let parsed = null;
        try {
          parsed = JSON.parse(text.trim());
        } catch {
          /* fall through */
        }
        if (parsed?.error || parsed?.type === "error") {
          const msg = parsed?.error?.message || parsed?.message || "Rate limit exceeded";
          const isRate = /limit|quota|429/i.test(msg) || upstreamRes.status === 429;
          return openAIError(
            res,
            isRate ? 429 : 502,
            msg + (isRate ? " (upstream rate limit)" : ""),
            isRate ? "rate_limit_error" : "upstream_error",
            isRate ? "rate_limit_exceeded" : undefined,
          );
        }
        // Upstream returned JSON for a stream request; forward as SSE-wrapped single event?
        // Preserve original behavior: forward raw JSON with 200 JSON content-type is wrong
        // for SSE clients, so convert to a minimal SSE stream.
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        res.end(`data: ${text}\n\ndata: [DONE]\n\n`);
        return;
      }
      await pipeSse(upstreamRes, res);
      logSafe("chat", {
        method: "POST",
        route: "/v1/chat/completions",
        model,
        stream: true,
        msgCount: messages.length,
        status: 200,
        durationMs: Date.now() - started,
      });
      return;
    }

    // Non-streaming: collect JSON and forward.
    const text = await upstreamRes.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      return openAIError(res, 502, "Invalid upstream response", "upstream_error");
    }
    if (data?.error || data?.type === "error") {
      const msg = data?.error?.message || data?.message || "Upstream error";
      if (upstreamRes.status === 429 || /limit|quota/i.test(msg)) {
        return openAIError(res, 429, msg + " (upstream rate limit)", "rate_limit_error", "rate_limit_exceeded");
      }
      return openAIError(res, 502, msg, "upstream_error");
    }
    if (!data?.choices) {
      return openAIError(res, 502, "Invalid upstream response", "upstream_error");
    }
    sendJson(res, 200, data);
    logSafe("chat", {
      method: "POST",
      route: "/v1/chat/completions",
      model,
      stream: false,
      msgCount: messages.length,
      status: 200,
      durationMs: Date.now() - started,
    });
  } catch (e) {
    if (!res.headersSent) {
      return openAIError(res, 502, "Upstream error: " + (e?.message || "stream failed"), "upstream_error");
    }
    try {
      res.end();
    } catch {
      /* ignore */
    }
  }
}

// Exported for tests (streaming pipe uses Web Streams reader).
export { pipeSse };
