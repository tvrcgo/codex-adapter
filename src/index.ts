import express from "express";
import { loadConfig } from "./config.js";
import { setLogLevel, logger } from "./utils/logger.js";
import { createResponsesRouter } from "./routes/responses.js";
import { createModelsRouter } from "./routes/models.js";
import { createAnthropicRouter } from "./routes/anthropic.js";

const configPath = process.argv[2] || undefined;
const config = loadConfig(configPath);
setLogLevel(config.logLevel ?? "info");

const app = express();
app.use(express.json({ limit: "10mb" }));

app.use(createResponsesRouter(config));
app.use(createModelsRouter(config));
app.use(createAnthropicRouter(config));

app.listen(config.port, () => {
  logger.info(`codex-adapter listening on http://localhost:${config.port}`);
  logger.info(`${config.backends.length} backend(s) configured, default: ${config.defaultBackend}`);
  for (const b of config.backends) {
    logger.info(`  [${b.name}] models=${b.models.join(", ")} url=${b.url}`);
  }
  logger.info(`Routes: /v1/responses, /v1/models, /v1/messages`);
});
