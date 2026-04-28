import { Router, type Request, type Response } from "express";
import type { AdapterConfig } from "../config.js";
import type { ResponsesRequest, ChatCompletionChunk } from "../transform/types.js";
import { transformRequest } from "../transform/request.js";
import { ResponseStreamWriter } from "../transform/response-stream.js";
import { initSSE, parseSSEBuffer } from "../utils/sse.js";
import { logger } from "../utils/logger.js";

let reqCounter = 0;

export function createResponsesRouter(config: AdapterConfig): Router {
  const router = Router();

  router.post("/v1/responses", async (req: Request, res: Response) => {
    try {
      await handleResponses(req, res, config);
    } catch (err) {
      logger.error("Unhandled error in /v1/responses", err);
      if (!res.headersSent) {
        res.status(500).json({
          error: { message: "Internal adapter error", type: "server_error" },
        });
      } else {
        res.end();
      }
    }
  });

  router.get("/v1/responses/:id", (_req: Request, res: Response) => {
    res.status(404).json({
      error: {
        message: "Response storage is not supported by this proxy",
        type: "not_found",
      },
    });
  });

  return router;
}

function encodeHeaderValue(value: string): string {
  if (/^[\x00-\xff]*$/.test(value)) return value;
  return encodeURIComponent(value);
}

async function handleResponses(req: Request, res: Response, config: AdapterConfig): Promise<void> {
  const rid = ++reqCounter;
  const body = req.body as ResponsesRequest;

  const inputSummary = typeof body.input === "string"
    ? `string(${body.input.length})`
    : `array(${Array.isArray(body.input) ? body.input.length : "?"} items)`;

  logger.info(`[R${rid}] >>> model=${body.model} input=${inputSummary} tools=${body.tools?.length ?? 0}`);

  let chatReq;
  try {
    chatReq = transformRequest(body, config);
  } catch (err) {
    logger.error(`[R${rid}] Transform failed`, err);
    res.status(400).json({
      error: { message: `Request transform failed: ${err}`, type: "invalid_request" },
    });
    return;
  }

  logger.info(`[R${rid}] Transformed: ${chatReq.messages.length} messages, model=${chatReq.model}`);
  logger.debug(`[R${rid}] Full request`, JSON.stringify(chatReq));

  const backendUrl =
    config.backend.baseUrl.replace(/\/+$/, "") +
    config.backend.completionsPath;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  };

  if (config.backend.apiKey) {
    headers["Authorization"] = `Bearer ${config.backend.apiKey}`;
  }

  if (config.backend.extraHeaders) {
    for (const [key, value] of Object.entries(config.backend.extraHeaders)) {
      headers[key] = encodeHeaderValue(value);
    }
  }

  let upstream: globalThis.Response;
  try {
    upstream = await fetch(backendUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(chatReq),
    });
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error(`[R${rid}] Fetch error: ${errMsg}`);
    res.status(502).json({
      error: { message: `Failed to connect to backend: ${errMsg}`, type: "proxy_error" },
    });
    return;
  }

  logger.info(`[R${rid}] Backend responded: ${upstream.status} ${upstream.statusText}`);

  if (!upstream.ok) {
    const errBody = await upstream.text().catch(() => "unknown error");
    logger.error(`[R${rid}] Backend error body: ${errBody}`);
    res.status(upstream.status).json({
      error: {
        message: `Backend error: ${upstream.status} - ${errBody}`,
        type: "upstream_error",
      },
    });
    return;
  }

  if (!upstream.body) {
    logger.error(`[R${rid}] No response body`);
    res.status(502).json({
      error: { message: "Backend returned no body", type: "proxy_error" },
    });
    return;
  }

  req.socket.setTimeout(0);
  req.socket.setNoDelay(true);

  let clientDisconnected = false;
  res.on("close", () => {
    clientDisconnected = true;
    logger.warn(`[R${rid}] Client disconnected`);
  });

  initSSE(res);
  const writer = new ResponseStreamWriter(res, chatReq.model);

  let chunkCount = 0;
  let sseEventCount = 0;

  try {
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      if (clientDisconnected) {
        logger.warn(`[R${rid}] Aborting: client gone after ${chunkCount} chunks`);
        reader.cancel().catch(() => {});
        break;
      }

      const { done, value } = await reader.read();
      if (done) break;

      chunkCount++;
      buffer += decoder.decode(value, { stream: true });
      const { events, remaining } = parseSSEBuffer(buffer);
      buffer = remaining;

      for (const evt of events) {
        sseEventCount++;
        const data = evt.data.trim();
        logger.info(`[R${rid}] SSE#${sseEventCount}: ${data.slice(0, 300)}`);
        if (data === "[DONE]") continue;

        try {
          const chunk = JSON.parse(data) as ChatCompletionChunk;

          if ((chunk as any).error) {
            logger.error(`[R${rid}] Backend stream error`, data);
          }

          writer.processChunk(chunk);
        } catch (parseErr) {
          logger.warn(`[R${rid}] Parse failed: ${data.slice(0, 200)}`);
        }
      }
    }

    if (!clientDisconnected) {
      writer.finalize();
      logger.info(`[R${rid}] <<< Completed: ${chunkCount} chunks, ${sseEventCount} SSE events`);
    }
  } catch (streamErr: unknown) {
    const errMsg = streamErr instanceof Error ? streamErr.message : String(streamErr);
    logger.error(`[R${rid}] Stream error after ${chunkCount} chunks: ${errMsg}`);
    if (!clientDisconnected) {
      writer.emitError("Stream processing failed");
    }
  }

  res.end();
}
