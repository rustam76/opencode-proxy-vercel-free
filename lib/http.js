import { getMaxBodyBytes } from "./config.js";

/** Read JSON body with size limit. Works with raw IncomingMessage or pre-parsed bodies. */
export async function readJsonBody(req, limitBytes = getMaxBodyBytes()) {
  if (req.body !== undefined) {
    if (typeof req.body === "object" && req.body !== null) {
      // Vercel may pre-parse JSON.
      const raw = JSON.stringify(req.body);
      if (Buffer.byteLength(raw) > limitBytes) {
        const err = new Error("body-too-large");
        err.code = "BODY_TOO_LARGE";
        throw err;
      }
      return req.body;
    }
    if (typeof req.body === "string") {
      if (Buffer.byteLength(req.body) > limitBytes) {
        const err = new Error("body-too-large");
        err.code = "BODY_TOO_LARGE";
        throw err;
      }
      try {
        return req.body ? JSON.parse(req.body) : {};
      } catch {
        const err = new Error("invalid-json");
        err.code = "INVALID_JSON";
        throw err;
      }
    }
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) {
      const err = new Error("body-too-large");
      err.code = "BODY_TOO_LARGE";
      throw err;
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const err = new Error("invalid-json");
    err.code = "INVALID_JSON";
    throw err;
  }
}

export function sendJson(res, status, obj) {
  const payload = JSON.stringify(obj);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Length", Buffer.byteLength(payload));
  res.end(payload);
}

export function openAIError(res, status, message, type = "invalid_request_error", code = undefined) {
  const error = { message, type };
  if (code) error.code = code;
  sendJson(res, status, { error });
}

export function anthropicError(res, status, type, message) {
  sendJson(res, status, { type: "error", error: { type, message } });
}

export function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-api-key, anthropic-version");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

export function handleOptions(req, res) {
  if (req.method === "OPTIONS") {
    setCors(res);
    res.statusCode = 204;
    res.end();
    return true;
  }
  setCors(res);
  return false;
}

export function requireMethod(req, res, methods, anthropic = false) {
  if (!methods.includes(req.method)) {
    res.setHeader("Allow", methods.join(", "));
    if (anthropic) anthropicError(res, 405, "invalid_request_error", `Method ${req.method} not allowed`);
    else openAIError(res, 405, `Method ${req.method} not allowed`);
    return false;
  }
  return true;
}

export function getClientIp(req) {
  const fwd = req.headers?.["x-forwarded-for"];
  if (typeof fwd === "string" && fwd) return fwd.split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
}

// ── Request validation ──

export function validateChatBody(body, models) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, message: "Request body must be a JSON object" };
  }
  if (!body.model || typeof body.model !== "string") {
    return { ok: false, message: "'model' is required" };
  }
  if (!models.includes(body.model)) {
    return {
      ok: false,
      status: 400,
      message: `Unknown model: ${body.model}. Available: ${models.join(", ")}`,
      code: "model_not_found",
    };
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return { ok: false, message: "'messages' must be a non-empty array" };
  }
  for (const m of body.messages) {
    if (!m || typeof m.role !== "string" || m.content === undefined) {
      return { ok: false, message: "Each message must have 'role' and 'content'" };
    }
  }
  if (body.temperature !== undefined) {
    if (typeof body.temperature !== "number" || body.temperature < 0 || body.temperature > 2) {
      return { ok: false, message: "'temperature' must be a number between 0 and 2" };
    }
  }
  for (const k of ["max_tokens", "max_completion_tokens"]) {
    if (body[k] !== undefined && (!Number.isInteger(body[k]) || body[k] <= 0)) {
      return { ok: false, message: `'${k}' must be a positive integer` };
    }
  }
  if (body.stream !== undefined && typeof body.stream !== "boolean") {
    return { ok: false, message: "'stream' must be a boolean" };
  }
  if (body.tools !== undefined && !Array.isArray(body.tools)) {
    return { ok: false, message: "'tools' must be an array" };
  }
  return { ok: true };
}

export function validateMessagesBody(body, models) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, message: "Request body must be a JSON object" };
  }
  if (!body.model || typeof body.model !== "string") {
    return { ok: false, message: "'model' is required" };
  }
  if (!models.includes(body.model)) {
    return {
      ok: false,
      status: 400,
      message: `Unknown model: ${body.model}. Available: ${models.join(", ")}`,
    };
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return { ok: false, message: "'messages' must be a non-empty array" };
  }
  if (body.max_tokens === undefined || !Number.isInteger(body.max_tokens) || body.max_tokens <= 0) {
    return { ok: false, message: "'max_tokens' must be a positive integer" };
  }
  if (body.system !== undefined && typeof body.system !== "string" && !Array.isArray(body.system)) {
    return { ok: false, message: "'system' must be a string or array" };
  }
  if (body.stream !== undefined && typeof body.stream !== "boolean") {
    return { ok: false, message: "'stream' must be a boolean" };
  }
  if (body.tools !== undefined && !Array.isArray(body.tools)) {
    return { ok: false, message: "'tools' must be an array" };
  }
  return { ok: true };
}
