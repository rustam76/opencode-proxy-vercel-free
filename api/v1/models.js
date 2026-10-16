import { getModels } from "../../lib/config.js";
import { handleOptions, requireMethod, sendJson, setCors } from "../../lib/http.js";

/** GET /v1/models — returns the actual configured models. */
export default async function handler(req, res) {
  setCors(res);
  if (handleOptions(req, res)) return;
  if (!requireMethod(req, res, ["GET"])) return;
  const models = getModels();
  sendJson(res, 200, {
    object: "list",
    data: models.map((id) => ({
      id,
      object: "model",
      created: 1779000000,
      owned_by: "opencode-free",
    })),
  });
}
