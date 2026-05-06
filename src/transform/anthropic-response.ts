import type { Response } from "express";
import type {
  ChatCompletionChunk,
  ChatChunkToolCall,
} from "./types.js";
import type {
  AnthropicMessageResponse,
  AnthropicContentBlock,
} from "./anthropic-types.js";
import { logger } from "../utils/logger.js";

let msgIdCounter = 0;
let toolUseCounter = 0;

function genMsgId(): string {
  return `msg_${++msgIdCounter}_${Date.now().toString(36)}`;
}

function genToolUseId(): string {
  return `toolu_${++toolUseCounter}_${Date.now().toString(36)}`;
}

interface ActiveToolCall {
  index: number;
  id: string;
  name: string;
  arguments: string;
}

/**
 * Transform Chat Completions stream to Anthropic Messages stream format.
 */
export class AnthropicResponseWriter {
  private res: Response;
  private model: string;
  private messageId: string;
  private messageStarted: boolean = false;
  private contentBlockIndex: number = -1;
  private activeToolCalls: Map<number, ActiveToolCall> = new Map();
  private inputTokens: number = 0;
  private outputTokens: number = 0;

  constructor(res: Response, model: string) {
    this.res = res;
    this.model = model;
    this.messageId = genMsgId();
  }

  processChunk(chunk: ChatCompletionChunk): void {
    // Update usage info
    if (chunk.usage) {
      this.inputTokens = Math.max(this.inputTokens, chunk.usage.prompt_tokens ?? 0);
      this.outputTokens = chunk.usage.completion_tokens ?? 0;
    }

    // Emit message_start on first chunk
    if (!this.messageStarted) {
      this.emitMessageStart();
      this.messageStarted = true;
    }

    if (!chunk.choices?.length) return;

    for (const choice of chunk.choices) {
      const delta = choice.delta;
      if (!delta) continue;

      if (delta.content != null && delta.content !== "") {
        this.handleTextDelta(delta.content);
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          this.handleToolCallDelta(tc);
        }
      }
    }
  }

  finalize(): void {
    if (!this.messageStarted) {
      this.emitMessageStart();
      this.messageStarted = true;
    }

    // Close any open tool calls
    for (const [index, tc] of this.activeToolCalls) {
      this.emitContentBlockStop(index);
    }

    // Close text block if open
    if (this.contentBlockIndex >= 0 && !this.activeToolCalls.has(this.contentBlockIndex)) {
      this.emitContentBlockStop(this.contentBlockIndex);
    }

    // Emit message_delta with stop_reason
    this.emitMessageDelta();

    // Emit message_stop
    this.emitMessageStop();
  }

  private emitMessageStart(): void {
    const message: AnthropicMessageResponse = {
      id: this.messageId,
      type: "message",
      role: "assistant",
      content: [],
      model: this.model,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: this.inputTokens, output_tokens: this.outputTokens },
    };

    this.sendEvent("message_start", { type: "message_start", message });
  }

  private handleTextDelta(text: string): void {
    if (this.contentBlockIndex < 0) {
      this.contentBlockIndex = this.activeToolCalls.size;
      this.emitContentBlockStart(this.contentBlockIndex, { type: "text", text: "" });
    }

    this.sendEvent("content_block_delta", {
      type: "content_block_delta",
      index: this.contentBlockIndex,
      delta: { type: "text_delta", text },
    });
  }

  private handleToolCallDelta(tc: ChatChunkToolCall): void {
    const index = tc.index;

    if (!this.activeToolCalls.has(index)) {
      // Close text block before starting tool call
      if (this.contentBlockIndex >= 0) {
        this.emitContentBlockStop(this.contentBlockIndex);
        this.contentBlockIndex = -1;
      }

      const id = tc.id || genToolUseId();
      const name = tc.function?.name || "";
      this.activeToolCalls.set(index, {
        index,
        id,
        name,
        arguments: "",
      });

      this.emitContentBlockStart(index, {
        type: "tool_use",
        id,
        name,
        input: {},
      });
    }

    const active = this.activeToolCalls.get(index)!;
    if (tc.function?.arguments) {
      active.arguments += tc.function.arguments;
    }

    this.sendEvent("content_block_delta", {
      type: "content_block_delta",
      index,
      delta: { type: "input_json_delta", partial_json: tc.function?.arguments || "" },
    });
  }

  private emitContentBlockStart(index: number, block: AnthropicContentBlock): void {
    this.sendEvent("content_block_start", {
      type: "content_block_start",
      index,
      content_block: block,
    });
  }

  private emitContentBlockStop(index: number): void {
    this.sendEvent("content_block_stop", {
      type: "content_block_stop",
      index,
    });
  }

  private emitMessageDelta(): void {
    this.sendEvent("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: this.outputTokens },
    });
  }

  private emitMessageStop(): void {
    this.sendEvent("message_stop", {
      type: "message_stop",
    });
  }

  private sendEvent(event: string, data: object): void {
    this.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
}
