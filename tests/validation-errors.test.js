import test from "node:test";
import assert from "node:assert/strict";
import chatHandler from "../api/v1/chat/completions.js";
import messagesHandler from "../api/v1/messages.js";
import { mockReq, mockRes, withEnv, jsonResponse } from "./helpers.js";
import { validateChatBody, validateMessagesBody } from "../lib/http.js";

const ENV = {
  PROXY_API_KEY: "test-key",
  UPSTREAM_BASE_URL: "https://api.example.com/v1",
  UPSTREAM_API_KEY: "up-key",
  MODELS: "m1,m2",
  RATE_LIMIT_PER_MINUTE: "0",
};

test("validateChatBody rejects invalid bodies", () => {
  assert.equal(validateChatBody(null, ["m1"]).ok, false);
  assert.equal(validateChatBody({ messages: [] }, ["m1"]).ok, false);
  assert.equal(validateChatBody({ model: "nope", messages: [{ role: "user", content: "x" }] }, ["m1"]).ok, false);
  assert.equal(validateChatBody({ model: "m1", messages: "x" }, ["m1"]).ok, false);
  assert.equal(validateChatBody({ model: "m1", messages: [{ role: "user", content: "x" }], temperature: 5 }, ["m1"]).ok, false);
  assert.equal(validateChatBody({ model: "m1", messages: [{ role: "user", content: "x" }] }, ["m1"]).ok, true);
});

test("validateMessagesBody requires max_tokens", () => {
  assert.equal(
    validateMessagesBody({ model: "m1", messages: [{ role: "user", content: "x" }] }, ["m1"]).ok,
    false,
  );
  assert.equal(
    validateMessagesBody({ model: "m1", messages: [{ role: "user", content: "x" }], max_tokens: 10 }, ["m1"]).ok,
    true,
  );
});

test("unsupported model ID returns 400 with available list (OpenAI)", async () => {
  await withEnv(ENV, async () => {
    const req = mockReq({
      method: "POST",
      headers: { authorization: "Bearer test-key" },
      body: { model: "nope", messages: [{ role: "user", content: "hi" }] },
    });
    const res = mockRes();
    await chatHandler(req, res);
    await res.waitEnd();
    assert.equal(res.statusCode, 400);
    assert.match(res.body, /Available/);
  });
});

test("invalid request body returns 400 (OpenAI)", async () => {
  await withEnv(ENV, async () => {
    const req = mockReq({
      method: "POST",
      headers: { authorization: "Bearer test-key" },
      body: { model: "m1", messages: [] },
    });
    const res = mockRes();
    await chatHandler(req, res);
    await res.waitEnd();
    assert.equal(res.statusCode, 400);
  });
});

test("unsupported model ID returns 400 Anthropic shape", async () => {
  await withEnv(ENV, async () => {
    const req = mockReq({
      method: "POST",
      headers: { "x-api-key": "test-key" },
      body: { model: "nope", messages: [{ role: "user", content: "hi" }], max_tokens: 10 },
    });
    const res = mockRes();
    await messagesHandler(req, res);
    await res.waitEnd();
    assert.equal(res.statusCode, 400);
    const data = JSON.parse(res.body);
    assert.equal(data.type, "error");
    assert.equal(data.error.type, "invalid_request_error");
  });
});

test("invalid JSON body returns 400", async () => {
  await withEnv(ENV, async () => {
    const req = mockReq({
      method: "POST",
      headers: { authorization: "Bearer test-key", "content-type": "application/json" },
      rawBody: "{not-json",
    });
    req.body = undefined;
    const res = mockRes();
    await chatHandler(req, res);
    await res.waitEnd();
    assert.equal(res.statusCode, 400);
  });
});

test("wrong method returns 405", async () => {
  await withEnv(ENV, async () => {
    const req = mockReq({ method: "GET", headers: { authorization: "Bearer test-key" } });
    const res = mockRes();
    await chatHandler(req, res);
    await res.waitEnd();
    assert.equal(res.statusCode, 405);
  });
});

test("upstream error propagates with status mapping", async () => {
  await withEnv(ENV, async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = async () =>
      jsonResponse({ error: { message: "upstream exploded", type: "server_error" } }, 500);
    try {
      const req = mockReq({
        method: "POST",
        headers: { authorization: "Bearer test-key" },
        body: { model: "m1", messages: [{ role: "user", content: "hi" }] },
      });
      const res = mockRes();
      await chatHandler(req, res);
      await res.waitEnd();
      assert.equal(res.statusCode, 502);
      assert.match(res.body, /upstream exploded/);
    } finally {
      globalThis.fetch = orig;
    }
  });
});

test("upstream 429 propagates as 429", async () => {
  await withEnv(ENV, async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = async () => jsonResponse({ error: { message: "slow down" } }, 429);
    try {
      const req = mockReq({
        method: "POST",
        headers: { authorization: "Bearer test-key" },
        body: { model: "m1", messages: [{ role: "user", content: "hi" }] },
      });
      const res = mockRes();
      await chatHandler(req, res);
      await res.waitEnd();
      assert.equal(res.statusCode, 429);
    } finally {
      globalThis.fetch = orig;
    }
  });
});
