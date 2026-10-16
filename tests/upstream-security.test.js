import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { validateUpstreamBaseUrl, joinUpstreamUrl } from "../lib/url-safety.js";
import { buildUpstreamRequest } from "../lib/upstream.js";
import { redactSecrets, logSafe } from "../lib/log.js";
import { withEnv } from "./helpers.js";
import { getUpstreamMode } from "../lib/config.js";

test("upstream URL validation blocks SSRF vectors", () => {
  assert.equal(validateUpstreamBaseUrl("ftp://example.com").ok, false);
  assert.equal(validateUpstreamBaseUrl("https://user:pass@example.com").ok, false);
  assert.equal(validateUpstreamBaseUrl("http://169.254.169.254/").ok, false);
  assert.equal(validateUpstreamBaseUrl("http://127.0.0.1/").ok, false);
  assert.equal(validateUpstreamBaseUrl("https://api.example.com/v1").ok, true);
});

test("joinUpstreamUrl prevents origin escape", () => {
  assert.throws(() => joinUpstreamUrl("https://api.example.com/v1", "//evil.com/x"));
  assert.throws(() => joinUpstreamUrl("https://api.example.com/v1", "https://evil.com/x"));
  assert.equal(
    joinUpstreamUrl("https://api.example.com/v1", "/chat/completions"),
    "https://api.example.com/v1/chat/completions",
  );
});

test("official adapter uses env base + key, never exposes upstream key to client shape", async () => {
  await withEnv(
    { UPSTREAM_BASE_URL: "https://api.example.com/v1/", UPSTREAM_API_KEY: "up-secret", ALLOW_ZEN_LEGACY: undefined },
    async () => {
      assert.equal(getUpstreamMode(), "official");
      const r = buildUpstreamRequest({ model: "m", messages: [], stream: false });
      assert.equal(r.url, "https://api.example.com/v1/chat/completions");
      assert.match(r.headers.Authorization, /up-secret/);
      assert.ok(!("x-opencode-session" in r.headers));
    },
  );
});

test("zen-legacy adapter preserves original headers and is opt-in", async () => {
  await withEnv(
    { UPSTREAM_BASE_URL: undefined, ALLOW_ZEN_LEGACY: "true", UPSTREAM_API_KEY: undefined },
    async () => {
      assert.equal(getUpstreamMode(), "zen-legacy");
      const r = buildUpstreamRequest({ model: "m", messages: [], stream: true });
      assert.equal(r.url, "https://opencode.ai/zen/v1/chat/completions");
      assert.equal(r.headers.Authorization, "Bearer public");
      assert.ok(r.headers["x-opencode-session"]);
    },
  );
});

test("no upstream configured throws with guidance", async () => {
  await withEnv({ UPSTREAM_BASE_URL: undefined, ALLOW_ZEN_LEGACY: undefined }, async () => {
    assert.equal(getUpstreamMode(), "none");
    assert.throws(() => buildUpstreamRequest({ model: "m", messages: [] }), /upstream-not-configured/);
  });
});

test("secret redaction removes keys from logs", () => {
  const raw = 'Authorization: Bearer oc-abcdef1234567890 and key="sk-1234567890abcdef" body=hello';
  const out = redactSecrets(raw);
  assert.doesNotMatch(out, /oc-abcdef/);
  assert.doesNotMatch(out, /sk-1234/);
  assert.match(out, /\[REDACTED\]/);
  assert.match(out, /hello/);
});

test("logSafe never logs message contents", () => {
  const lines = [];
  const orig = console.log;
  console.log = (s) => lines.push(String(s));
  try {
    logSafe("chat", {
      method: "POST",
      route: "/x",
      model: "m",
      prompt: "SECRET PROMPT SHOULD NOT APPEAR",
      messages: [{ content: "SECRET" }],
      apiKey: "oc-supersecretkey123",
    });
  } finally {
    console.log = orig;
  }
  const joined = lines.join("\n");
  assert.doesNotMatch(joined, /SECRET PROMPT/);
  assert.doesNotMatch(joined, /supersecret/);
});

test("vercel.json exposes exact public routes via rewrites", () => {
  const root = new URL("..", import.meta.url);
  const cfg = JSON.parse(fs.readFileSync(new URL("vercel.json", root), "utf8"));
  const map = Object.fromEntries((cfg.rewrites || []).map((r) => [r.source, r.destination]));
  assert.equal(map["/health"], "/api/health");
  assert.equal(map["/v1/models"], "/api/v1/models");
  assert.equal(map["/v1/chat/completions"], "/api/v1/chat/completions");
  assert.equal(map["/v1/messages"], "/api/v1/messages");
  for (const f of ["api/health.js", "api/v1/models.js", "api/v1/chat/completions.js", "api/v1/messages.js"]) {
    assert.ok(fs.existsSync(path.join(new URL(".", root).pathname, f)), f);
  }
});

test(".env.example contains placeholders only, no real secrets", () => {
  const root = new URL("..", import.meta.url);
  const text = fs.readFileSync(new URL(".env.example", root), "utf8");
  for (const k of ["PROXY_API_KEY", "UPSTREAM_BASE_URL", "UPSTREAM_API_KEY"]) {
    assert.match(text, new RegExp(k));
  }
  assert.match(text, /change-me/);
});
