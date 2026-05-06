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
 *
 * The `inputTokenOffset` ensures Codex sees conservative token counts:
 *   reported input_tokens = real prompt_tokens + offset
 * This triggers Codex's compaction earlier when approaching context limits.
 */
export class ResponseStreamWriter {
  private res: Response;
  private model: string;
  private inputTokenOffset: number;

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

  constructor(res: Response, model: string, inputTokenOffset: number = 0) {
    this.res = res;
    this.model = model;
    this.inputTokenOffset = inputTokenOffset;
    this.responseId = genResponseId();
  }

  /** Update the token offset (can be called after backend responds with real prompt_tokens). */
  setInputTokenOffset(offset: number): void {
    this.inputTokenOffset = offset;
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

      // Track for buildOutputItems
      this.messageItemId = synthId;
      this.messageOutputIndex = synthOutputIndex;
      this.textContent = "";
      this.textPartEmitted = true;
      logger.info(`[finalize] Synthesized message item at output_index=${synthOutputIndex} for tool-only response`);
    }

    this.closeTextMessage();
    this.closeAllToolCalls();

    // Cache reasoning content for reuse
    if (this.reasoningContent) {
      const toolCallIds = Array.from(this.activeToolCalls.values()).map(tc => tc.callId);
      const key = makeReasoningKey(this.textContent, toolCallIds);
      cacheReasoning(key, this.reasoningContent);
    }

    this.closeTextMessage();
    this.closeAllToolCalls();

    const outputItems = this.buildOutputItems();

