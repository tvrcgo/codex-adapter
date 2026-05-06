import { Router, type Request, type Response } from "express";
import type { AdapterConfig } from "../config.js";
import { resolveBackend } from "../config.js";
import type { ChatCompletionChunk, ChatCompletionsRequest } from "../transform/types.js";
import type { AnthropicMessagesRequest } from "../transform/anthropic-types.js";
import { transformAnthropicRequest } from "../transform/anthropic-request.js";
import { AnthropicResponseWriter } from "../transform/anthropic-response.js";
import { initSSE, parseSSEBuffer } from "../utils/sse.js";
import { logger } from "../utils/logger.js";

let reqCounter = 0;

function encodeHeaderValue(value: string): string {
  if (/^[\x00-\xff]*$/.test(value)) return value;
  return encodeURIComponent(value);
}

export function createAnthropicRouter(config: AdapterConfig): Router {
  const router = Router();

  router.post("/v1/messages", async (req: Request, res: Response) => {
    try {
      await handleAnthropicMessages(req, res, config);
    } catch (err) {
      logger.error("Unhandled error in /v1/messages", err);
      if (!res.headersSent) {
        res.status(500).json({
          type: "error",
          error: { type: "internal_error", message: "Internal adapter error" },
        });
      } else {
        res.end();
      }
    }
  });

  return router;
}

async function handleAnthropicMessages(
  req: Request,
  res: Response,
  config: AdapterConfig,
): Promise<void> {
  const rid = ++reqCounter;
  const body = req.body as AnthropicMessagesRequest;

  logger.debug(`[A${rid}] RAW request body: ${JSON.stringify(body).slice(0, 2000)}`);

  const backend = resolveBackend(config, body.model);
  if (!backend) {
    logger.error(`[A${rid}] No backend configured for model=${body.model}`);
    res.status(400).json({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: `No backend configured for model "${body.model}"`,
      },
    });
    return;
  }

  logger.info(
    `[A${rid}] >>> model=${body.model} backend=${backend.name} messages=${body.messages.length} stream=${body.stream ?? true}`,
  );

  let chatReq: ChatCompletionsRequest;
  try {
    chatReq = transformAnthropicRequest(body, backend);
  } catch (err) {
    logger.error(`[A${rid}] Transform failed`, err);
    res.status(400).json({
      type: "error",
      error: { type: "invalid_request_error", message: `Transform failed: ${err}` },
    });
    return;
  }

  logger.debug(`[A${rid}] Transformed to ChatCompletions: ${JSON.stringify(chatReq).slice(0, 1000)}`);

  // Build headers (same logic as responses.ts)
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  };

  if (backend.apiKey) {
    headers["Authorization"] = `Bearer ${backend.apiKey}`;
  }

  // Add extra headers from config, allow client request to override
  if (backend.extraHeaders) {
    for (const [key, value] of Object.entries(backend.extraHeaders)) {
      const clientVal = req.headers[key.toLowerCase()];
      if (clientVal) {
        headers[key] = Array.isArray(clientVal) ? clientVal[0] : clientVal;
      } else if (value) {
        headers[key] = encodeHeaderValue(value);
      }
    }
  }

  const url = backend.url;
  logger.info(`[A${rid}] Fetching ${url}`);
  logger.debug(`[A${rid}] Headers: ${JSON.stringify(headers)}`);

  let upstream: globalThis.Response;
  try {
    upstream = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(chatReq),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[A${rid}] Backend connection failed: ${msg}`);
    res.status(502).json({
      type: "error",
      error: { type: "api_connection_error", message: msg },
    });
    return;
  }

  logger.info(`[A${rid}] Backend responded: ${upstream.status} ${upstream.statusText}`);

  if (!upstream.ok) {
    const errBody = await upstream.text().catch(() => "");
    logger.error(`[A${rid}] Backend error ${upstream.status}: ${errBody.slice(0, 500)}`);
    res.status(upstream.status).json({
      type: "error",
      error: { type: "api_error", message: errBody },
    });
    return;
  }

  // Handle streaming response
  const isStream = body.stream ?? true;
  if (!isStream) {
    const text = await upstream.text();
    logger.debug(`[A${rid}] Non-stream response: ${text.slice(0, 500)}`);
    res.status(200).send(text);
    return;
  }

  // Streaming: set SSE headers
  initSSE(res);

  if (!upstream.body) {
    logger.error(`[A${rid}] No body from upstream`);
    res.end();
    return;
  }

  const writer = new AnthropicResponseWriter(res, body.model);
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let chunkCount = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const { events, remaining } = parseSSEBuffer(buffer);
      buffer = remaining;

      for (const evt of events) {
        const data = evt.data.trim();
        if (data === "[DONE]") continue;

        let chunk: ChatCompletionChunk;
        try {
          chunk = JSON.parse(data) as ChatCompletionChunk;
        } catch {
          continue;
        }

        // Debug log for usage
        if (chunk.usage) {
          logger.debug(`[A${rid}] Backend usage: ${JSON.stringify(chunk.usage)}`);
        }

        chunkCount++;
        writer.processChunk(chunk);
      }
    }

    logger.info(`[A${rid}] Processed ${chunkCount} chunks`);
    writer.finalize();
  } catch (err) {
    logger.error(`[A${rid}] Stream error: ${err}`);
  }

  // End the response
  res.end();
  logger.info(`[A${rid}] <<< completed`);
}
