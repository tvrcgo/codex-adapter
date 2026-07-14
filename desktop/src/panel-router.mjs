import { Router } from "express";

const startTime = Date.now();

export function createPanelRouter(config) {
  const router = Router();

  router.get("/panel/status", (_req, res) => {
    res.json({
      running: true,
      port: config.port,
      uptime: Date.now() - startTime,
      backends: config.backends.map((b) => ({
        name: b.name,
        models: b.models,
        url: b.url,
      })),
    });
  });

  return router;
}
