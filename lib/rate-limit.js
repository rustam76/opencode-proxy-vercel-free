import { getRateLimitPerMinute } from "./config.js";

/**
 * Best-effort per-instance fixed-window rate limiter.
 *
 * Serverless instances do not share memory, so this only protects a single
 * warm instance. For production abuse protection, put an external rate
 * limiter (Vercel Firewall, Upstash Redis, Cloudflare) in front.
 */
const buckets = new Map();

export function checkRateLimit(ip, now = Date.now()) {
  const limit = getRateLimitPerMinute();
  if (limit <= 0) return { allowed: true };
  const windowMs = 60_000;
  let b = buckets.get(ip);
  if (!b || now >= b.reset) {
    b = { count: 0, reset: now + windowMs };
    buckets.set(ip, b);
  }
  b.count += 1;
  if (b.count > limit) {
    return { allowed: false, retryAfterSec: Math.ceil((b.reset - now) / 1000) };
  }
  return { allowed: true, remaining: limit - b.count };
}

export function _resetRateLimitState() {
  buckets.clear();
}
