import { Router, type Request, type Response } from "express";
import type { AdapterConfig } from "../config.js";
import { resolveBackend } from "../config.js";
import type { ChatCompletionChunk, ChatCompletionsRequest } from "../transform/types.js";
import type { AnthropicMessagesRequest } from "../transform/anthropic-types.js";
import { transformAnthropicRequest } from "../transform/anthropic-request.js";
import { AnthropicResponseWriter } from "../transform/anthropic-response.js";
import { initSSE } from "../utils/sse.js";
import { logger } from "../utils/logger.js";
import { nextRequestId, buildBackendHeaders, fetchBackend, readSSEChunks } from "../utils/backend.js";

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
  logger.info(`[A${rid}] Fetching ${backend.url}`);

  const fetchResult = await fetchBackend(backend.url, headers, chatReq, `A${rid}`);
  if (!fetchResult.ok) {
    const status = fetchResult.status ?? 502;
    const errorType = fetchResult.status ? "api_error" : "api_connection_error";
    res.status(status).json({
      type: "error",
      error: { type: errorType, message: fetchResult.message },
    });
    return;
  }

  // Handle non-streaming response
  const isStream = body.stream ?? true;
  if (!isStream) {
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

  // Streaming with retry on stub-reject / backend inference error
  const MAX_RETRIES = 5;
  const RETRY_DELAYS = [0, 2000, 2000, 4000, 8000];

  let chunks: ChatCompletionChunk[] | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const resp = attempt === 0 ? fetchResult.response : await refetchBackend();
    if (!resp?.body) {
      logger.error(`[A${rid}] No body from upstream (attempt ${attempt + 1})`);
      break;
    }

    const collected: ChatCompletionChunk[] = [];
    let hasContent = false;

    for await (const chunk of readSSEChunks(resp.body, `A${rid}`)) {
      collected.push(chunk);
      if (!hasContent && chunkHasContent(chunk)) {
        hasContent = true;
      }
    }

    if (hasContent) {
      chunks = collected;
      break;
    }

    if (attempt < MAX_RETRIES - 1) {
      const isBackendError = collected.some(c => {
        const obj = c as unknown as Record<string, unknown>;
        return (obj.code && obj.message) || obj.error;
      });
      const reason = isBackendError ? "backend inference error" : "stub-reject";
      logger.warn(`[A${rid}] Attempt ${attempt + 1} ${reason}, retrying...`);
      const delay = RETRY_DELAYS[attempt + 1] ?? 2000;
      if (delay > 0) await new Promise(r => setTimeout(r, delay));
    } else {
      logger.error(`[A${rid}] All ${MAX_RETRIES} attempts failed, returning empty response`);
      chunks = collected;
    }
  }

  initSSE(res);
  const thinkingEnabled = body.thinking?.type === "enabled";
  const writer = new AnthropicResponseWriter(res, body.model, thinkingEnabled);

  if (chunks) {
    for (const chunk of chunks) {
      writer.processChunk(chunk);
    }
    logger.info(`[A${rid}] Processed ${chunks.length} chunks`);
  }

  writer.finalize();
  res.end();
  logger.info(`[A${rid}] <<< completed`);

  async function refetchBackend(): Promise<globalThis.Response | null> {
    const result = await fetchBackend(backend!.url, headers, chatReq, `A${rid}`);
    if (!result.ok) {
      logger.error(`[A${rid}] Retry fetch failed: ${result.message}`);
      return null;
    }
    return result.response;
  }
}

function chunkHasContent(chunk: ChatCompletionChunk): boolean {
  if (!chunk.choices?.length) return false;
  for (const choice of chunk.choices) {
    const d = choice.delta;
    if (!d) continue;
    if (d.content != null && d.content !== "") return true;
    if (d.reasoning_content != null && d.reasoning_content !== "") return true;
    if (d.tool_calls?.length) return true;
  }
  return false;
}
