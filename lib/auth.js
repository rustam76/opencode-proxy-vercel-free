import { getProxyKeys, keysEqual } from "./config.js";

/** Extract bearer token from Authorization or x-api-key headers. */
export function extractToken(req) {
  const headers = req.headers || {};
  const auth = headers.authorization || headers.Authorization || "";
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  const xKey = headers["x-api-key"] || headers["X-Api-Key"] || headers["X-API-Key"];
  if (typeof xKey === "string" && xKey.trim()) return xKey.trim();
  return "";
}

/** Validate request against PROXY_API_KEY list. Returns { ok, keyIndex }. */
export function authenticate(req) {
  const keys = getProxyKeys();
  if (keys.length === 0) return { ok: false, reason: "missing-env" };
  const tok = extractToken(req);
  if (!tok) return { ok: false, reason: "missing-token" };
  for (let i = 0; i < keys.length; i++) {
    if (keysEqual(tok, keys[i])) return { ok: true, keyIndex: i };
  }
  return { ok: false, reason: "invalid-token" };
}
