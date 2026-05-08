import type { Request } from "express";
import type { BackendConfig } from "../config.js";
import type { ChatCompletionChunk } from "../transform/types.js";
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
