import { Router, type Request, type Response } from "express";
import type { AdapterConfig, BackendConfig } from "../config.js";
import { resolveBackend } from "../config.js";
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

  const backend = resolveBackend(config, body.model);
  if (!backend) {
    logger.error(`[R${rid}] No backend configured for model=${body.model}`);
    res.status(400).json({
      error: {
        message: `No backend configured for model "${body.model}". Available: ${config.backends.map((b) => b.model).join(", ")}`,
        type: "invalid_request_error",
      },
    });
    return;
  }

  const inputSummary = typeof body.input === "string"
    ? `string(${body.input.length})`
    : `array(${Array.isArray(body.input) ? body.input.length : "?"} items)`;

  logger.info(`[R${rid}] >>> model=${body.model} backend=${backend.name} input=${inputSummary} tools=${body.tools?.length ?? 0}`);

  let chatReq;
  try {
    chatReq = transformRequest(body, backend);
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
    backend.baseUrl.replace(/\/+$/, "") +
    backend.completionsPath;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  };

  if (backend.apiKey) {
    headers["Authorization"] = `Bearer ${backend.apiKey}`;
  }

  if (backend.extraHeaders) {
    for (const [key, value] of Object.entries(backend.extraHeaders)) {
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

  // Buffer all SSE events first to detect empty responses before starting
  // the client SSE stream. Empty responses must be returned as HTTP 400
  // (context_length_exceeded) so Codex CLI triggers compaction instead of
  // blind retries.
  const allEvents: { data: string }[] = [];
  const parsedChunks: ChatCompletionChunk[] = [];
  let hasContent = false;

  try {
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { events, remaining } = parseSSEBuffer(buffer);
      buffer = remaining;

      for (const evt of events) {
        const data = evt.data.trim();
        allEvents.push({ data });
        if (data === "[DONE]") continue;
        try {
          const chunk = JSON.parse(data) as ChatCompletionChunk;
          parsedChunks.push(chunk);
          if (chunk.choices?.length) {
            for (const choice of chunk.choices) {
              const d = choice.delta;
              if (d && ((d.content != null && d.content !== "") || d.tool_calls?.length)) {
                hasContent = true;
              }
            }
          }
        } catch {
          // parse error, will be handled during replay
        }
      }
    }
  } catch (bufferErr: unknown) {
    const errMsg = bufferErr instanceof Error ? bufferErr.message : String(bufferErr);
    logger.error(`[R${rid}] Error buffering backend response: ${errMsg}`);
    res.status(502).json({
      error: { message: `Backend stream read failed: ${errMsg}`, type: "proxy_error" },
    });
    return;
  }

  logger.info(`[R${rid}] Buffered ${allEvents.length} SSE events, ${parsedChunks.length} chunks, hasContent=${hasContent}`);

  if (!hasContent) {
    const msgCount = chatReq.messages.length;
    logger.warn(`[R${rid}] Backend returned empty response for ${msgCount} messages, returning 400`);
    res.status(400).json({
      error: {
        message: `This model's maximum context length is ${backend.maxTokens ?? "unknown"} tokens. However, your messages resulted in too many tokens (${msgCount} messages). Please reduce the length of the messages.`,
        type: "invalid_request_error",
        param: "messages",
        code: "context_length_exceeded",
      },
    });
    return;
  }

  // Backend returned real content — replay buffered events as SSE
  req.socket.setTimeout(0);
  req.socket.setNoDelay(true);

  let clientDisconnected = false;
  res.on("close", () => {
    clientDisconnected = true;
    logger.warn(`[R${rid}] Client disconnected`);
  });

  initSSE(res);
  const writer = new ResponseStreamWriter(res, chatReq.model);

  let sseEventCount = 0;
  for (const chunk of parsedChunks) {
    sseEventCount++;
    if (clientDisconnected) break;
    writer.processChunk(chunk);
  }

  if (!clientDisconnected) {
    writer.finalize();
    logger.info(`[R${rid}] <<< Completed: ${parsedChunks.length} chunks, ${sseEventCount} SSE events`);
  }

  res.end();
}
