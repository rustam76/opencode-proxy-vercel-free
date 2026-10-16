import test from "node:test";
import assert from "node:assert/strict";
import chatHandler from "../api/v1/chat/completions.js";
import messagesHandler from "../api/v1/messages.js";
import { mockReq, mockRes, withEnv, jsonResponse, sseResponse } from "./helpers.js";
import { anthropicToOpenAI, openAIToAnthropic, translateOpenAIDelta, newAnthropicStreamState } from "../lib/convert.js";

const ENV = {
  PROXY_API_KEY: "test-key",
  UPSTREAM_BASE_URL: "https://api.example.com/v1",
  UPSTREAM_API_KEY: "up-key",
  MODELS: "m1",
  RATE_LIMIT_PER_MINUTE: "0",
};

test("non-streaming chat returns upstream JSON passthrough", async () => {
  await withEnv(ENV, async () => {
    const upstreamBody = {
      id: "chatcmpl-1",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 1 },
    };
    const orig = globalThis.fetch;
    let seenUrl = "";
    let seenAuth = "";
    globalThis.fetch = async (url, opts) => {
      seenUrl = String(url);
      seenAuth = opts.headers.Authorization;
      return jsonResponse(upstreamBody, 200);
    };
    try {
      const req = mockReq({
        method: "POST",
        headers: { authorization: "Bearer test-key" },
        body: { model: "m1", messages: [{ role: "user", content: "hi" }] },
      });
      const res = mockRes();
      await chatHandler(req, res);
      await res.waitEnd();
      assert.equal(res.statusCode, 200);
      assert.deepEqual(JSON.parse(res.body), upstreamBody);
      assert.match(seenUrl, /api\.example\.com/);
      assert.match(seenAuth, /Bearer up-key/);
      // Proxy key must never be forwarded upstream.
      assert.doesNotMatch(seenAuth, /test-key/);
    } finally {
      globalThis.fetch = orig;
    }
  });
});

test("streaming chat pipes SSE chunks without buffering whole response", async () => {
  await withEnv(ENV, async () => {
    const sse =
      `data: {"choices":[{"delta":{"content":"hel"}}]}\n\n` +
      `data: {"choices":[{"delta":{"content":"lo"}}]}\n\n` +
      `data: [DONE]\n\n`;
    const orig = globalThis.fetch;
    globalThis.fetch = async () => sseResponse(sse, 200);
    try {
      const req = mockReq({
        method: "POST",
        headers: { authorization: "Bearer test-key" },
        body: { model: "m1", messages: [{ role: "user", content: "hi" }], stream: true },
      });
      const res = mockRes();
      await chatHandler(req, res);
      await res.waitEnd();
      assert.equal(res.statusCode, 200);
      assert.match(res.headers["content-type"], /text\/event-stream/);
      assert.match(res.body, /hel/);
      assert.match(res.body, /lo/);
    } finally {
      globalThis.fetch = orig;
    }
  });
});

test("anthropic non-streaming converts OpenAI response", async () => {
  await withEnv(ENV, async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = async () =>
      jsonResponse({
        choices: [{ message: { role: "assistant", content: "hey" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 4, completion_tokens: 1 },
      });
    try {
      const req = mockReq({
        method: "POST",
        headers: { "x-api-key": "test-key" },
        body: { model: "m1", messages: [{ role: "user", content: "hi" }], max_tokens: 16 },
      });
      const res = mockRes();
      await messagesHandler(req, res);
      await res.waitEnd();
      assert.equal(res.statusCode, 200);
      const data = JSON.parse(res.body);
      assert.equal(data.type, "message");
      assert.equal(data.content[0].text, "hey");
      assert.equal(data.stop_reason, "end_turn");
    } finally {
      globalThis.fetch = orig;
    }
  });
});

test("anthropic streaming translates OpenAI deltas to Anthropic events", async () => {
  await withEnv(ENV, async () => {
    const sse =
      `data: {"choices":[{"delta":{"content":"hi"}}]}\n\n` +
      `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n`;
    const orig = globalThis.fetch;
    globalThis.fetch = async () => sseResponse(sse, 200);
    try {
      const req = mockReq({
        method: "POST",
        headers: { "x-api-key": "test-key" },
        body: { model: "m1", messages: [{ role: "user", content: "hi" }], max_tokens: 16, stream: true },
      });
      const res = mockRes();
      await messagesHandler(req, res);
      await res.waitEnd();
      assert.equal(res.statusCode, 200);
      assert.match(res.body, /message_start/);
      assert.match(res.body, /content_block_delta/);
      assert.match(res.body, /message_stop/);
    } finally {
      globalThis.fetch = orig;
    }
  });
});

test("anthropicToOpenAI maps system/tools/tool_result", () => {
  const { messages, tools } = anthropicToOpenAI({
    system: "sys",
    messages: [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "fn", input: { a: 1 } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
    ],
    tools: [{ name: "fn", description: "d", input_schema: { type: "object" } }],
  });
  assert.equal(messages[0].role, "system");
  assert.ok(messages[2].tool_calls);
  assert.equal(messages[3].role, "tool");
  assert.equal(tools[0].function.name, "fn");
});

test("openAIToAnthropic maps tool_calls to tool_use with tool_use stop reason", () => {
  const out = openAIToAnthropic(
    {
      choices: [
        {
          message: {
            content: null,
            tool_calls: [{ id: "tc1", function: { name: "fn", arguments: '{"a":1}' } }],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 2 },
    },
    "m1",
    3,
  );
  assert.equal(out.stop_reason, "tool_use");
  assert.equal(out.content[0].type, "tool_use");
});

test("translateOpenAIDelta emits start/delta/stop sequence", () => {
  const state = newAnthropicStreamState("m1", 5);
  const wires = translateOpenAIDelta({ choices: [{ delta: { content: "hi" } }] }, state);
  assert.ok(wires.join("").includes("message_start"));
  const end = translateOpenAIDelta({ choices: [{ delta: {}, finish_reason: "stop" }] }, state);
  assert.ok(end.join("").includes("message_stop"));
});
