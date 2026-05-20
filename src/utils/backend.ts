import type { Request } from "express";
import type { BackendConfig } from "../config.js";
import type { ChatCompletionChunk, ChatCompletionsRequest } from "../transform/types.js";
import { parseSSEBuffer } from "./sse.js";
import { logger } from "./logger.js";

let reqCounter = 0;

/** Shared monotonically increasing request counter across all routes. */
export function nextRequestId(): number {
  return ++reqCounter;
}

export function encodeHeaderValue(value: string): string {
  if (/^[\x00-\xff]*$/.test(value)) return value;
  return encodeURIComponent(value);
}

/** Build HTTP headers for backend request, merging API key and extra headers from config. */
export function buildBackendHeaders(
  req: Request,
  backend: BackendConfig,
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  };

  if (backend.apiKey) {
    headers["Authorization"] = `Bearer ${backend.apiKey}`;
  }

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

  return headers;
}

export type FetchBackendResult =
  | { ok: true; response: globalThis.Response }
  | { ok: false; status?: number; message: string };

const BACKEND_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

/** POST to backend with structured result. Handles connection errors and non-OK HTTP responses. */
export async function fetchBackend(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  label: string,
): Promise<FetchBackendResult> {
  let upstream: globalThis.Response;
  try {
    upstream = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(BACKEND_TIMEOUT_MS),
    });
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error(`[${label}] Fetch error: ${errMsg}`);
    return { ok: false, message: errMsg };
  }

  logger.info(`[${label}] Backend responded: ${upstream.status} ${upstream.statusText}`);

  if (!upstream.ok) {
    const errBody = await upstream.text().catch(() => "");
    logger.error(`[${label}] Backend error ${upstream.status}: ${errBody.slice(0, 500)}`);
    return { ok: false, status: upstream.status, message: errBody };
  }

  return { ok: true, response: upstream };
}

// --- Shared retry types and helpers ---

export type BufferAttemptResult =
  | { kind: "success"; bufferedChunks: ChatCompletionChunk[]; stream: ReadableStream<Uint8Array> }
  | { kind: "empty"; rawContent: string }
  | { kind: "error"; status?: number; message: string; contextExceeded?: boolean };

/**
 * Fetch backend and buffer SSE chunks until real content (text / tool_calls / reasoning)
 * is detected. Returns immediately on first content chunk so callers can stream-through.
 * If no content arrives before [DONE], classifies the result as empty (stub-reject) or error.
 */
export async function fetchAndBufferUntilContent(
  backendUrl: string,
  headers: Record<string, string>,
  chatReq: ChatCompletionsRequest,
  label: string,
): Promise<BufferAttemptResult> {
  const result = await fetchBackend(backendUrl, headers, chatReq, label);
  if (!result.ok) {
    logger.error(`[${label}] Request that caused error: ${JSON.stringify(chatReq).slice(0, 2000)}`);

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

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const bufferedChunks: ChatCompletionChunk[] = [];
  const pendingChunks: Uint8Array[] = [];
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
          logger.warn(`[${label}] Failed to parse SSE chunk JSON (${data.length} chars): ${parseErr instanceof Error ? parseErr.message : parseErr}. Preview: ${data.slice(0, 200)}`);
          continue;
        }

        bufferedChunks.push(chunk);

        if (chunk.choices?.length) {
          for (const choice of chunk.choices) {
            const d = choice.delta;
            if (d && ((d.content != null && d.content !== "") || (d.reasoning_content != null && d.reasoning_content !== "") || d.tool_calls?.length)) {
              hasContent = true;
              if (d.tool_calls?.length) {
                logger.debug(`[${label}] Backend tool_calls: ${JSON.stringify(d.tool_calls).slice(0, 200)}`);
              }
            }
          }
        }
      }

      if (hasContent) {
        logger.info(`[${label}] Got real content after ${bufferedChunks.length} chunks, switching to stream-through`);
        break;
      }
    }
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error(`[${label}] Error buffering: ${errMsg}`);
    return { kind: "error", message: errMsg };
  }

  if (!hasContent) {
    const rawContent = pendingChunks.map(c => decoder.decode(c, { stream: true })).join("");

    try {
      const parsed = JSON.parse(rawContent.trim());
      if (parsed.code || parsed.error || parsed.msg) {
        const errMsg = parsed.msg || parsed.error?.message || parsed.message || rawContent;
        logger.error(`[${label}] Backend returned error in stream: ${rawContent.slice(0, 500)}`);
        const contextExceeded = parsed.error?.code === "context_length_exceeded";
        return { kind: "error", status: 400, message: errMsg, contextExceeded };
      }
    } catch {}

    for (const chunk of bufferedChunks) {
      const chunkObj = chunk as unknown as Record<string, unknown>;
      if (!chunk.choices?.length) {
        if (chunkObj.error) {
          const errMsg = JSON.stringify(chunkObj.error);
          logger.error(`[${label}] Backend error in SSE chunk: ${errMsg}`);
          return { kind: "error", status: 400, message: errMsg };
        }
        if (chunkObj.code && chunkObj.message) {
          const errMsg = `[${chunkObj.code}] ${chunkObj.message}${chunkObj.type ? ` (${chunkObj.type})` : ''}`;
          logger.error(`[${label}] Backend error in SSE chunk: ${errMsg}`);
          return { kind: "error", status: typeof chunkObj.code === 'number' ? chunkObj.code : 500, message: errMsg };
        }
      }
    }

    logger.warn(`[${label}] Stub-reject detected: ${rawContent.length} bytes, no real content`);
    logger.debug(`[${label}] Stub-reject raw content: ${rawContent}`);
    return { kind: "empty", rawContent };
  }

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

/** Read SSE stream and yield parsed ChatCompletionChunk objects. */
export async function* readSSEChunks(
  body: ReadableStream<Uint8Array>,
  label: string,
): AsyncGenerator<ChatCompletionChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      const { events, remaining } = parseSSEBuffer(buffer);
      buffer = remaining;

      for (const evt of events) {
        const data = evt.data.trim();
        if (data === "[DONE]") {
          logger.info(`[${label}] Received [DONE] marker`);
          continue;
        }

        try {
          yield JSON.parse(data) as ChatCompletionChunk;
        } catch (parseErr) {
          logger.warn(
            `[${label}] SSE chunk parse error (${data.length} chars): ` +
            `${parseErr instanceof Error ? parseErr.message : parseErr}. ` +
            `Preview: ${data.slice(0, 200)}`
          );
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
