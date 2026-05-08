import type { Response } from "express";

export function sendEvent(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function initSSE(res: Response): void {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
}

export interface ParsedSSEEvent {
  data: string;
}

/**
 * Incrementally parse SSE lines from a text buffer.
 * Returns parsed events and the remaining incomplete buffer.
 *
 * IMPORTANT: Callers should normalize \r\n → \n before passing to this function.
 * This function also handles residual \r for robustness.
 *
 * Per the SSE spec, multiple `data:` lines within one event are joined with \n.
 */
export function parseSSEBuffer(buffer: string): { events: ParsedSSEEvent[]; remaining: string } {
  const events: ParsedSSEEvent[] = [];
  const blocks = buffer.split("\n\n");
  const remaining = blocks.pop() ?? "";

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;

    const dataLines: string[] = [];
    for (const rawLine of trimmed.split("\n")) {
      const line = rawLine.replace(/\r$/, "");
      if (line.startsWith("data: ")) {
        dataLines.push(line.slice(6));
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5));
      }
    }
    if (dataLines.length > 0) {
      events.push({ data: dataLines.join("\n") });
    }
  }

  return { events, remaining };
}
