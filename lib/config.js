import crypto from "node:crypto";

/**
 * Central configuration. All secrets come from environment variables.
 * No filesystem reads, safe for serverless cold starts.
 */

export const DEFAULT_MODELS = [
  "deepseek-v4-flash-free",
  "big-pickle",
  "minimax-m2.5-free",
  "nemotron-3-super-free",
  "qwen3.6-plus-free",
];

export const PROXY_VERSION = "10";

export function getProxyKeys() {
  const raw = process.env.PROXY_API_KEY || "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function hasProxyKeys() {
  return getProxyKeys().length > 0;
}

/**
 * Actual configured models — never a hardcoded unavailable list.
 * Override with MODELS="model-a,model-b".
 */
export function getModels() {
  const raw = process.env.MODELS;
  if (raw && raw.trim()) {
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [...DEFAULT_MODELS];
}

export function getMaxBodyBytes() {
  const v = Number.parseInt(process.env.MAX_BODY_BYTES || "", 10);
  if (Number.isFinite(v) && v > 0 && v <= 10 * 1024 * 1024) return v;
  return 2 * 1024 * 1024;
}

export function getUpstreamTimeoutMs() {
  const v = Number.parseInt(process.env.UPSTREAM_TIMEOUT_MS || "", 10);
  if (Number.isFinite(v) && v > 0 && v <= 55000) return v;
  return 55000;
}

export function getRateLimitPerMinute() {
  const v = Number.parseInt(process.env.RATE_LIMIT_PER_MINUTE || "", 10);
  if (Number.isFinite(v) && v >= 0) return v;
  return 60;
}

/**
 * Upstream mode resolution:
 * - "official" when UPSTREAM_BASE_URL is set (recommended, officially supported).
 * - "zen-legacy" only when ALLOW_ZEN_LEGACY=true (unsupported, reverse-engineered).
 * - "none" otherwise (misconfigured).
 */
export function getUpstreamMode() {
  if (process.env.UPSTREAM_BASE_URL && process.env.UPSTREAM_BASE_URL.trim()) {
    return "official";
  }
  if (process.env.ALLOW_ZEN_LEGACY === "true") return "zen-legacy";
  return "none";
}

export function isZenLegacyEnabled() {
  return getUpstreamMode() === "zen-legacy";
}

/** Timing-safe comparison to avoid leaking key validity via timing. */
export function keysEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  try {
    return crypto.timingSafeEqual(ab, bb);
  } catch {
    return false;
  }
}
