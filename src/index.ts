import express from "express";
import type { AdapterConfig } from "./config.js";
import { createResponsesRouter } from "./routes/responses.js";
import { createModelsRouter } from "./routes/models.js";
import { createAnthropicRouter } from "./routes/anthropic.js";
import { createChatRouter } from "./routes/chat.js";

export function createApp(config: AdapterConfig): express.Application {
  const app = express();
  app.use(express.json({ limit: "10mb" }));

  app.use(createResponsesRouter(config));
  app.use(createModelsRouter(config));
  app.use(createAnthropicRouter(config));
  app.use(createChatRouter(config));

  return app;
}
