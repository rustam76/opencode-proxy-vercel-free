import crypto from "node:crypto";

const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9-_]{4,}/g,
  /oc-[A-Za-z0-9-_]{8,}/g,
  /nvapi-[A-Za-z0-9-_]{4,}/g,
  /Bearer\s+[A-Za-z0-9\-._~+/=]{8,}/gi,
];

/** Redact key-like material from a string for safe logging. */
export function redactSecrets(text) {
  let out = String(text ?? "");
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, "[REDACTED]");
  }
  // Redact generic api-key assignments: "api_key": "value", apiKey=value
  out = out.replace(
    /("(?:api[_-]?key|authorization|x-api-key)"\s*:\s*")[^"]+(")/gi,
    "$1[REDACTED]$2",
  );
  out = out.replace(
    /((?:api[_-]?key|authorization)\s*[:=]\s*)([^\s,};"']{8,})/gi,
    "$1[REDACTED]",
  );
  return out;
}

/**
 * Minimal metadata-only logger. Never logs prompts, message contents,
 * request bodies, or API keys.
 */
export function logSafe(event, fields = {}) {
  const allow = new Set([
    "method",
    "route",
    "model",
    "stream",
    "msgCount",
    "status",
    "upstreamStatus",
    "upstreamMode",
    "reason",
    "durationMs",
  ]);
  const safe = {};
  for (const [k, v] of Object.entries(fields)) {
    if (allow.has(k)) safe[k] = v;
  }
  const line = `[${event}] ${JSON.stringify(safe)}`;
  console.log(redactSecrets(line));
}

export function requestId(prefix) {
  const ts = Date.now().toString(16);
  const rnd = crypto.randomBytes(12).toString("base64url").slice(0, 16);
  return `${prefix}_${ts}${rnd}`;
}
