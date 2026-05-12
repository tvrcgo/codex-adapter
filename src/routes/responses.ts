import { Router, type Request, type Response } from "express";
import type { AdapterConfig } from "../config.js";
import { resolveBackend } from "../config.js";
import type { ResponsesRequest, ChatCompletionChunk, ChatCompletionsRequest } from "../transform/types.js";
import { transformRequest } from "../transform/request.js";
import { ResponseStreamWriter } from "../transform/response.js";
import { initSSE, parseSSEBuffer } from "../utils/sse.js";
import { logger } from "../utils/logger.js";
import { saveRequestRecord } from "../utils/request-recorder.js";
import { nextRequestId, buildBackendHeaders, fetchBackend, readSSEChunks } from "../utils/backend.js";

const HEARTBEAT_INTERVAL_MS = 15_000; // 15s SSE heartbeat

// --- Router ---

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

async function handleResponses(req: Request, res: Response, config: AdapterConfig): Promise<void> {
  const rid = nextRequestId();
  const body = req.body as ResponsesRequest;

  // Save full request body for inspection/replay
  saveRequestRecord(body, null, `${body.model}_R${rid}`).catch(err =>
    logger.warn(`[R${rid}] Failed to save request record: ${err}`)
  );

  // Log request body for debugging
  logger.debug(`[R${rid}] RAW request body: ${JSON.stringify(body).slice(0, 5000)}`);

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

  const inputSummary = typeof body.input === "string"
    ? `string(${body.input.length})`
    : `array(${Array.isArray(body.input) ? body.input.length : "?"} items)`;

  logger.info(`[R${rid}] >>> model=${body.model} backend=${backend.name} input=${inputSummary} tools=${body.tools?.length ?? 0}`);

  let chatReq: ChatCompletionsRequest;
  try {
    chatReq = transformRequest(body, backend);
    // Save transformed request for debugging
    saveRequestRecord(body, chatReq, `${body.model}_R${rid}_transformed`).catch(() => {});
  } catch (err) {
    logger.error(`[R${rid}] Transform failed`, err);
    res.status(400).json({
      error: { message: `Request transform failed: ${err}`, type: "invalid_request" },
    });
    return;
  }

  logger.info(
    `[R${rid}] Transformed: ${chatReq.messages.length} messages, model=${chatReq.model} ` +
    `| max_tokens=${backend.maxTokens ?? "unset"}`
  );

  logger.debug(`[R${rid}] Full request`, JSON.stringify(chatReq));

  // Log actual request body for diagnosis
  const reqBodyStr = JSON.stringify(chatReq);
  logger.info(
    `[R${rid}] Backend request: body=${(reqBodyStr.length / 1024).toFixed(1)}KB ` +
    `messages=${chatReq.messages.length} tools=${chatReq.tools?.length ?? 0} ` +
    `max_tokens=${chatReq.max_tokens ?? "unset"} model=${chatReq.model}`
  );
  logger.debug(`[R${rid}] Full request body: ${reqBodyStr}`);

  const backendUrl = backend.url;
  const headers = buildBackendHeaders(req, backend);

  // --- Retry loop: buffer and check before sending to client ---
  // If backend returns stub-reject (empty response), retry silently without client knowing.

  req.socket.setTimeout(0);
  req.socket.setNoDelay(true);

  let clientDisconnected = false;
  res.on("close", () => {
    clientDisconnected = true;
    logger.warn(`[R${rid}] Client disconnected`);
  });

  const MAX_ATTEMPTS = 10;
  type AttemptResult =
    | { kind: "success"; bufferedChunks: ChatCompletionChunk[]; stream: ReadableStream<Uint8Array> }
    | { kind: "empty"; rawContent: string }
    | { kind: "error"; status?: number; message: string; contextExceeded?: boolean };
  let lastAttempt: AttemptResult | null = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      const delay = Math.min(2000 * Math.pow(2, attempt - 1), 30000);
      logger.info(`[R${rid}] Retry attempt ${attempt + 1}/${MAX_ATTEMPTS} after ${delay}ms delay`);
      await new Promise(r => setTimeout(r, delay));
    }

    if (clientDisconnected) break;

    const attemptResult = await fetchAndBufferUntilContent(backendUrl, headers, chatReq, rid);

    if (attemptResult.kind === "success") {
      lastAttempt = attemptResult;
      break; // Got real content, proceed to stream-through
    }

    // Retry on empty (stub-reject)
    if (attemptResult.kind === "empty") {
      lastAttempt = attemptResult;
      logger.warn(`[R${rid}] Attempt ${attempt + 1} returned empty (stub-reject), will retry...`);
      continue;
    }

    // Retry on transient backend error (bad_request / 模型推理异常), max 2 retries
    if (attemptResult.kind === "error" && attemptResult.message.includes("bad_request") && attempt < 2) {
      lastAttempt = attemptResult;
      logger.warn(`[R${rid}] Attempt ${attempt + 1} backend inference error, will retry...`);
      continue;
    }

    // Other errors or exhausted bad_request retries: return immediately
    lastAttempt = attemptResult;
    break;
  }

  if (clientDisconnected) return;

  // --- Handle final result ---

  if (!lastAttempt) {
    res.status(502).json({
      error: { message: "No response from backend", type: "proxy_error" },
    });
    return;
  }

  if (lastAttempt.kind === "error") {
    // Always return SSE format for errors so Codex CLI can handle them properly
    initSSE(res);
    const writer = new ResponseStreamWriter(res, body.model);

    if (lastAttempt.contextExceeded) {
      // context_length_exceeded
      writer.emitError(
        `This model's maximum context length is ${backend.maxTokens ?? "unknown"} tokens. ` +
        `Your messages resulted in too many tokens. Please reduce the length of the messages.`
      );
    } else {
      writer.emitError(lastAttempt.message);
    }
    res.end();
    return;
  }

  if (lastAttempt.kind === "empty") {
    // After all retries, still empty - synthesize a response so Codex doesn't hang
    logger.error(`[R${rid}] All ${MAX_ATTEMPTS} attempts returned empty response`);
    initSSE(res);
    const writer = new ResponseStreamWriter(res, body.model);
    writer.finalize(false);
    res.end();
    return;
  }

  
  // --- Success: replay buffered chunks and stream remaining ---

  const { bufferedChunks, stream } = lastAttempt;

  initSSE(res);

  const writer = new ResponseStreamWriter(res, body.model);
  logger.debug(`[R${rid}] Writer created, bufferedChunks=${bufferedChunks.length}`);

  // Heartbeat timer for keepalive
  let heartbeatTimer: ReturnType<typeof setInterval> | null = setInterval(() => {
    if (!clientDisconnected) {
      res.write(": heartbeat\n\n");
    }
  }, HEARTBEAT_INTERVAL_MS);

  let sseEventCount = 0;

  function processChunkWithLogging(chunk: ChatCompletionChunk): void {
    sseEventCount++;
    if (chunk.choices?.some(c => c.delta?.tool_calls?.length)) {
      logger.debug(`[R${rid}] chunk with tool_calls, count=${sseEventCount}`);
    }
    const contentDelta = chunk.choices?.[0]?.delta?.content;
    if (contentDelta != null && contentDelta !== "") {
      logger.debug(`[R${rid}] chunk with content (${contentDelta.length} chars), count=${sseEventCount}, preview="${contentDelta.slice(0, 50)}"`);
    }
    const finishReason = chunk.choices?.[0]?.finish_reason;
    if (finishReason) {
      logger.info(`[R${rid}] finish_reason=${finishReason}, count=${sseEventCount}`);
    }
    writer.processChunk(chunk);
  }

  try {
    // First, replay buffered chunks
    for (const chunk of bufferedChunks) {
      if (clientDisconnected) break;
      processChunkWithLogging(chunk);
    }

    // Then, continue streaming from where we left off
    for await (const chunk of readSSEChunks(stream, `R${rid}`)) {
      if (clientDisconnected) break;
      processChunkWithLogging(chunk);
    }
    logger.info(`[R${rid}] Stream loop exited, clientDisconnected=${clientDisconnected}`);
  } catch (streamErr: unknown) {
    const errMsg = streamErr instanceof Error ? streamErr.message : String(streamErr);
    logger.error(`[R${rid}] Error during stream replay: ${errMsg}`);
    if (!clientDisconnected) {
      writer.emitError(`Stream error: ${errMsg}`);
    }
  } finally {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    logger.info(`[R${rid}] Finally block reached, clientDisconnected=${clientDisconnected}`);
  }

  if (!clientDisconnected) {
    logger.info(`[R${rid}] About to call finalize...`);
    writer.finalize(true);
    logger.info(`[R${rid}] Finalize returned, about to res.end()`);
    res.end();
    logger.info(`[R${rid}] <<< Completed: ${sseEventCount} SSE events`);
  } else {
    logger.warn(`[R${rid}] Client disconnected, skipping finalize`);
  }
}

