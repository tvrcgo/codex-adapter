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
  headerEmitted: boolean;
}

/**
 * Transform Chat Completions stream to Anthropic Messages stream format.
 *
 * When thinkingEnabled, maps backend reasoning_content to Anthropic thinking blocks.
 */
export class AnthropicResponseWriter {
  private res: Response;
  private model: string;
  private messageId: string;
  private thinkingEnabled: boolean;
  private messageStarted: boolean = false;
  private thinkingBlockIndex: number = -1;
  private contentBlockIndex: number = -1;
  private nextBlockIndex: number = 0;
  private activeToolCalls: Map<number, ActiveToolCall> = new Map();
  private inputTokens: number = 0;
  private outputTokens: number = 0;

  constructor(res: Response, model: string, thinkingEnabled: boolean = false) {
    this.res = res;
    this.model = model;
    this.thinkingEnabled = thinkingEnabled;
    this.messageId = genMsgId();
  }

  processChunk(chunk: ChatCompletionChunk): void {
    if (chunk.usage) {
      this.inputTokens = Math.max(this.inputTokens, chunk.usage.prompt_tokens ?? 0);
      this.outputTokens = chunk.usage.completion_tokens ?? 0;
    }

    if (!this.messageStarted) {
      this.emitMessageStart();
      this.messageStarted = true;
    }

    if (!chunk.choices?.length) return;

    for (const choice of chunk.choices) {
      const delta = choice.delta;
      if (!delta) continue;

      if (delta.reasoning_content != null && delta.reasoning_content !== "" && this.thinkingEnabled) {
        this.handleThinkingDelta(delta.reasoning_content);
      }

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

    if (this.thinkingBlockIndex >= 0) {
      this.emitContentBlockStop(this.thinkingBlockIndex);
      this.thinkingBlockIndex = -1;
    }

    for (const [, tc] of this.activeToolCalls) {
      // Flush any tool calls whose header was never emitted (name never arrived)
      if (!tc.headerEmitted) {
        this.emitContentBlockStart(tc.index, {
          type: "tool_use",
          id: tc.id,
          name: tc.name || "unknown",
          input: {},
        });
        if (tc.arguments) {
          this.sendEvent("content_block_delta", {
            type: "content_block_delta",
            index: tc.index,
            delta: { type: "input_json_delta", partial_json: tc.arguments },
          });
        }
      }
      this.emitContentBlockStop(tc.index);
    }

    if (this.contentBlockIndex >= 0) {
      this.emitContentBlockStop(this.contentBlockIndex);
    }

    this.emitMessageDelta();
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

  private handleThinkingDelta(thinking: string): void {
    if (this.thinkingBlockIndex < 0) {
      this.thinkingBlockIndex = this.nextBlockIndex++;
      this.emitContentBlockStart(this.thinkingBlockIndex, { type: "thinking", thinking: "" });
    }

    this.sendEvent("content_block_delta", {
      type: "content_block_delta",
      index: this.thinkingBlockIndex,
      delta: { type: "thinking_delta", thinking },
    });
  }

  private handleTextDelta(text: string): void {
    if (this.thinkingBlockIndex >= 0) {
      this.emitContentBlockStop(this.thinkingBlockIndex);
      this.thinkingBlockIndex = -1;
    }

    if (this.contentBlockIndex < 0) {
      this.contentBlockIndex = this.nextBlockIndex++;
      this.emitContentBlockStart(this.contentBlockIndex, { type: "text", text: "" });
    }

    this.sendEvent("content_block_delta", {
      type: "content_block_delta",
      index: this.contentBlockIndex,
      delta: { type: "text_delta", text },
    });
  }

  private handleToolCallDelta(tc: ChatChunkToolCall): void {
    const tcKey = tc.index;

    if (!this.activeToolCalls.has(tcKey)) {
      if (this.thinkingBlockIndex >= 0) {
        this.emitContentBlockStop(this.thinkingBlockIndex);
        this.thinkingBlockIndex = -1;
      }
      if (this.contentBlockIndex >= 0) {
        this.emitContentBlockStop(this.contentBlockIndex);
        this.contentBlockIndex = -1;
      }

      const blockIdx = this.nextBlockIndex++;
      const id = tc.id || genToolUseId();
      const name = tc.function?.name || "";
      this.activeToolCalls.set(tcKey, {
        index: blockIdx,
        id,
        name,
        arguments: "",
        headerEmitted: false,
      });
    }

    const active = this.activeToolCalls.get(tcKey)!;

    if (tc.id && active.id !== tc.id) {
      active.id = tc.id;
    }

    // When name arrives, emit header and flush buffered arguments
    if (tc.function?.name && !active.headerEmitted) {
      active.name = tc.function.name;
      this.emitContentBlockStart(active.index, {
        type: "tool_use",
        id: active.id,
        name: active.name,
        input: {},
      });
      active.headerEmitted = true;

      if (active.arguments) {
        this.sendEvent("content_block_delta", {
          type: "content_block_delta",
          index: active.index,
          delta: { type: "input_json_delta", partial_json: active.arguments },
        });
      }
    }

    if (tc.function?.arguments) {
      active.arguments += tc.function.arguments;

      if (active.headerEmitted) {
        this.sendEvent("content_block_delta", {
          type: "content_block_delta",
          index: active.index,
          delta: { type: "input_json_delta", partial_json: tc.function.arguments },
        });
      }
    }
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
    const stopReason = this.activeToolCalls.size > 0 ? "tool_use" : "end_turn";
    this.sendEvent("message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
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
