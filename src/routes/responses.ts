import { Router, type Request, type Response } from "express";
import type { AdapterConfig } from "../config.js";
import { resolveBackend } from "../config.js";
import type { ResponsesRequest, ChatCompletionChunk, ChatCompletionsRequest } from "../transform/types.js";
import { transformRequest, estimateTokens, estimateToolTokens, compressToolMessages } from "../transform/request.js";
import { ResponseStreamWriter } from "../transform/response-stream.js";
import { initSSE, parseSSEBuffer } from "../utils/sse.js";
import { logger } from "../utils/logger.js";

// --- Token estimation calibration ---
// When backend returns real prompt_tokens, we calibrate our estimator.
// This ensures inputTokenOffset triggers Codex compaction at the right time.

interface CalibrationState {
  ratio: number;           // EMA of real/estimated
  lastEstimated: number;  // Last estimated token count (for computing offset)
  samples: number;        // Number of calibration samples
}

// Initial ratio = 1.0: start neutral, let calibration adjust based on real data.
// Previously 2.0 caused first request to report 2x tokens and trigger premature compact.
const calibrationState: CalibrationState = {
  ratio: 1.0,
  lastEstimated: 0,
  samples: 0,
};

const CALIBRATION_EMA_ALPHA = 0.6;  // Faster convergence: new sample has 60% weight
// No floor: let calibration converge to actual ratio (which can be < 1.0)

function getCalibratedEstimate(estimated: number): number {
  return Math.floor(estimated * calibrationState.ratio);
}

function updateCalibration(realTokens: number, estimated: number): void {
  if (realTokens <= 0 || estimated <= 0) return;

  const sampleRatio = realTokens / estimated;
  const prevRatio = calibrationState.ratio;

  // EMA update: ratio = alpha * new + (1-alpha) * old
  if (calibrationState.samples === 0) {
    calibrationState.ratio = sampleRatio;
  } else {
    calibrationState.ratio =
      CALIBRATION_EMA_ALPHA * sampleRatio + (1 - CALIBRATION_EMA_ALPHA) * prevRatio;
  }

  calibrationState.samples++;
  calibrationState.lastEstimated = estimated;

  logger.debug(
    `Calibration: real=${realTokens} estimated=${estimated} ratio=${sampleRatio.toFixed(2)} -> ` +
    `emaRatio=${calibrationState.ratio.toFixed(2)} samples=${calibrationState.samples}`
  );
}

let reqCounter = 0;

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

function encodeHeaderValue(value: string): string {
  if (/^[\x00-\xff]*$/.test(value)) return value;
  return encodeURIComponent(value);
}

