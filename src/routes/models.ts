import { Router, type Request, type Response } from "express";
import type { AdapterConfig } from "../config.js";

export function createModelsRouter(config: AdapterConfig): Router {
  const router = Router();

  router.get("/v1/models", (_req: Request, res: Response) => {
    const modelIds = config.models?.length
      ? config.models
      : config.backend.model
        ? [config.backend.model]
        : ["default"];

    const data = modelIds.map((id) => ({
      id,
      object: "model",
      created: Math.floor(Date.now() / 1000),
      owned_by: "internal",
      ...(config.backend.maxTokens
        ? { max_input_tokens: config.backend.maxTokens }
        : {}),
    }));

    res.json({ object: "list", data });
  });

  router.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  return router;
}
