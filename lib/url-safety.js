/**
 * Validate that a base URL is safe to use as an upstream target.
 * Prevents SSRF to metadata endpoints and non-HTTP(S) schemes.
 */
export function validateUpstreamBaseUrl(raw) {
  if (!raw || typeof raw !== "string") return { ok: false, reason: "missing" };
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: "invalid-url" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "protocol-must-be-http-or-https" };
  }
  if (url.username || url.password) {
    return { ok: false, reason: "credentials-in-url-not-allowed" };
  }
  const host = url.hostname.toLowerCase();
  if (!host) return { ok: false, reason: "missing-host" };
  const blocked = new Set([
    "169.254.169.254",
    "metadata.google.internal",
    "metadata.google",
    "instance-data",
  ]);
  if (blocked.has(host)) return { ok: false, reason: "blocked-host" };
  if (host === "localhost") return { ok: true, url: normalizeBase(url) };
  // Block loopback / link-local / private literal IPs best-effort.
  if (/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) {
    return { ok: false, reason: "private-ip-blocked" };
  }
  if (host === "::1" || host === "0.0.0.0") {
    return { ok: false, reason: "blocked-host" };
  }
  return { ok: true, url: normalizeBase(url) };
}

function normalizeBase(url) {
  return url.toString().replace(/\/+$/, "");
}

/** Safely join base + path without allowing path traversal to another host. */
export function joinUpstreamUrl(base, path) {
  const checked = validateUpstreamBaseUrl(base);
  if (!checked.ok) throw new Error(`invalid-upstream-base-url: ${checked.reason}`);
  if (!path.startsWith("/")) throw new Error("upstream-path-must-be-absolute");
  if (path.startsWith("//")) throw new Error("protocol-relative-path-not-allowed");
  if (path.includes("..")) throw new Error("path-traversal-not-allowed");
  // Base already contains any version prefix (e.g. /v1); append the fixed path.
  return checked.url + path;
}
