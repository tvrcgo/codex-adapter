import { Router, type Request, type Response } from "express";
import type { AdapterConfig } from "../config.js";
import { resolveBackend } from "../config.js";
import { nextRequestId, buildBackendHeaders, fetchBackend } from "../utils/backend.js";
import { logger } from "../utils/logger.js";
import type { ChatCompletionsRequest, ChatCompletionChunk } from "../transform/types.js";
import { parseSSEBuffer } from "../utils/sse.js";

export function createChatRouter(config: AdapterConfig): Router {
  const router = Router();

  router.post("/v1/chat/completions", async (req: Request, res: Response) => {
    const rid = nextRequestId();
    const body = req.body as ChatCompletionsRequest;

    const backend = resolveBackend(config, body.model);
    if (!backend) {
      logger.error(`[C${rid}] No backend configured for model=${body.model}`);
      res.status(400).json({
        error: {
          message: `No backend configured for model "${body.model}". Available: ${config.backends.flatMap((b) => b.models).join(", ")}`,
          type: "invalid_request_error",
        },
      });
      return;
    }

    const requestModel = body.model;
    const mappedModel = backend.models.includes(requestModel) ? requestModel : backend.models[0];
    const needModelRewrite = requestModel !== mappedModel;
    const backendBody = { ...body, model: mappedModel };

    if (backend.extraBody) {
      Object.assign(backendBody, backend.extraBody);
    }

    if (backend.stripParams) {
      for (const key of backend.stripParams) {
        delete (backendBody as Record<string, unknown>)[key];
      }
    }

    logger.info(
      `[C${rid}] >>> model=${body.model}→${mappedModel} backend=${backend.name} messages=${body.messages?.length ?? 0} tools=${body.tools?.length ?? 0} stream=${body.stream ?? true}`,
    );

    const backendUrl = backend.url;
    const headers = buildBackendHeaders(req, backend);

    const result = await fetchBackend(backendUrl, headers, backendBody, `C${rid}`);

    if (!result.ok) {
      const errorBody = result.message;
      let statusCode = result.status ?? 502;
      let errorResponse: unknown;

      try {
        errorResponse = JSON.parse(errorBody);
        if (errorResponse && typeof errorResponse === "object" && "error" in errorResponse) {
          res.status(statusCode).json(errorResponse);
          return;
        }
      } catch {
        // Not JSON, send as text
      }

      res.status(statusCode).json({
        error: {
          message: errorBody || `Backend error: ${statusCode}`,
          type: "upstream_error",
        },
      });
      return;
    }

    const upstream = result.response;
    const isStream = body.stream !== false;
    const contentType = upstream.headers.get("content-type") || "";
    const isSSE = contentType.includes("text/event-stream") || contentType.includes("application/x-ndjson");

    // For streaming requests, pipe through
    if (isStream) {
      for (const [key, value] of Object.entries(upstream.headers)) {
        if (key === "transfer-encoding") continue;
        res.setHeader(key, value);
      }

      res.status(upstream.status);

      if (!upstream.body) {
        res.end();
        return;
      }

      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          let text = decoder.decode(value, { stream: true });
          if (needModelRewrite) {
            text = text.replaceAll(`"model":"${mappedModel}"`, `"model":"${requestModel}"`);
          }
          res.write(text);
        }
      } catch (err) {
        logger.error(`[C${rid}] Stream error: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        reader.releaseLock();
      }

      res.end();
      logger.info(`[C${rid}] <<< completed (stream)`);
      return;
    }

    // For non-streaming requests
    if (!upstream.body) {
      res.status(upstream.status).json({ error: { message: "Empty response from backend", type: "upstream_error" } });
      return;
    }

    // If backend returns JSON directly, pass through
    if (!isSSE) {
      const responseText = await upstream.text();
      try {
        const responseJson = JSON.parse(responseText);
        if (needModelRewrite && responseJson.model) {
          responseJson.model = requestModel;
        }
        res.json(responseJson);
        logger.info(`[C${rid}] <<< completed (non-stream, JSON)`);
      } catch {
        res.status(upstream.status).send(responseText);
        logger.error(`[C${rid}] Non-stream response is not valid JSON`);
      }
      return;
    }

    // Backend returns SSE, aggregate chunks into JSON response
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const chunks: ChatCompletionChunk[] = [];

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
        const { events, remaining } = parseSSEBuffer(buffer);
        buffer = remaining;

        for (const evt of events) {
          const data = evt.data.trim();
          if (data === "[DONE]") continue;
          try {
            chunks.push(JSON.parse(data) as ChatCompletionChunk);
          } catch (parseErr) {
            logger.warn(`[C${rid}] Failed to parse SSE chunk: ${parseErr instanceof Error ? parseErr.message : parseErr}`);
          }
        }
      }
    } catch (err) {
      logger.error(`[C${rid}] Error reading stream: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      reader.releaseLock();
    }

    // Aggregate chunks into non-stream response
    const aggregated = aggregateChunks(chunks, requestModel);
    res.json(aggregated);
    logger.info(`[C${rid}] <<< completed (non-stream, ${chunks.length} chunks)`);
  });

  return router;
}

function aggregateChunks(chunks: ChatCompletionChunk[], requestModel?: string): object {
  if (chunks.length === 0) {
    return { error: { message: "No chunks received", type: "upstream_error" } };
  }

  const first = chunks[0];
  let content = "";
  let reasoningContent = "";
  let role = "";
  let finishReason = "";
  let usage = first.usage;
  const toolCallMap = new Map<number, { id: string; type: string; function: { name: string; arguments: string } }>();

  for (const chunk of chunks) {
    if (chunk.choices?.length) {
      const choice = chunk.choices[0];
      const delta = choice.delta;
      if (delta) {
        if (delta.role) role = delta.role;
        if (delta.content) content += delta.content;
        if (delta.reasoning_content) reasoningContent += delta.reasoning_content;
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (!toolCallMap.has(tc.index)) {
              toolCallMap.set(tc.index, {
                id: tc.id ?? "",
                type: tc.type ?? "function",
                function: { name: "", arguments: "" },
              });
            }
            const entry = toolCallMap.get(tc.index)!;
            if (tc.id) entry.id = tc.id;
            if (tc.function?.name) entry.function.name += tc.function.name;
            if (tc.function?.arguments) entry.function.arguments += tc.function.arguments;
          }
        }
      }
      if (choice.finish_reason) {
        finishReason = choice.finish_reason;
      }
    }
    if (chunk.usage && chunk.usage.total_tokens > 0) {
      usage = chunk.usage;
    }
  }

  const message: Record<string, unknown> = {
    role: role || "assistant",
    content: content || null,
  };
  if (reasoningContent) message.reasoning_content = reasoningContent;
  if (toolCallMap.size > 0) {
    message.tool_calls = [...toolCallMap.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, v]) => v);
  }

  return {
    id: first.id,
    object: "chat.completion",
    created: first.created,
    model: requestModel || first.model,
    choices: [{
      index: 0,
      message,
      finish_reason: finishReason || null,
    }],
    usage: usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}