async function handleResponses(req: Request, res: Response, config: AdapterConfig): Promise<void> {
  const rid = ++reqCounter;
  const body = req.body as ResponsesRequest;

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
  } catch (err) {
    logger.error(`[R${rid}] Transform failed`, err);
    res.status(400).json({
      error: { message: `Request transform failed: ${err}`, type: "invalid_request" },
    });
    return;
  }

  // --- Token estimation (for logging and compression decisions) ---
  let msgEstTokens = estimateTokens(chatReq.messages);
  let toolsEstTokens = estimateToolTokens(chatReq.tools);
  let adapterTotalEst = msgEstTokens + toolsEstTokens;

  logger.info(
    `[R${rid}] Transformed: ${chatReq.messages.length} messages, model=${chatReq.model} ` +
    `| est_tokens: msg=${msgEstTokens} tools=${toolsEstTokens} total=${adapterTotalEst} ` +
    `| max_tokens=${backend.maxTokens ?? "unset"}`
  );

  // --- Compress old tool messages if body too large ---
  const { compressed, rounds } = compressToolMessages(chatReq, backend.maxTokens);
  if (compressed) {
    // Re-estimate after compression for accurate calibration
    msgEstTokens = estimateTokens(chatReq.messages);
    toolsEstTokens = estimateToolTokens(chatReq.tools);
    adapterTotalEst = msgEstTokens + toolsEstTokens;

    const newBodySize = JSON.stringify(chatReq).length;
    logger.info(
      `[R${rid}] Compressed ${rounds} old tool rounds → ` +
      `${chatReq.messages.length} messages, est_tokens=${adapterTotalEst} body=${(newBodySize / 1024).toFixed(0)}KB`
    );
  }

  // Store calibrated estimate for offset calculation after backend response
  const calibratedEst = getCalibratedEstimate(adapterTotalEst);

  logger.debug(`[R${rid}] Full request`, JSON.stringify(chatReq));

  // Log actual request body for diagnosis
  const reqBodyStr = JSON.stringify(chatReq);
  logger.info(
    `[R${rid}] Backend request: body=${(reqBodyStr.length / 1024).toFixed(1)}KB ` +
    `messages=${chatReq.messages.length} tools=${chatReq.tools?.length ?? 0} ` +
    `max_tokens=${chatReq.max_tokens ?? "unset"} model=${chatReq.model}`
  );
  // Log the full request body for debugging param_wrong errors
  logger.debug(`[R${rid}] Full request body: ${reqBodyStr}`);

  // --- Build headers for backend ---

  const backendUrl = backend.url;
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

    // Only retry on empty (stub-reject). All other errors should return immediately.
    if (attemptResult.kind === "empty") {
      lastAttempt = attemptResult;
      logger.warn(`[R${rid}] Attempt ${attempt + 1} returned empty (stub-reject), will retry...`);
      continue; // retry
    }

    // Error case: don't retry, return immediately
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
    if (lastAttempt.contextExceeded) {
      // context_length_exceeded
      res.status(400).json({
        error: {
          message: `This model's maximum context length is ${backend.maxTokens ?? "unknown"} tokens. ` +
            `Your messages resulted in too many tokens. ` +
            `Please reduce the length of the messages.`,
          type: "invalid_request_error",
          param: "messages",
          code: "context_length_exceeded",
        },
      });
      return;
    }
    res.status(lastAttempt.status ?? 502).json({
      error: { message: lastAttempt.message, type: "upstream_error" },
    });
    return;
  }

  if (lastAttempt.kind === "empty") {
    // After all retries, still empty - synthesize a response so Codex doesn't hang
    logger.error(`[R${rid}] All ${MAX_ATTEMPTS} attempts returned empty response`);
    initSSE(res);
    const writer = new ResponseStreamWriter(res, chatReq.model);
    writer.finalize(false);
    res.end();
    return;
  }

  // --- Success: replay buffered chunks and stream remaining ---

  const { bufferedChunks, stream } = lastAttempt;

  initSSE(res);

  // Initial offset: use calibrated estimate minus a safe baseline.
  // Will be updated once we see real prompt_tokens from the backend.
  const initialOffset = Math.max(0, calibratedEst - adapterTotalEst);
  const writer = new ResponseStreamWriter(res, chatReq.model, initialOffset);

  // Heartbeat timer for keepalive
  let heartbeatTimer: ReturnType<typeof setInterval> | null = setInterval(() => {
    if (!clientDisconnected) {
      res.write(": heartbeat\n\n");
    }
  }, HEARTBEAT_INTERVAL_MS);

  let sseEventCount = 0;
  let realPromptTokens: number | null = null;

  // Helper to process a single chunk and extract prompt_tokens for calibration
  function processAndCalibrate(chunk: ChatCompletionChunk): void {
    sseEventCount++;
    writer.processChunk(chunk);

    // Extract real prompt_tokens when available (usually in the final chunk with usage)
    if (chunk.usage?.prompt_tokens && realPromptTokens === null) {
      realPromptTokens = chunk.usage.prompt_tokens;
    }
  }

  try {
    // First, replay buffered chunks
    for (const chunk of bufferedChunks) {
      if (clientDisconnected) break;
      processAndCalibrate(chunk);
    }

    // Then, continue streaming from where we left off
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (!clientDisconnected) {
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

        processAndCalibrate(chunk);
      }
    }
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
  }

  if (!clientDisconnected) {
    // --- Update calibration and compute final offset ---
    if (realPromptTokens !== null) {
      updateCalibration(realPromptTokens, adapterTotalEst);

      // inputTokenOffset = max(0, calibratedEst - realPromptTokens)
      // This ensures Codex sees: input_tokens = real + offset >= calibratedEst
      const finalOffset = Math.max(0, calibratedEst - realPromptTokens);
      writer.setInputTokenOffset(finalOffset);

      logger.info(
        `[R${rid}] Token calibration: real_prompt=${realPromptTokens} estimated=${adapterTotalEst} ` +
        `calibrated=${calibratedEst} offset=${finalOffset}`
      );
    }

    writer.finalize(true);
    logger.info(`[R${rid}] <<< Completed: ${sseEventCount} SSE events`);
  }

  res.end();
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
    return { kind: "error", message: errMsg };
  }

  logger.info(`[R${rid}] Backend responded: ${upstream.status} ${upstream.statusText}`);

  if (!upstream.ok) {
    const errBody = await upstream.text().catch(() => "");
    logger.error(`[R${rid}] Backend error body: ${errBody}`);
    logger.error(`[R${rid}] Request that caused error: ${JSON.stringify(chatReq).slice(0, 2000)}`);

    // Check for context_length_exceeded
    try {
      const parsed = JSON.parse(errBody);
      if (parsed?.error?.code === "context_length_exceeded") {
        return { kind: "error", status: 400, message: "context_length_exceeded", contextExceeded: true };
      }
    } catch {}

    return { kind: "error", status: upstream.status, message: errBody };
  }

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

        bufferedChunks.push(chunk);

        // Check for actual content
        if (chunk.choices?.length) {
          for (const choice of chunk.choices) {
            const d = choice.delta;
            if (d && ((d.content != null && d.content !== "") || d.tool_calls?.length)) {
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
      if (!chunk.choices?.length && chunkObj.error) {
        const errMsg = JSON.stringify(chunkObj.error);
        logger.error(`[R${rid}] Backend error in SSE chunk: ${errMsg}`);
        return { kind: "error", status: 400, message: errMsg };
      }
    }

    // Otherwise treat as stub-reject
    logger.warn(`[R${rid}] Stub-reject detected: ${rawContent.length} bytes, no real content`);
    return { kind: "empty", rawContent };
  }

  // Create a stream that continues reading from where we left off.
  // NOTE: We do NOT replay pendingChunks here because the caller replays
  // bufferedChunks separately. Replaying both would cause duplicate content.
  const remainingReader = reader;

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      // Continue reading from backend (pending chunks already replayed via bufferedChunks)
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