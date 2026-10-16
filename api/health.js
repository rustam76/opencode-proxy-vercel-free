import { PROXY_VERSION, getModels, getUpstreamMode } from "../lib/config.js";
import { handleOptions, requireMethod, sendJson, setCors } from "../lib/http.js";

export default async function handler(req, res) {
  setCors(res);
  if (handleOptions(req, res)) return;
  if (!requireMethod(req, res, ["GET"])) return;
  const models = getModels();
  sendJson(res, 200, {
    status: "ok",
    version: `v${PROXY_VERSION}`,
    models: models.length,
    upstreamMode: getUpstreamMode(),
    endpoints: ["/v1/chat/completions", "/v1/messages", "/v1/models"],
  });
}
