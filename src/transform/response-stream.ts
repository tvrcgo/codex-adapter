import type { Response } from "express";
import type {
  ChatCompletionChunk,
  ChatChunkToolCall,
  ResponseObject,
  ResponseOutputItem,
  ResponseMessageItem,
  ResponseFunctionCallItem,
  ResponseContentPart,
  ResponseUsage,
} from "./types.js";
import { sendEvent } from "../utils/sse.js";
import { genResponseId, genMessageId, genItemId, genCallId } from "../utils/id.js";
import { logger } from "../utils/logger.js";
import { cacheReasoning, makeReasoningKey } from "../utils/reasoning-cache.js";

interface ActiveToolCall {
  index: number;
  itemId: string;
  callId: string;
  name: string;
  arguments: string;
  outputIndex: number;
  headerEmitted: boolean;
}

/**
 * Stateful transformer that receives Chat Completions chunks one at a time
 * and emits Responses API SSE events to the Express response.
 */
export class ResponseStreamWriter {
  private res: Response;
  private model: string;

  private responseId: string;
  private created: boolean = false;

  // Text message state
  private messageItemId: string | null = null;
  private messageOutputIndex: number = -1;
  private textContent: string = "";
  private reasoningContent: string = "";
  private textPartEmitted: boolean = false;

  // Tool call state
  private activeToolCalls: Map<number, ActiveToolCall> = new Map();
  private nextOutputIndex: number = 0;

  // XML tool call detection state
  private xmlContentBuffer: string = "";
  private xmlToolCallIndex: number = 1000;

  private usage: ResponseUsage | null = null;

  constructor(res: Response, model: string) {
    this.res = res;
    this.model = model;
    this.responseId = genResponseId();
  }

