import { Router, type Request, type Response } from "express";
import type { AdapterConfig } from "../config.js";

export function createModelsRouter(config: AdapterConfig): Router {
  const router = Router();

  router.get("/v1/models", (_req: Request, res: Response) => {
    let models = config.backends.flatMap((b) =>
      b.models.map((m) => ({
        id: m,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: b.name,
        type: "model",
        display_name: m.includes("/") ? m.split("/").pop()! : m,
        created_at: new Date().toISOString(),
        ...(b.maxTokens ? { max_input_tokens: b.maxTokens } : {}),
      })),
    );

    if (models.length === 0) {
      models = [{
        id: "default",
        object: "model",
        type: "model",
        created: Math.floor(Date.now() / 1000),
        created_at: new Date().toISOString(),
        owned_by: "internal",
        display_name: "Default Model",
      }];
    }

    res.json({
      object: "list",
      data: models,
      has_more: false,
      first_id: models[0]?.id,
      last_id: models[models.length - 1]?.id,
    });
  });

  router.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  return router;
}
