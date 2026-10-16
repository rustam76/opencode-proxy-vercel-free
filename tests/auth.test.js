import test from "node:test";
import assert from "node:assert/strict";
import { authenticate, extractToken } from "../lib/auth.js";
import { mockReq, withEnv } from "./helpers.js";
import chatHandler from "../api/v1/chat/completions.js";
import { mockRes } from "./helpers.js";

test("extractToken supports Bearer and x-api-key", () => {
  assert.equal(extractToken({ headers: { authorization: "Bearer abc" } }), "abc");
  assert.equal(extractToken({ headers: { "x-api-key": "xyz" } }), "xyz");
  assert.equal(extractToken({ headers: {} }), "");
});

test("authentication success with PROXY_API_KEY", async () => {
  await withEnv({ PROXY_API_KEY: "secret-1, secret-2" }, async () => {
    assert.equal(authenticate({ headers: { authorization: "Bearer secret-2" } }).ok, true);
    assert.equal(authenticate({ headers: { "x-api-key": "secret-1" } }).ok, true);
  });
});

test("authentication failure with wrong key returns 401 (OpenAI shape)", async () => {
  await withEnv(
    { PROXY_API_KEY: "good-key", UPSTREAM_BASE_URL: undefined, ALLOW_ZEN_LEGACY: undefined, MODELS: "m1" },
    async () => {
      const req = mockReq({
        method: "POST",
        headers: { authorization: "Bearer bad-key", "content-type": "application/json" },
        body: { model: "m1", messages: [{ role: "user", content: "hi" }] },
      });
      const res = mockRes();
      await chatHandler(req, res);
      await res.waitEnd();
      assert.equal(res.statusCode, 401);
      const data = JSON.parse(res.body);
      assert.ok(data.error.message.match(/invalid api key/i));
    },
  );
});

test("missing PROXY_API_KEY returns 500, not a bypass", async () => {
  await withEnv(
    { PROXY_API_KEY: undefined, UPSTREAM_BASE_URL: undefined, ALLOW_ZEN_LEGACY: undefined, MODELS: "m1" },
    async () => {
      const req = mockReq({
        method: "POST",
        headers: { authorization: "Bearer anything" },
        body: { model: "m1", messages: [{ role: "user", content: "hi" }] },
      });
      const res = mockRes();
      await chatHandler(req, res);
      await res.waitEnd();
      assert.equal(res.statusCode, 500);
      assert.match(res.body, /PROXY_API_KEY/);
    },
  );
});

test("missing upstream config returns 500 with guidance", async () => {
  await withEnv(
    { PROXY_API_KEY: "k", UPSTREAM_BASE_URL: undefined, ALLOW_ZEN_LEGACY: undefined, MODELS: "m1" },
    async () => {
      const req = mockReq({
        method: "POST",
        headers: { authorization: "Bearer k" },
        body: { model: "m1", messages: [{ role: "user", content: "hi" }] },
      });
      const res = mockRes();
      await chatHandler(req, res);
      await res.waitEnd();
      assert.equal(res.statusCode, 500);
      assert.match(res.body.toLowerCase(), /upstream/);
    },
  );
});