  /** Process a single parsed Chat Completions chunk. */
  processChunk(chunk: ChatCompletionChunk): void {
    if (!this.created) {
      this.emitCreated(chunk);
      this.created = true;
    }

    if (chunk.usage) {
      this.usage = {
        input_tokens: chunk.usage.prompt_tokens ?? 0,
        output_tokens: chunk.usage.completion_tokens ?? 0,
        total_tokens: chunk.usage.total_tokens ?? 0,
      };
    }

    if (!chunk.choices?.length) return;

    for (const choice of chunk.choices) {
      const delta = choice.delta;
      if (!delta) continue;

      if (delta.reasoning_content != null && delta.reasoning_content !== "") {
        this.reasoningContent += delta.reasoning_content;
      }

      if (delta.content != null && delta.content !== "") {
        // Log every content delta for root-cause analysis
        const raw = delta.content;
        const hasSpecial = /[<>\u0000-\u001f\u0080-\u009f]/.test(raw) || raw.includes('think');
        if (hasSpecial || raw.length > 0) {
          // Log repr-style: escape control chars and show exact content
          const repr = JSON.stringify(raw);
          logger.info(`[processChunk] raw content delta (${raw.length} chars): ${repr.length > 500 ? repr.slice(0, 500) + '...' : repr}`);
        }
        this.handleContentDelta(delta.content);
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          this.handleToolCallDelta(tc);
        }
      }
    }
  }

  /** Call after the upstream stream ends ([DONE]) to emit closing events. */
  finalize(hasContent: boolean = true): void {
    // Flush any remaining XML buffer as text
    if (this.xmlContentBuffer) {
      const toFlush = this.xmlContentBuffer;
      this.xmlContentBuffer = "";
      logger.debug(`[finalize] Flushing remaining xmlContentBuffer (${toFlush.length} chars): ${toFlush.slice(0, 300)}`);
      this.handleTextDelta(toFlush);
    }


    // If backend sent tool_calls without any text content, synthesize a message item
    // so Codex CLI receives proper SSE events (output_item.added, content_part.added, etc.)
    // Use the next available output_index so it doesn't collide with already-emitted tool calls.
    //
    // IMPORTANT: We emit the full lifecycle here (added → done) and do NOT set
    // messageItemId/textPartEmitted, so closeTextMessage() won't re-emit done events.
    // Codex CLI appends every output_item.done as a separate history entry without
    // dedup, so duplicate done events cause consecutive empty assistant messages in
    // the next request — which GLM-5 rejects as "模型推理异常".
    let synthOutputItem: ResponseOutputItem | null = null;

    if (!this.messageItemId && this.activeToolCalls.size > 0) {
      const synthId = genMessageId();
      const synthOutputIndex = this.nextOutputIndex++;
      const nowItem: ResponseMessageItem = {
        id: synthId,
        type: "message",
        role: "assistant",
        status: "in_progress",
        content: [],
      };

      sendEvent(this.res, "response.output_item.added", {
        type: "response.output_item.added",
        output_index: synthOutputIndex,
        item: nowItem,
      });

      sendEvent(this.res, "response.content_part.added", {
        type: "response.content_part.added",
        item_id: synthId,
        output_index: synthOutputIndex,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      });

      sendEvent(this.res, "response.output_text.done", {
        type: "response.output_text.done",
        item_id: synthId,
        output_index: synthOutputIndex,
        content_index: 0,
        text: "",
      });

      sendEvent(this.res, "response.content_part.done", {
        type: "response.content_part.done",
        item_id: synthId,
        output_index: synthOutputIndex,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      });

      sendEvent(this.res, "response.output_item.done", {
        type: "response.output_item.done",
        output_index: synthOutputIndex,
        item: {
          id: synthId,
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "", annotations: [] }],
        },
      });

      synthOutputItem = {
        id: synthId,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "", annotations: [] }],
      };

      logger.info(`[finalize] Synthesized message item at output_index=${synthOutputIndex} for tool-only response`);
    }

    // Build output items BEFORE closing (which resets state)
    const outputItems = this.buildOutputItems();
    if (synthOutputItem) {
      outputItems.unshift(synthOutputItem);
    }

    // Now close and send done events
    this.closeTextMessage();
    this.closeAllToolCalls();

    // Cache reasoning content for reuse
    if (this.reasoningContent) {
      const toolCallIds = Array.from(this.activeToolCalls.values()).map(tc => tc.callId);
      const key = makeReasoningKey(this.textContent, toolCallIds);
      cacheReasoning(key, this.reasoningContent);
    }

    // Log if text-only response (no tool calls)
    const hasToolCalls = outputItems.some(item => item.type === "function_call");
    if (this.textContent && !hasToolCalls) {
      const repr = JSON.stringify(this.textContent);
      logger.info(`[finalize] Text-only response (${this.textContent.length} chars): ${repr.length > 1000 ? repr.slice(0, 1000) + '...' : repr}`);
    }

    // If no content, synthesize an empty output so Codex receives a valid completed event
    if (outputItems.length === 0 || !hasContent) {
      const emptyMsgId = genMessageId();
      const emptyItem: ResponseMessageItem = {
        id: emptyMsgId,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "", annotations: [] }],
      };

      const response = this.buildResponseObject("completed", [emptyItem]);
      logger.debug(`[finalize] Empty response from backend, synthesized completed event`);
      sendEvent(this.res, "response.completed", {
        type: "response.completed",
        response,
      });
      return;
    }

    const response = this.buildResponseObject("completed", outputItems);
    logger.debug(`[finalize] usage=${JSON.stringify(response.usage)} output_items=${outputItems.length}`);
    sendEvent(this.res, "response.completed", {
      type: "response.completed",
      response,
    });
  }

  /** Call on upstream error. */
  emitError(message: string): void {
    if (!this.created) {
      this.emitCreated();
      this.created = true;
    }

    const response = this.buildResponseObject("failed", []);
    response.error = {
      message,
      type: "server_error",
      code: "upstream_error",
    };
    sendEvent(this.res, "response.failed", {
      type: "response.failed",
      response,
    });
  }

  // ������ Content delta with XML tool call detection ������

  /**
   * Handle content delta: detect XML-style tool calls from backends that
   * output tool calls as text (e.g., Hermes/Llama via vLLM, or models
   * prompted with OpenAI XML format) and convert them to function_call events.
   */
  private handleContentDelta(content: string): void {
    this.xmlContentBuffer += content;
    const bufLen = this.xmlContentBuffer.length;

    // Try to extract XML tool calls
    const extracted = this.extractXmlToolCalls(this.xmlContentBuffer);
    if (extracted) {
      const { calls, remaining, textBefore } = extracted;
      this.xmlContentBuffer = remaining;

      if (textBefore) {
        this.handleTextDelta(textBefore);
      }

      for (const call of calls) {
        this.emitXmlToolCall(call);
      }
      return;
    }

    // Check if we're potentially in the middle of an XML tool call pattern
    if (this.isPartialXmlToolCall(this.xmlContentBuffer)) {
      if (bufLen > 100) {
        logger.debug(`[handleContentDelta] Buffering ${bufLen} chars for partial pattern: ${this.xmlContentBuffer.slice(-100)}`);
      }
      return;
    }

    // Not an XML tool call - flush buffer as regular text
    if (this.xmlContentBuffer) {
      const toFlush = this.xmlContentBuffer;
      this.xmlContentBuffer = "";
      this.handleTextDelta(toFlush);
    }
  }

  /** Emit a single XML-detected tool call as a complete function_call event sequence. */
  private emitXmlToolCall(call: { name: string; arguments: Record<string, unknown> }): void {
    const tcIndex = this.xmlToolCallIndex++;
    const callId = genCallId();
    const itemId = genItemId();
    const outputIndex = this.nextOutputIndex++;
    const argsStr = JSON.stringify(call.arguments);

    const active: ActiveToolCall = {
      index: tcIndex,
      itemId,
      callId,
      name: call.name,
      arguments: argsStr,
      outputIndex,
      headerEmitted: true,
    };

    // header (output_item.added + output_tool_call.begin)
    this.emitToolCallHeader(active);

    // delta (both legacy + modern)
    this.emitToolCallArgumentsDelta(active, argsStr);

    // Track for finalize/closeAllToolCalls
    this.activeToolCalls.set(tcIndex, active);

    logger.info(`[XML->function_call] name=${call.name} args=${argsStr.slice(0, 100)}`);
  }

  /**
   * Extract complete XML tool calls from content.
   *
   * Supported formats:
   * - Hermes: <tool_call>{"name":"func","arguments":{...}}</tool_call>
   *   Also accepts "parameters" as alias for "arguments".
   * - OpenAI XML: <function=name><parameter=key>value</parameter></function>
   */
  private extractXmlToolCalls(content: string): {
    calls: Array<{ name: string; arguments: Record<string, unknown> }>;
    remaining: string;
    textBefore: string;
  } | null {
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    let firstMatchStart = -1;
    let lastMatchEnd = 0;

    // Pattern 1: Hermes — <tool_call>JSON</tool_call>
    const hermesRegex = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
    let match: RegExpExecArray | null;

    while ((match = hermesRegex.exec(content)) !== null) {
      if (firstMatchStart === -1) firstMatchStart = match.index;
      lastMatchEnd = match.index + match[0].length;

      try {
        const parsed = JSON.parse(match[1].trim());
        const name = parsed.name ?? parsed.function ?? "";
        const args = parsed.arguments ?? parsed.parameters ?? {};
        if (name) {
          calls.push({ name, arguments: typeof args === "object" ? args : {} });
        }
      } catch {
        logger.warn(`[extractXmlToolCalls] Failed to parse Hermes JSON: ${match[1].slice(0, 200)}`);
      }
    }

    // Pattern 2: OpenAI XML — <function=name>...<parameter=key>value</parameter>...</function>
    if (calls.length === 0) {
      const funcRegex = /<function=([^>]+)>([\s\S]*?)<\/function>/g;
      const paramRegex = /<parameter=([^>]+)>([\s\S]*?)<\/parameter>/g;

      while ((match = funcRegex.exec(content)) !== null) {
        if (firstMatchStart === -1) firstMatchStart = match.index;
        lastMatchEnd = match.index + match[0].length;

        const name = match[1].trim();
        const body = match[2];
        const args: Record<string, unknown> = {};

        let paramMatch: RegExpExecArray | null;
        paramRegex.lastIndex = 0;
        while ((paramMatch = paramRegex.exec(body)) !== null) {
          args[paramMatch[1].trim()] = paramMatch[2];
        }

        calls.push({ name, arguments: args });
      }
    }

    if (calls.length === 0) return null;

    const textBefore = firstMatchStart > 0 ? content.slice(0, firstMatchStart) : "";
    const remaining = lastMatchEnd < content.length ? content.slice(lastMatchEnd) : "";

    return { calls, remaining, textBefore };
  }

  /** Check if content might be the start of an incomplete XML tool call pattern. */
  private isPartialXmlToolCall(content: string): boolean {
    const trimmed = content.trimEnd();
    if (!trimmed) return false;

    // Incomplete opening tag
    if (/<[a-z_]*$/i.test(trimmed)) return true;
    if (/<tool_call[^>]*$/i.test(trimmed)) return true;
    if (/<function=[^>]*$/i.test(trimmed)) return true;

    // Opened but not yet closed
    if (/<tool_call[^>]*>/.test(trimmed) && !trimmed.includes("</tool_call>")) return true;
    if (/<function=[^>]+>/.test(trimmed) && !trimmed.includes("</function>")) return true;

    if (trimmed.length > 2000) return false;

    return false;
  }

  // ������ Text handling ������

  private handleTextDelta(content: string): void {
    if (!this.messageItemId) {
      this.openTextMessage();
    }

    this.textContent += content;
    sendEvent(this.res, "response.output_text.delta", {
      type: "response.output_text.delta",
      item_id: this.messageItemId,
      output_index: this.messageOutputIndex,
      content_index: 0,
      delta: content,
    });
  }

  private openTextMessage(): void {
    this.messageItemId = genMessageId();
    this.messageOutputIndex = this.nextOutputIndex++;

    const item: ResponseMessageItem = {
      id: this.messageItemId,
      type: "message",
      role: "assistant",
      status: "in_progress",
      content: [],
    };

    sendEvent(this.res, "response.output_item.added", {
      type: "response.output_item.added",
      output_index: this.messageOutputIndex,
      item,
    });

    this.textPartEmitted = true;
    sendEvent(this.res, "response.content_part.added", {
      type: "response.content_part.added",
      item_id: this.messageItemId,
      output_index: this.messageOutputIndex,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    });
  }

  private closeTextMessage(): void {
    if (!this.messageItemId) return;

    if (this.textPartEmitted) {
      sendEvent(this.res, "response.output_text.done", {
        type: "response.output_text.done",
        item_id: this.messageItemId,
        output_index: this.messageOutputIndex,
        content_index: 0,
        text: this.textContent,
      });

      sendEvent(this.res, "response.content_part.done", {
        type: "response.content_part.done",
        item_id: this.messageItemId,
        output_index: this.messageOutputIndex,
        content_index: 0,
        part: { type: "output_text", text: this.textContent, annotations: [] },
      });
    }

    sendEvent(this.res, "response.output_item.done", {
      type: "response.output_item.done",
      output_index: this.messageOutputIndex,
      item: {
        id: this.messageItemId,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: this.textContent, annotations: [] }],
      },
    });

    // Reset state to prevent duplicate close events
    this.messageItemId = null;
    this.textPartEmitted = false;
  }

  // ������ Tool call handling ������

  private handleToolCallDelta(tc: ChatChunkToolCall): void {
    let active = this.activeToolCalls.get(tc.index);

    // Create active entry on ANY tool_call field (id, name, or arguments).
    // Some backends send arguments before name; we buffer until name arrives.
    if (!active && (tc.id || tc.function?.name || tc.function?.arguments != null)) {
      const callId = tc.id ?? genCallId();
      const name = tc.function?.name ?? "";
      logger.info(`[handleToolCallDelta] New tool call: index=${tc.index} id=${callId} name=${name || "(pending)"}`);
      active = {
        index: tc.index,
        itemId: genItemId(),
        callId,
        name,
        arguments: "",
        outputIndex: this.nextOutputIndex++,
        headerEmitted: false,
      };
      this.activeToolCalls.set(tc.index, active);
    }

    if (!active) {
      logger.warn("Tool call delta without prior header, index=" + tc.index);
      return;
    }

    if (tc.id && active.callId !== tc.id) {
      active.callId = tc.id;
    }

    // When name arrives, emit header and flush any buffered arguments
    if (tc.function?.name && !active.headerEmitted) {
      active.name = tc.function.name;
      this.emitToolCallHeader(active);
      active.headerEmitted = true;

      if (active.arguments) {
        this.emitToolCallArgumentsDelta(active, active.arguments);
      }
    }

    if (tc.function?.arguments) {
      active.arguments += tc.function.arguments;

      // If header already emitted, send delta immediately;
      // otherwise arguments are buffered until name arrives.
      if (active.headerEmitted) {
        this.emitToolCallArgumentsDelta(active, tc.function.arguments);
      }
    }
  }

  /** Emit both legacy and modern argument delta events. */
  private emitToolCallArgumentsDelta(active: ActiveToolCall, delta: string): void {
    // Legacy: function_call_arguments.delta
    sendEvent(this.res, "response.function_call_arguments.delta", {
      type: "response.function_call_arguments.delta",
      item_id: active.itemId,
      output_index: active.outputIndex,
      call_id: active.callId,
      delta,
    });

    // Modern: output_tool_call.delta
    sendEvent(this.res, "response.output_tool_call.delta", {
      type: "response.output_tool_call.delta",
      output_index: active.outputIndex,
      item_id: active.itemId,
      call_id: active.callId,
      delta,
    });
  }

  private emitToolCallHeader(active: ActiveToolCall): void {
    const item: ResponseFunctionCallItem = {
      id: active.itemId,
      type: "function_call",
      call_id: active.callId,
      name: active.name,
      arguments: "",
      status: "in_progress",
    };

    sendEvent(this.res, "response.output_item.added", {
      type: "response.output_item.added",
      output_index: active.outputIndex,
      item,
    });

    // Modern: output_tool_call.begin
    sendEvent(this.res, "response.output_tool_call.begin", {
      type: "response.output_tool_call.begin",
      output_index: active.outputIndex,
      item_id: active.itemId,
      call_id: active.callId,
      name: active.name,
    });
  }

  private closeAllToolCalls(): void {
    // Clear the map first to prevent duplicate close events
    const calls = Array.from(this.activeToolCalls.values());
    this.activeToolCalls.clear();

    for (const active of calls) {
      // Flush header if never emitted (name arrived late or never)
      if (!active.headerEmitted) {
        this.emitToolCallHeader(active);
      }
      const safeArgs = ResponseStreamWriter.sanitizeArguments(active.arguments);

      // Legacy: function_call_arguments.done
      sendEvent(this.res, "response.function_call_arguments.done", {
        type: "response.function_call_arguments.done",
        item_id: active.itemId,
        output_index: active.outputIndex,
        call_id: active.callId,
        arguments: safeArgs,
      });

      // Modern: output_tool_call.done
      sendEvent(this.res, "response.output_tool_call.done", {
        type: "response.output_tool_call.done",
        output_index: active.outputIndex,
        item_id: active.itemId,
        call_id: active.callId,
        name: active.name,
        arguments: safeArgs,
      });

      sendEvent(this.res, "response.output_item.done", {
        type: "response.output_item.done",
        output_index: active.outputIndex,
        item: {
          id: active.itemId,
          type: "function_call",
          call_id: active.callId,
          name: active.name,
          arguments: safeArgs,
          status: "completed",
        },
      });
    }
  }

  /**
   * Validate tool_call arguments JSON. If malformed, normalize to valid JSON
   * so the client never accumulates invalid JSON in conversation history.
   * This mirrors what wps-claude-code does with `safeParseJSON(args) ?? {}`.
   */
  private static sanitizeArguments(raw: string): string {
    if (!raw || raw === "{}") return raw || "{}";
    try {
      JSON.parse(raw);
      return raw;
    } catch {
      logger.warn(
        `Malformed tool_call arguments detected (${raw.length} chars), normalizing to {}. Preview: ${raw.slice(0, 200)}`
      );
      return "{}";
    }
  }

  // ������ Response object builders ������

  private emitCreated(chunk?: ChatCompletionChunk): void {
    const response = this.buildResponseObject("in_progress", []);
    sendEvent(this.res, "response.created", {
      type: "response.created",
      response,
    });
    sendEvent(this.res, "response.in_progress", {
      type: "response.in_progress",
      response,
    });
  }

  private buildResponseObject(
    status: ResponseObject["status"],
    output: ResponseOutputItem[],
  ): ResponseObject {
    const usage = this.usage ?? { input_tokens: 0, output_tokens: 0, total_tokens: 0 };

    return {
      id: this.responseId,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      model: this.model,
      status,
      output,
      usage,
    };
  }

  private buildOutputItems(): ResponseOutputItem[] {
    const items: ResponseOutputItem[] = [];

    if (this.messageItemId) {
      const content: ResponseContentPart[] = [
        { type: "output_text", text: this.textContent, annotations: [] },
      ];
      items.push({
        id: this.messageItemId,
        type: "message",
        role: "assistant",
        status: "completed",
        content,
      });
    }

    for (const active of this.activeToolCalls.values()) {
      items.push({
        id: active.itemId,
        type: "function_call",
        call_id: active.callId,
        name: active.name,
        arguments: ResponseStreamWriter.sanitizeArguments(active.arguments),
        status: "completed",
      });
    }

    return items;
  }
}
