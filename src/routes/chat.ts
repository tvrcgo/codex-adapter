import { Router, type Request, type Response } from "express";
import type { AdapterConfig } from "../config.js";
import { resolveBackend } from "../config.js";
import { nextRequestId, buildBackendHeaders, fetchBackend } from "../utils/backend.js";
import { logger } from "../utils/logger.js";
import type { ChatCompletionsRequest } from "../transform/types.js";

export function createChatRouter(config: AdapterConfig): Router {
  const router = Router();

  router.post("/v1/chat/completions", async (req: Request, res: Response) => {
    const rid = nextRequestId();
    const body = req.body as ChatCompletionsRequest;

    const backend = resolveBackend(config, body.model);
    if (!backend) {
      logger.error(`[R${rid}] No backend configured for model=${body.model}`);
      res.status(400).json({
        error: {
          message: `No backend configured for model "${body.model}". Available: ${config.backends.flatMap((b) => b.models).join(", ")}`,
          type: "invalid_request_error",
        },
      });
      return;
    }

    logger.info(`[R${rid}] >>> /v1/chat/completions model=${body.model} backend=${backend.name}`);

    const backendUrl = backend.url;
    const headers = buildBackendHeaders(req, backend);

    const result = await fetchBackend(backendUrl, headers, body, `R${rid}`);

    if (!result.ok) {
      const errorBody = result.message;
      let statusCode = result.status ?? 502;
      let errorResponse: unknown;

      try {
        errorResponse = JSON.parse(errorBody);
        if (errorResponse && typeof errorResponse === "object" && "error" in errorResponse) {
          res.status(statusCode).json(errorResponse);
          return;
        }
      } catch {
        // Not JSON, send as text
      }

      res.status(statusCode).json({
        error: {
          message: errorBody || `Backend error: ${statusCode}`,
          type: "upstream_error",
        },
      });
      return;
    }

    const upstream = result.response;

    for (const [key, value] of Object.entries(upstream.headers)) {
      if (key === "transfer-encoding") continue;
      res.setHeader(key, value);
    }

    res.status(upstream.status);

    if (!upstream.body) {
      res.end();
      return;
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(decoder.decode(value, { stream: true }));
      }
    } catch (err) {
      logger.error(`[R${rid}] Stream error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      reader.releaseLock();
    }

    res.end();
    logger.info(`[R${rid}] <<< /v1/chat/completions Completed: ${upstream.status}`);
  });

  return router;
}
