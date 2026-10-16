import { getUpstreamMode } from "./config.js";
import { joinUpstreamUrl } from "./url-safety.js";
import { requestId } from "./log.js";

export const OC_VERSION = "1.15.0";
export const ZEN_HOST_URL = "https://opencode.ai";
export const ZEN_PATH = "/zen/v1/chat/completions";

/**
 * Clean adapter interface for upstream chat completions.
 *
 * Official mode (recommended): forwards to an authorized OpenAI-compatible
 * endpoint configured via UPSTREAM_BASE_URL + UPSTREAM_API_KEY.
 *
 * Zen-legacy mode (unsupported): preserves the original reverse-engineered
 * transport (Bearer public + x-opencode-* headers) for analysis only.
 * Gate with ALLOW_ZEN_LEGACY=true. Do not expand this mechanism.
 */
export function buildUpstreamRequest({ model, messages, stream, tools, tool_choice, sessionId }) {
  const mode = getUpstreamMode();
  const body = JSON.stringify({
    model,
    messages,
    stream: !!stream,
    ...(tools?.length ? { tools } : {}),
    ...(tool_choice ? { tool_choice } : {}),
  });

  if (mode === "official") {
    const base = process.env.UPSTREAM_BASE_URL.trim();
    const url = joinUpstreamUrl(base, "/chat/completions");
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.UPSTREAM_API_KEY || ""}`,
    };
    return { mode, url, headers, body };
  }

  if (mode === "zen-legacy") {
    const sid = sessionId || requestId("ses");
    const rid = requestId("msg");
    return {
      mode,
      url: ZEN_HOST_URL + ZEN_PATH,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(Buffer.byteLength(body)),
        Authorization: "Bearer public",
        "User-Agent": `opencode/${OC_VERSION} ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.13`,
        "x-opencode-client": "cli",
        "x-opencode-project": "global",
        "x-opencode-request": rid,
        "x-opencode-session": sid,
      },
      body,
    };
  }

  const err = new Error("upstream-not-configured");
  err.code = "UPSTREAM_NOT_CONFIGURED";
  err.detail =
    "Set UPSTREAM_BASE_URL and UPSTREAM_API_KEY for an authorized OpenAI-compatible upstream, " +
    "or set ALLOW_ZEN_LEGACY=true to use the unsupported legacy Zen transport.";
  throw err;
}

/** Perform upstream fetch with timeout; caller streams or buffers the body. */
export async function fetchUpstream({ url, headers, body }, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: ctrl.signal,
    });
    return res;
  } finally {
    clearTimeout(t);
  }
}
