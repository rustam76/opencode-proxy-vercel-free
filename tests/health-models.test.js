import test from "node:test";
import assert from "node:assert/strict";
import health from "../api/health.js";
import modelsHandler from "../api/v1/models.js";
import { mockReq, mockRes, withEnv } from "./helpers.js";

test("GET /health returns ok with version and endpoints", async () => {
  await withEnv({ MODELS: undefined }, async () => {
    const req = mockReq({ method: "GET" });
    const res = mockRes();
    await health(req, res);
    await res.waitEnd();
    assert.equal(res.statusCode, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.status, "ok");
    assert.match(data.version, /^v\d+/);
    assert.ok(Array.isArray(data.endpoints));
    assert.ok(data.endpoints.includes("/v1/chat/completions"));
  });
});

test("GET /health rejects non-GET methods", async () => {
  const req = mockReq({ method: "POST" });
  const res = mockRes();
  await health(req, res);
  await res.waitEnd();
  assert.equal(res.statusCode, 405);
});

test("GET /v1/models returns configured MODELS env, not hardcoded-only", async () => {
  await withEnv({ MODELS: "alpha,beta" }, async () => {
    const req = mockReq({ method: "GET" });
    const res = mockRes();
    await modelsHandler(req, res);
    await res.waitEnd();
    const data = JSON.parse(res.body);
    assert.equal(data.object, "list");
    assert.deepEqual(data.data.map((m) => m.id), ["alpha", "beta"]);
  });
});

test("GET /v1/models defaults to built-in list", async () => {
  await withEnv({ MODELS: undefined }, async () => {
    const req = mockReq({ method: "GET" });
    const res = mockRes();
    await modelsHandler(req, res);
    await res.waitEnd();
    const data = JSON.parse(res.body);
    assert.ok(data.data.length >= 1);
  });
});