// --- Helper: fetch and buffer until we see real content ---

async function fetchAndBufferUntilContent(
  backendUrl: string,
  headers: Record<string, string>,
  chatReq: ChatCompletionsRequest,
  rid: number,
): Promise<
  | { kind: "success"; bufferedChunks: ChatCompletionChunk[]; stream: ReadableStream<Uint8Array> }
  | { kind: "empty"; rawContent: string }
  | { kind: "error"; status?: number; message: string; contextExceeded?: boolean }
> {
  const result = await fetchBackend(backendUrl, headers, chatReq, `R${rid}`);
  if (!result.ok) {
    logger.error(`[R${rid}] Request that caused error: ${JSON.stringify(chatReq).slice(0, 2000)}`);

    try {
      const parsed = JSON.parse(result.message);
      if (parsed?.error?.code === "context_length_exceeded") {
        return { kind: "error", status: 400, message: "context_length_exceeded", contextExceeded: true };
      }
    } catch {}

    return { kind: "error", status: result.status, message: result.message };
  }

  const upstream = result.response;
  if (!upstream.body) {
    return { kind: "error", message: "Backend returned no body" };
  }

  // Read chunks until we see actual content (not stub-reject)
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const bufferedChunks: ChatCompletionChunk[] = [];
  const pendingChunks: Uint8Array[] = []; // Raw bytes for replay
  let buffer = "";
  let hasContent = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      pendingChunks.push(value);
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      const { events, remaining } = parseSSEBuffer(buffer);
      buffer = remaining;

      for (const evt of events) {
        const data = evt.data.trim();
        if (data === "[DONE]") continue;

        let chunk: ChatCompletionChunk;
        try {
          chunk = JSON.parse(data) as ChatCompletionChunk;
        } catch (parseErr) {
          logger.warn(`[R${rid}] Failed to parse SSE chunk JSON in tryOnce (${data.length} chars): ${parseErr instanceof Error ? parseErr.message : parseErr}. Preview: ${data.slice(0, 200)}`);
          continue;
        }

        bufferedChunks.push(chunk);

        if (chunk.choices?.length) {
          for (const choice of chunk.choices) {
            const d = choice.delta;
            if (d && ((d.content != null && d.content !== "") || (d.reasoning_content != null && d.reasoning_content !== "") || d.tool_calls?.length)) {
              hasContent = true;
              // Log tool calls from backend
              if (d.tool_calls?.length) {
                logger.debug(`[R${rid}] Backend tool_calls: ${JSON.stringify(d.tool_calls).slice(0, 200)}`);
              }
              // Log content delta for debugging XML tool detection
              if (d.content && (d.content.includes('<command') || d.content.includes('<execute'))) {
                logger.debug(`[R${rid}] Backend content with XML tool: ${d.content.slice(0, 300)}`);
              }
            }
          }
        }
      }

      // If we got real content, we can return success and continue streaming
      if (hasContent) {
        logger.info(`[R${rid}] Got real content after ${bufferedChunks.length} chunks, switching to stream-through`);
        break;
      }
    }
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error(`[R${rid}] Error buffering: ${errMsg}`);
    return { kind: "error", message: errMsg };
  }

  if (!hasContent) {
    // No real content found - check if backend returned an error in the stream
    const rawContent = pendingChunks.map(c => decoder.decode(c, { stream: true })).join("");

    // Try to detect error responses from backend (non-SSE JSON or SSE with error)
    try {
      // Case 1: raw non-SSE JSON error (e.g. {"code":10001,"msg":"param_wrong"})
      const parsed = JSON.parse(rawContent.trim());
      if (parsed.code || parsed.error || parsed.msg) {
        const errMsg = parsed.msg || parsed.error?.message || parsed.message || rawContent;
        logger.error(`[R${rid}] Backend returned error in stream: ${rawContent.slice(0, 500)}`);
        const contextExceeded = parsed.error?.code === "context_length_exceeded";
        return { kind: "error", status: 400, message: errMsg, contextExceeded };
      }
    } catch {
      // Not a single JSON object - try parsing SSE events for errors
    }

    // Case 2: Check buffered chunks for error indicators (no choices, error-like structure)
    for (const chunk of bufferedChunks) {
      const chunkObj = chunk as unknown as Record<string, unknown>;
      if (!chunk.choices?.length) {
        // Check for error in various formats
        if (chunkObj.error) {
          const errMsg = JSON.stringify(chunkObj.error);
          logger.error(`[R${rid}] Backend error in SSE chunk: ${errMsg}`);
          return { kind: "error", status: 400, message: errMsg };
        }
        // WPS/GLM error format: {"code":"504","message":"...","type":"模型推理异常"}
        if (chunkObj.code && chunkObj.message) {
          const errMsg = `[${chunkObj.code}] ${chunkObj.message}${chunkObj.type ? ` (${chunkObj.type})` : ''}`;
          logger.error(`[R${rid}] Backend error in SSE chunk: ${errMsg}`);
          return { kind: "error", status: typeof chunkObj.code === 'number' ? chunkObj.code : 500, message: errMsg };
        }
      }
    }

    // Otherwise treat as stub-reject
    logger.warn(`[R${rid}] Stub-reject detected: ${rawContent.length} bytes, no real content`);
    logger.debug(`[R${rid}] Stub-reject raw content: ${rawContent}`);
    return { kind: "empty", rawContent };
  }

  // Create a stream that continues reading from where we left off.
  // IMPORTANT: Prepend any remaining (unparsed) SSE buffer data so that
  // partial events split across TCP reads are not lost. This fixes the bug
  // where the tool_call header chunk (containing id/name) was discarded.
  const remainingReader = reader;
  const remainingBuffer = buffer;
  let bufferFlushed = !remainingBuffer;

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!bufferFlushed) {
        bufferFlushed = true;
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(remainingBuffer));
        return;
      }
      const { done, value } = await remainingReader.read();
      if (done) {
        controller.close();
        return;
      }
      controller.enqueue(value);
    },
    cancel() {
      remainingReader.cancel();
    }
  });

  return { kind: "success", bufferedChunks, stream };
}