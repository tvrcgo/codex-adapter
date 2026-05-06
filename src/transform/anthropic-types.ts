// Anthropic Messages API types

export interface AnthropicMessagesRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string | AnthropicSystemBlock[];
  max_tokens: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stream?: boolean;
  tools?: AnthropicTool[];
  tool_choice?: AnthropicToolChoice;
  stop_sequences?: string[];
  metadata?: { user_id?: string };
}

export type AnthropicMessage =
  | AnthropicUserMessage
  | AnthropicAssistantMessage;

export interface AnthropicUserMessage {
  role: "user";
  content: string | AnthropicContentBlock[];
}

export interface AnthropicAssistantMessage {
  role: "assistant";
  content?: string | AnthropicContentBlock[];
}

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

export interface AnthropicTextBlock {
  type: "text";
  text: string;
}

export interface AnthropicImageBlock {
  type: "image";
  source: {
    type: "base64" | "url";
    media_type?: string;
    data?: string;
    url?: string;
  };
}

export interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content?: string | AnthropicContentBlock[];
  is_error?: boolean;
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

export type AnthropicToolChoice =
  | { type: "auto" }
  | { type: "any" }
  | { type: "tool"; name: string };

export type AnthropicSystemBlock =
  | { type: "text"; text: string }
  | { type: "text"; text: string; cache_control?: { type: "ephemeral" } };

// Anthropic Streaming Response Types

export interface AnthropicMessageStartEvent {
  type: "message_start";
  message: AnthropicMessageResponse;
}

export interface AnthropicContentBlockStartEvent {
  type: "content_block_start";
  index: number;
  content_block: AnthropicContentBlock;
}

export interface AnthropicContentBlockDeltaEvent {
  type: "content_block_delta";
  index: number;
  delta: { type: "text_delta"; text: string } | { type: "input_json_delta"; partial_json: string };
}

export interface AnthropicContentBlockStopEvent {
  type: "content_block_stop";
  index: number;
}

export interface AnthropicMessageDeltaEvent {
  type: "message_delta";
  delta: { stop_reason: string | null; stop_sequence: string | null };
  usage?: { output_tokens: number };
}

export interface AnthropicMessageStopEvent {
  type: "message_stop";
}

export interface AnthropicMessageResponse {
  id: string;
  type: "message";
  role: "assistant";
  content: AnthropicContentBlock[];
  model: string;
  stop_reason: string | null;
  stop_sequence: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}
