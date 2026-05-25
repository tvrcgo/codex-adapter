import type { Response } from "express";
import type {
  ChatCompletionChunk,
  ChatChunkToolCall,
  ResponseObject,
  ResponseOutputItem,
  ResponseMessageItem,
  ResponseFunctionCallItem,
  ResponseReasoningItem,
  ResponseContentPart,
  ResponseUsage,
} from "./types.js";
import { sendEvent } from "../utils/sse.js";
import { genResponseId, genMessageId, genItemId, genCallId, genReasoningId } from "../utils/id.js";
import { logger } from "../utils/logger.js";


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

  // Reasoning state
  private reasoningItemId: string | null = null;
  private reasoningOutputIndex: number = -1;
  private reasoningSummaryText: string = "";
  private completedReasoningItem: ResponseReasoningItem | null = null;

  // Text message state
  private messageItemId: string | null = null;
  private messageOutputIndex: number = -1;
  private textContent: string = "";
  private textPartEmitted: boolean = false;

  // Tool call state
  private activeToolCalls: Map<number, ActiveToolCall> = new Map();
  private nextOutputIndex: number = 0;

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
        this.handleReasoningDelta(delta.reasoning_content);
      }

      if (delta.content != null && delta.content !== "") {
        this.closeReasoning();
        this.handleContentDelta(delta.content);
      }

      if (delta.tool_calls) {
        this.closeReasoning();
        for (const tc of delta.tool_calls) {
          this.handleToolCallDelta(tc);
        }
      }
    }
  }

  /** Call after the upstream stream ends ([DONE]) to emit closing events. */
  finalize(hasContent: boolean = true): void {
    // Build output items BEFORE closing (which resets state)
    const outputItems = this.buildOutputItems();

    // Now close and send done events
    this.closeReasoning();
    this.closeTextMessage();
    this.closeAllToolCalls();

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

  private handleContentDelta(content: string): void {
    this.handleTextDelta(content);
  }


  private handleReasoningDelta(content: string): void {
    if (!this.reasoningItemId) {
      this.openReasoning();
    }

    this.reasoningSummaryText += content;
    sendEvent(this.res, "response.reasoning_summary_text.delta", {
      type: "response.reasoning_summary_text.delta",
      item_id: this.reasoningItemId,
      output_index: this.reasoningOutputIndex,
      summary_index: 0,
      delta: content,
    });
  }

  private openReasoning(): void {
    this.reasoningItemId = genReasoningId();
    this.reasoningOutputIndex = this.nextOutputIndex++;

    const item: ResponseReasoningItem = {
      id: this.reasoningItemId,
      type: "reasoning",
      summary: [],
      encrypted_content: null,
      status: "in_progress",
    };

    sendEvent(this.res, "response.output_item.added", {
      type: "response.output_item.added",
      output_index: this.reasoningOutputIndex,
      item,
    });

    sendEvent(this.res, "response.reasoning_summary_part.added", {
      type: "response.reasoning_summary_part.added",
      item_id: this.reasoningItemId,
      output_index: this.reasoningOutputIndex,
      summary_index: 0,
      part: { type: "summary_text", text: "" },
    });
  }

  private closeReasoning(): void {
    if (!this.reasoningItemId) return;

    const item: ResponseReasoningItem = {
      id: this.reasoningItemId,
      type: "reasoning",
      summary: [{ type: "summary_text", text: this.reasoningSummaryText }],
      encrypted_content: null,
      status: "completed",
    };

    sendEvent(this.res, "response.output_item.done", {
      type: "response.output_item.done",
      output_index: this.reasoningOutputIndex,
      item,
    });

    this.completedReasoningItem = item;
    this.reasoningItemId = null;
  }

  // ── Text handling ──

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
      const args = active.arguments || "{}";

      // Legacy: function_call_arguments.done
      sendEvent(this.res, "response.function_call_arguments.done", {
        type: "response.function_call_arguments.done",
        item_id: active.itemId,
        output_index: active.outputIndex,
        call_id: active.callId,
        arguments: args,
      });

      // Modern: output_tool_call.done
      sendEvent(this.res, "response.output_tool_call.done", {
        type: "response.output_tool_call.done",
        output_index: active.outputIndex,
        item_id: active.itemId,
        call_id: active.callId,
        name: active.name,
        arguments: args,
      });

      sendEvent(this.res, "response.output_item.done", {
        type: "response.output_item.done",
        output_index: active.outputIndex,
        item: {
          id: active.itemId,
          type: "function_call",
          call_id: active.callId,
          name: active.name,
          arguments: args,
          status: "completed",
        },
      });
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

    if (this.completedReasoningItem) {
      items.push(this.completedReasoningItem);
    } else if (this.reasoningItemId) {
      items.push({
        id: this.reasoningItemId,
        type: "reasoning",
        summary: [{ type: "summary_text", text: this.reasoningSummaryText }],
        encrypted_content: null,
        status: "completed",
      });
    }

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
        arguments: active.arguments || "{}",
        status: "completed",
      });
    }

    return items;
  }
}