    // Log if text-only response (no tool calls)
    const hasToolCalls = this.activeToolCalls.size > 0;
    if (this.textContent && !hasToolCalls) {
      logger.debug(`[finalize] Text-only response (${this.textContent.length} chars): ${this.textContent.slice(0, 500)}`);
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

  // ©¤©¤©¤ Content delta with XML tool call detection ©¤©¤©¤

  /**
   * Handle content delta: detect XML-style tool calls from backends
   * that output tool calls as text (e.g., GLM-5/WPS) and convert them
   * to proper function_call events.
   * Also filters out thinking content (e.g., <millennia-thinking> tags).
   */
  private handleContentDelta(content: string): void {
    this.xmlContentBuffer += content;
    const bufLen = this.xmlContentBuffer.length;

    // First, strip out any thinking content (millennia-thinking tags from GLM-5)
    this.xmlContentBuffer = this.stripThinkingContent(this.xmlContentBuffer);

    // Try to extract complete XML tool calls from the buffer
    const extracted = this.extractXmlToolCalls(this.xmlContentBuffer);
    if (extracted) {
      const { calls, remaining, textBefore } = extracted;
      this.xmlContentBuffer = remaining;

      // Emit any text before the XML tags as regular text
      if (textBefore) {
        this.handleTextDelta(textBefore);
      }

      for (const call of calls) {
        this.emitXmlToolCall(call);
      }
      return;
    }

    // Check if we're potentially in the middle of an XML tool call
    if (this.isPartialXmlToolCall(this.xmlContentBuffer)) {
      // Don't emit yet - wait for more content to complete the pattern
      if (bufLen > 100) {
        logger.debug(`[handleContentDelta] Buffering ${bufLen} chars for partial XML: ${this.xmlContentBuffer.slice(-100)}`);
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

  /**
   * Strip thinking content from GLM-5/WPS backend.
   * The <millennia-thinking>...</millennia-thinking> tags contain internal reasoning
   * that should not be shown to the user.
   */
  private stripThinkingContent(content: string): string {
    // Remove complete thinking blocks
    return content.replace(/<millennia-thinking>[\s\S]*?<\/millennia-thinking>/gi, "");
  }

  /** Emit a single XML-detected tool call as a complete function_call event sequence. */
  private emitXmlToolCall(call: { name: string; arguments: Record<string, unknown> }): void {
    const tcIndex = this.xmlToolCallIndex++;
    const callId = genCallId();
    const itemId = genItemId();
    const outputIndex = this.nextOutputIndex++;
    const argsStr = JSON.stringify(call.arguments);

    // Emit output_item.added with function_call header
    const item: ResponseFunctionCallItem = {
      id: itemId,
      type: "function_call",
      call_id: callId,
      name: call.name,
      arguments: "",
      status: "in_progress",
    };

    sendEvent(this.res, "response.output_item.added", {
      type: "response.output_item.added",
      output_index: outputIndex,
      item,
    });

    // Emit arguments delta
    sendEvent(this.res, "response.function_call_arguments.delta", {
      type: "response.function_call_arguments.delta",
      item_id: itemId,
      output_index: outputIndex,
      call_id: callId,
      delta: argsStr,
    });

    // Track as active tool call for finalize/closeAllToolCalls
    this.activeToolCalls.set(tcIndex, {
      index: tcIndex,
      itemId,
      callId,
      name: call.name,
      arguments: argsStr,
      outputIndex,
      headerEmitted: true,
    });

    logger.info(`[XML->function_call] name=${call.name} args=${argsStr.slice(0, 100)}`);
  }

  /** Extract complete XML tool calls from content. Returns null if no complete pattern found. */
  private extractXmlToolCalls(content: string): {
    calls: Array<{ name: string; arguments: Record<string, unknown> }>;
    remaining: string;
    textBefore: string;
  } | null {
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];

    // Pattern 1: <command>JSON array</command> (GLM-5/WPS format)
    // e.g. <command>["powershell.exe", "-Command", "rg -n 'dir=' D:\\Code\\wpsweb --type html"]</command>
    const commandTagRegex = /<command>\s*([\s\S]*?)\s*<\/command>/g;
    let match: RegExpExecArray | null;
    let firstMatchStart = -1;
    let lastMatchEnd = 0;

    while ((match = commandTagRegex.exec(content)) !== null) {
      if (firstMatchStart === -1) firstMatchStart = match.index;
      lastMatchEnd = match.index + match[0].length;

      const inner = match[1].trim();
      try {
        const parsed = JSON.parse(inner);
        if (Array.isArray(parsed) && parsed.length > 0) {
          const cmd = String(parsed[0]);
          const args = parsed.slice(1).map((a: unknown) => String(a));
          calls.push({
            name: "shell",
            arguments: { command: cmd, args },
          });
        } else {
          calls.push({ name: "shell", arguments: { command: inner } });
        }
      } catch {
        calls.push({ name: "shell", arguments: { command: inner } });
      }
    }

    // Pattern 2: <execute>command</execute>
    if (calls.length === 0) {
      const executeTagRegex = /<execute>\s*([\s\S]*?)\s*<\/execute>/g;
      while ((match = executeTagRegex.exec(content)) !== null) {
        if (firstMatchStart === -1) firstMatchStart = match.index;
        lastMatchEnd = match.index + match[0].length;

        calls.push({
          name: "shell",
          arguments: { command: match[1].trim() },
        });
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

    // Incomplete thinking tag - buffer to hide thinking content
    if (/<millennia-thinking[^>]*$/i.test(trimmed)) return true;
    if (/<millennia-thinking[^>]*>/i.test(trimmed) && !/<\/millennia-thinking>/i.test(trimmed)) return true;

    // Incomplete opening tag
    if (/<[a-z]*$/.test(trimmed)) return true;
    if (/<command[^>]*$/.test(trimmed)) return true;
    if (/<execute[^>]*$/.test(trimmed)) return true;

    // Opened tag but not yet closed
    const openCmd = trimmed.match(/<command[^>]*>/);
    if (openCmd && !trimmed.includes("</command>")) return true;

    const openExec = trimmed.match(/<execute[^>]*>/);
    if (openExec && !trimmed.includes("</execute>")) return true;

    // Don't buffer too long without finding a pattern
    if (trimmed.length > 500) return false;

    return false;
  }

  // ©¤©¤©¤ Text handling ©¤©¤©¤

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
  }

  // ©¤©¤©¤ Tool call handling ©¤©¤©¤

  private handleToolCallDelta(tc: ChatChunkToolCall): void {
    let active = this.activeToolCalls.get(tc.index);

    // Create active tool call if we have either id or function.name
    // (some backends send name before id, or omit id entirely)
    if (!active && (tc.id || tc.function?.name)) {
      const callId = tc.id ?? genCallId();
      const name = tc.function?.name ?? "";
      logger.info(`[handleToolCallDelta] New tool call: index=${tc.index} id=${callId} name=${name}`);
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

    // Update id if it arrives in a later delta
    if (tc.id && active.callId !== tc.id) {
      active.callId = tc.id;
    }

    if (tc.function?.name && !active.headerEmitted) {
      active.name = tc.function.name;
      this.emitToolCallHeader(active);
      active.headerEmitted = true;
    }

    if (tc.function?.arguments) {
      active.arguments += tc.function.arguments;

      if (!active.headerEmitted) {
        this.emitToolCallHeader(active);
        active.headerEmitted = true;
      }

      sendEvent(this.res, "response.function_call_arguments.delta", {
        type: "response.function_call_arguments.delta",
        item_id: active.itemId,
        output_index: active.outputIndex,
        call_id: active.callId,
        delta: tc.function.arguments,
      });
    }
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
  }

  private closeAllToolCalls(): void {
    for (const active of this.activeToolCalls.values()) {
      sendEvent(this.res, "response.function_call_arguments.done", {
        type: "response.function_call_arguments.done",
        item_id: active.itemId,
        output_index: active.outputIndex,
        call_id: active.callId,
        arguments: active.arguments,
      });

      sendEvent(this.res, "response.output_item.done", {
        type: "response.output_item.done",
        output_index: active.outputIndex,
        item: {
          id: active.itemId,
          type: "function_call",
          call_id: active.callId,
          name: active.name,
          arguments: active.arguments,
          status: "completed",
        },
      });
    }
  }

  // ©¤©¤©¤ Response object builders ©¤©¤©¤

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
    const baseUsage = this.usage ?? { input_tokens: 0, output_tokens: 0, total_tokens: 0 };

    // Apply inputTokenOffset so Codex sees conservative token counts
    const usage: ResponseUsage = {
      input_tokens: baseUsage.input_tokens + this.inputTokenOffset,
      output_tokens: baseUsage.output_tokens,
      total_tokens: baseUsage.total_tokens + this.inputTokenOffset,
    };

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
        arguments: active.arguments,
        status: "completed",
      });
    }

    return items;
  }
}
