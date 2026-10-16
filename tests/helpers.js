import { Readable } from "node:stream";

/** Minimal mock of Vercel Node req/res. */
export function mockReq({ method = "GET", headers = {}, body = undefined, rawBody = null } = {}) {
  const req = new Readable({ read() {} });
  req.method = method;
  req.headers = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  req.socket = { remoteAddress: "127.0.0.1" };
  if (body !== undefined) req.body = body;
  if (rawBody !== null) {
    process.nextTick(() => {
      req.push(rawBody);
      req.push(null);
    });
  } else if (body === undefined) {
    process.nextTick(() => req.push(null));
  }
  return req;
}

export function mockRes() {
  const chunks = [];
  const res = {
    statusCode: 200,
    headers: {},
    headersSent: false,
    body: null,
    chunks,
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
    },
    getHeader(k) {
      return this.headers[k.toLowerCase()];
    },
    writeHead(status, h = {}) {
      this.statusCode = status;
      for (const [k, v] of Object.entries(h)) this.setHeader(k, v);
      this.headersSent = true;
    },
    flushHeaders() {
      this.headersSent = true;
    },
    write(c) {
      chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c)));
      this.headersSent = true;
      return true;
    },
    end(c) {
      if (c) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c)));
      this.headersSent = true;
      this.body = Buffer.concat(chunks).toString("utf8");
      if (this._resolve) this._resolve();
      return this;
    },
    flush() {},
    finished(done) {
      if (this.body !== null) done();
      else this._resolve = done;
    },
  };
  res.waitEnd = () => new Promise((resolve) => {
    if (res.body !== null) resolve(res);
    else res._resolve = () => resolve(res);
  });
  return res;
}

/** Build a fetch Response with SSE text body. */
export function sseResponse(text, status = 200) {
  return new Response(text, {
    status,
    headers: { "Content-Type": "text/event-stream" },
  });
}

export function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function withEnv(env, fn) {
  const prev = { ...process.env };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(process.env)) {
      if (!(k in prev)) delete process.env[k];
    }
    Object.assign(process.env, prev);
  }
}
