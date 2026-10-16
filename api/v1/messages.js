import { getModels, getUpstreamMode, getUpstreamTimeoutMs } from "../../lib/config.js";
import { authenticate } from "../../lib/auth.js";
import { buildUpstreamRequest, fetchUpstream } from "../../lib/upstream.js";
import {
  anthropicToOpenAI,
  newAnthropicStreamState,
  openAIToAnthropic,
  translateOpenAIDelta,
} from "../../lib/convert.js";
import {
  anthropicError,
  getClientIp,
  handleOptions,
  readJsonBody,
  requireMethod,
  sendJson,
  setCors,
  validateMessagesBody,
} from "../../lib/http.js";
import { checkRateLimit } from "../../lib/rate-limit.js";
import { logSafe, requestId } from "../../lib/log.js";

async function pipeAsAnthropic(upstreamRes, res, model, inputTokens) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  const state = newAnthropicStreamState(model, inputTokens);
  const reader = upstreamRes.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let firstChunkChecked = false;
  let errorSent = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (!firstChunkChecked) {
        firstChunkChecked = true;
        const trimmed = buffer.trim();
        if (
          trimmed.startsWith("{") &&
          (trimmed.includes("FreeUsageLimitError") || trimmed.includes('"error"'))
        ) {
          try {
            const parsed = JSON.parse(trimmed);
            if (parsed.error || parsed.type === "error") {
              errorSent = true;
              // Headers already sent as 200 SSE; report as Anthropic error event then close.
              const msg = parsed.error?.message || parsed.message || "Rate limit";
              res.write(
                `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: msg + " (upstream rate limit)" } })}\n\n`,
              );
              res.end();
              return;
            }
          } catch {
            /* not JSON — continue as SSE */
          }
        }
      }
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6).trim();
        if (payload === "[DONE]") continue;
        let parsed;
        try {
          parsed = JSON.parse(payload);
        } catch {
          continue;
        }
        for (const wire of translateOpenAIDelta(parsed, state)) {
          res.write(wire);
        }
      }
    }
    res.write(decoder.decode());
    // Flush any trailing line.
    if (buffer.startsWith("data: ")) {
      const payload = buffer.slice(6).trim();
      if (payload && payload !== "[DONE]") {
        try {
          const parsed = JSON.parse(payload);
          for (const wire of translateOpenAIDelta(parsed, state)) res.write(wire);
        } catch {
          /* ignore */
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (!errorSent) res.end();
}

export default async function handler(req, res) {
  setCors(res);
  if (handleOptions(req, res)) return;
  if (!requireMethod(req, res, ["POST"], true)) return;
  const started = Date.now();

  const ip = getClientIp(req);
  const rl = checkRateLimit(ip);
  if (!rl.allowed) {
    res.setHeader("Retry-After", String(rl.retryAfterSec));
    return anthropicError(res, 429, "rate_limit_error", "Rate limit exceeded");
  }

  const auth = authenticate(req);
  if (!auth.ok) {
    if (auth.reason === "missing-env") {
      logSafe("auth", { method: "POST", route: "/v1/messages", status: 500, reason: "missing-env" });
      return anthropicError(res, 500, "server_error", "Server misconfigured: PROXY_API_KEY is not set");
    }
    logSafe("auth", { method: "POST", route: "/v1/messages", status: 401, reason: auth.reason });
    return anthropicError(res, 401, "authentication_error", "Invalid API key");
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    if (e.code === "BODY_TOO_LARGE") return anthropicError(res, 413, "invalid_request_error", "Request body too large");
    return anthropicError(res, 400, "invalid_request_error", "Invalid JSON body");
  }

  const models = getModels();
  const v = validateMessagesBody(body, models);
  if (!v.ok) {
    return anthropicError(res, 400, "invalid_request_error", v.message);
  }

  const { model, stream } = body;
  const { messages, tools } = anthropicToOpenAI(body);
  const inputTokens = Math.floor(JSON.stringify(messages).length / 4);

  logSafe("messages", {
    method: "POST",
    route: "/v1/messages",
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
      tool_choice: undefined,
      sessionId: requestId("ses"),
    });
  } catch (e) {
    if (e.code === "UPSTREAM_NOT_CONFIGURED") {
      return anthropicError(res, 500, "server_error", e.detail);
    }
    return anthropicError(res, 500, "server_error", "Failed to build upstream request");
  }

  let upstreamRes;
  try {
    upstreamRes = await fetchUpstream(upstream, getUpstreamTimeoutMs());
  } catch (e) {
    if (e?.name === "AbortError") return anthropicError(res, 504, "timeout_error", "Upstream timeout");
    return anthropicError(res, 502, "upstream_error", "Upstream error: " + (e?.message || "fetch failed"));
  }

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
      /* non-JSON */
    }
    const msg = parsed?.error?.message || parsed?.message || text.slice(0, 500) || "Upstream error";
    if (upstreamRes.status === 429) {
      return anthropicError(res, 429, "rate_limit_error", msg + " (upstream rate limit)");
    }
    return anthropicError(res, 502, "upstream_error", msg);
  }

  try {
    if (stream) {
      await pipeAsAnthropic(upstreamRes, res, model, inputTokens);
      logSafe("messages", {
        method: "POST",
        route: "/v1/messages",
        model,
        stream: true,
        msgCount: messages.length,
        status: 200,
        durationMs: Date.now() - started,
      });
      return;
    }
    const text = await upstreamRes.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      return anthropicError(res, 502, "upstream_error", "Invalid upstream response");
    }
    if (data?.error || data?.type === "error") {
      const msg = data?.error?.message || data?.message || "Upstream error";
      if (/limit|quota/i.test(msg)) {
        return anthropicError(res, 429, "rate_limit_error", msg + " (upstream rate limit)");
      }
      return anthropicError(res, 502, "upstream_error", msg);
    }
    if (!data?.choices) {
      return anthropicError(res, 502, "upstream_error", "Invalid upstream response");
    }
    sendJson(res, 200, openAIToAnthropic(data, model, inputTokens));
    logSafe("messages", {
      method: "POST",
      route: "/v1/messages",
      model,
      stream: false,
      msgCount: messages.length,
      status: 200,
      durationMs: Date.now() - started,
    });
  } catch (e) {
    if (!res.headersSent) {
      return anthropicError(res, 502, "upstream_error", "Upstream error: " + (e?.message || "stream failed"));
    }
    try {
      res.end();
    } catch {
      /* ignore */
    }
  }
}
