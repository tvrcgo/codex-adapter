import { Router, type Request, type Response } from "express";
import type { AdapterConfig } from "../config.js";

export function createModelsRouter(config: AdapterConfig): Router {
  const router = Router();

  router.get("/v1/models", (_req: Request, res: Response) => {
    const data = config.backends.map((b) => ({
      id: b.model,
      object: "model",
      created: Math.floor(Date.now() / 1000),
      owned_by: b.name,
      ...(b.maxTokens ? { max_input_tokens: b.maxTokens } : {}),
    }));

    if (data.length === 0) {
      data.push({
        id: "default",
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "internal",
      });
    }

    res.json({ object: "list", data });
  });

  router.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  return router;
}
