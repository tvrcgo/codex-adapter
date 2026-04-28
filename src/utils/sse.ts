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
 */
export function parseSSEBuffer(buffer: string): { events: ParsedSSEEvent[]; remaining: string } {
  const events: ParsedSSEEvent[] = [];
  const blocks = buffer.split("\n\n");
  const remaining = blocks.pop() ?? "";

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;

    let data = "";
    for (const line of trimmed.split("\n")) {
      if (line.startsWith("data: ")) {
        data += line.slice(6);
      } else if (line.startsWith("data:")) {
        data += line.slice(5);
      }
    }
    if (data) {
      events.push({ data });
    }
  }

  return { events, remaining };
}
