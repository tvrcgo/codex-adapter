import express from "express";
import { loadConfig } from "./config.js";
import { setLogLevel, logger } from "./utils/logger.js";
import { createResponsesRouter } from "./routes/responses.js";
import { createModelsRouter } from "./routes/models.js";

const configPath = process.argv[2] || undefined;
const config = loadConfig(configPath);
setLogLevel(config.logLevel ?? "info");

const app = express();
app.use(express.json({ limit: "10mb" }));

app.use(createResponsesRouter(config));
app.use(createModelsRouter(config));

app.listen(config.port, () => {
  logger.info(`codex-adapter listening on http://localhost:${config.port}`);
  logger.info(`Backend: ${config.backend.baseUrl}`);
  if (config.backend.model) {
    logger.info(`Default model: ${config.backend.model}`);
  }
});
