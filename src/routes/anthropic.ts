import { Router, type Request, type Response } from "express";
import type { AdapterConfig } from "../config.js";
import { resolveBackend } from "../config.js";
import type { ChatCompletionChunk, ChatCompletionsRequest } from "../transform/types.js";
import type { AnthropicMessagesRequest } from "../transform/anthropic-types.js";
import { transformAnthropicRequest } from "../transform/anthropic-request.js";
import { AnthropicResponseWriter } from "../transform/anthropic-response.js";
import { initSSE } from "../utils/sse.js";
import { logger } from "../utils/logger.js";
import { nextRequestId, buildBackendHeaders, fetchBackend, readSSEChunks, fetchAndBufferUntilContent, type BufferAttemptResult } from "../utils/backend.js";

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
  const rid = nextRequestId();
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
    `[A${rid}] >>> model=${body.model} backend=${backend.name} messages=${body.messages.length} tools=${body.tools?.length ?? 0} stream=${body.stream ?? true}`,
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

  logger.info(
    `[A${rid}] Backend request: body=${(JSON.stringify(chatReq).length / 1024).toFixed(1)}KB messages=${chatReq.messages.length} tools=${chatReq.tools?.length ?? 0} model=${chatReq.model}`,
  );
  logger.debug(`[A${rid}] Transformed to ChatCompletions: ${JSON.stringify(chatReq).slice(0, 1000)}`);

  const headers = buildBackendHeaders(req, backend);
  const backendUrl = backend.url;
  logger.info(`[A${rid}] Fetching ${backendUrl}`);

  // Handle non-streaming response
  const isStream = body.stream ?? true;
  if (!isStream) {
    const fetchResult = await fetchBackend(backendUrl, headers, chatReq, `A${rid}`);
    if (!fetchResult.ok) {
      const status = fetchResult.status ?? 502;
      const errorType = fetchResult.status ? "api_error" : "api_connection_error";
      res.status(status).json({
        type: "error",
        error: { type: errorType, message: fetchResult.message },
      });
      return;
    }
    const upstream = fetchResult.response;
    const text = await upstream.text();
    logger.debug(`[A${rid}] Non-stream response: ${text.slice(0, 500)}`);
    try {
      const chatResponse = JSON.parse(text);
      const anthropicResponse = {
        id: `msg_${Date.now().toString(36)}`,
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: chatResponse.choices?.[0]?.message?.content ?? "" }],
        model: body.model,
        stop_reason: chatResponse.choices?.[0]?.finish_reason ?? "end_turn",
        stop_sequence: null,
        usage: {
          input_tokens: chatResponse.usage?.prompt_tokens ?? 0,
          output_tokens: chatResponse.usage?.completion_tokens ?? 0,
        },
      };
      res.status(200).json(anthropicResponse);
    } catch (err) {
      logger.error(`[A${rid}] Failed to parse non-stream response: ${err}`);
      res.status(200).send(text);
    }
    return;
  }

  // Streaming with retry — same strategy as Responses path
  let clientDisconnected = false;
  res.on("close", () => {
    clientDisconnected = true;
    logger.warn(`[A${rid}] Client disconnected`);
  });

  const MAX_ATTEMPTS = 10;
  let lastAttempt: BufferAttemptResult | null = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      const delay = Math.min(2000 * Math.pow(2, attempt - 1), 30000);
      logger.info(`[A${rid}] Retry attempt ${attempt + 1}/${MAX_ATTEMPTS} after ${delay}ms delay`);
      await new Promise(r => setTimeout(r, delay));
    }

    if (clientDisconnected) break;

    const attemptResult = await fetchAndBufferUntilContent(backendUrl, headers, chatReq, `A${rid}`);

    if (attemptResult.kind === "success") {
      lastAttempt = attemptResult;
      break;
    }

    if (attemptResult.kind === "empty") {
      lastAttempt = attemptResult;
      logger.warn(`[A${rid}] Attempt ${attempt + 1} returned empty (stub-reject), will retry...`);
      continue;
    }

    if (attemptResult.kind === "error" && attemptResult.message.includes("bad_request") && attempt < 2) {
      lastAttempt = attemptResult;
      logger.warn(`[A${rid}] Attempt ${attempt + 1} backend inference error, will retry...`);
      continue;
    }

    lastAttempt = attemptResult;
    break;
  }

  if (clientDisconnected) return;

  // --- Handle final result ---

  if (!lastAttempt) {
    res.status(502).json({
      type: "error",
      error: { type: "api_error", message: "No response from backend" },
    });
    return;
  }

  if (lastAttempt.kind === "error") {
    if (!res.headersSent) {
      const status = lastAttempt.status ?? 502;
      const errorType = lastAttempt.contextExceeded ? "invalid_request_error" : "api_error";
      res.status(status).json({
        type: "error",
        error: { type: errorType, message: lastAttempt.message },
      });
    }
    return;
  }

  if (lastAttempt.kind === "empty") {
    logger.error(`[A${rid}] All ${MAX_ATTEMPTS} attempts returned empty response`);
    initSSE(res);
    const thinkingEnabled = body.thinking?.type === "enabled";
    const writer = new AnthropicResponseWriter(res, body.model, thinkingEnabled);
    writer.finalize();
    res.end();
    return;
  }

  // --- Success: replay buffered chunks and stream remaining ---

  const { bufferedChunks, stream } = lastAttempt;

  initSSE(res);
  const thinkingEnabled = body.thinking?.type === "enabled";
  const writer = new AnthropicResponseWriter(res, body.model, thinkingEnabled);

  let sseEventCount = 0;

  try {
    for (const chunk of bufferedChunks) {
      if (clientDisconnected) break;
      sseEventCount++;
      writer.processChunk(chunk);
    }

    for await (const chunk of readSSEChunks(stream, `A${rid}`)) {
      if (clientDisconnected) break;
      sseEventCount++;
      writer.processChunk(chunk);
    }
    logger.info(`[A${rid}] Stream loop exited, clientDisconnected=${clientDisconnected}`);
  } catch (streamErr: unknown) {
    const errMsg = streamErr instanceof Error ? streamErr.message : String(streamErr);
    logger.error(`[A${rid}] Error during stream replay: ${errMsg}`);
  }

  if (!clientDisconnected) {
    writer.finalize();
    res.end();
    logger.info(`[A${rid}] <<< Completed: ${sseEventCount} SSE events`);
  } else {
    logger.warn(`[A${rid}] Client disconnected, skipping finalize`);
  }
}
