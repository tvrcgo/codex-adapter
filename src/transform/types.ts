// ─── Responses API types (what Codex CLI sends/expects) ───

export interface ResponsesRequest {
  model: string;
  input: string | ResponsesInputItem[];
  instructions?: string;
  tools?: ResponsesTool[];
  tool_choice?: "auto" | "none" | "required" | { type: "function"; name: string };
  temperature?: number;
  max_output_tokens?: number;
  top_p?: number;
  stream?: boolean;
  text?: { format?: ResponsesTextFormat };
  reasoning?: { effort?: string };
  metadata?: Record<string, string>;
  previous_response_id?: string;
  store?: boolean;
  [key: string]: unknown;
}

export type ResponsesInputItem =
  | ResponsesMessageItem
  | ResponsesFunctionCallItem
  | ResponsesFunctionCallOutputItem;

export interface ResponsesMessageItem {
  type?: "message";
  role: "user" | "assistant" | "system" | "developer";
  content: string | ResponsesContentPart[];
}

export type ResponsesContentPart =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string }
  | { type: "input_file"; file_id: string }
  | { type: "output_text"; text: string }
  | { type: "refusal"; refusal: string }
  | { type: "text"; text: string };

export interface ResponsesFunctionCallItem {
  type: "function_call";
  id: string;
  call_id: string;
  name: string;
  arguments: string;
}

export interface ResponsesFunctionCallOutputItem {
  type: "function_call_output";
  call_id: string;
  output: string;
}

export interface ResponsesTool {
  type: "function" | "apply_patch" | "web_search_preview" | "code_edit" | string;
  name?: string;  // Optional for built-in tools that use type as name
  description?: string;
  parameters?: Record<string, unknown>;
  strict?: boolean;
}

export interface ResponsesTextFormat {
  type: "text" | "json_object" | "json_schema";
  name?: string;
  schema?: Record<string, unknown>;
  strict?: boolean;
}

// ─── Responses API SSE event types (what we send back to Codex) ───

export interface ResponseObject {
  id: string;
  object: "response";
  created_at: number;
  model: string;
  status: "in_progress" | "completed" | "failed" | "incomplete";
  output: ResponseOutputItem[];
  usage?: ResponseUsage;
  metadata?: Record<string, string>;
  error?: { message: string; type: string; code: string } | null;
}

export type ResponseOutputItem = ResponseMessageItem | ResponseFunctionCallItem;

export interface ResponseMessageItem {
  id: string;
  type: "message";
  role: "assistant";
  status: "in_progress" | "completed";
  content: ResponseContentPart[];
}

export interface ResponseFunctionCallItem {
  id: string;
  type: "function_call";
  call_id: string;
  name: string;
  arguments: string;
  status: "in_progress" | "completed";
}

export type ResponseContentPart = {
  type: "output_text";
  text: string;
  annotations?: unknown[];
};

export interface ResponseUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  input_tokens_details?: { cached_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
}

// ─── Chat Completions types (what we send to backend) ───

export interface ChatCompletionsRequest {
  model: string;
  messages: ChatMessage[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stream: boolean;
  tools?: ChatTool[];
  tool_choice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
  response_format?: { type: string; [key: string]: unknown };
  stream_options?: { include_usage: boolean };
  [key: string]: unknown;
}

export type ChatMessage =
  | ChatSystemMessage
  | ChatUserMessage
  | ChatAssistantMessage
  | ChatToolMessage;

export interface ChatSystemMessage {
  role: "system";
  content: string;
}

export interface ChatUserMessage {
  role: "user";
  content: string | ChatUserContentPart[];
}

export type ChatUserContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: string } };

export interface ChatAssistantMessage {
  role: "assistant";
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: ChatToolCall[];
}

export interface ChatToolMessage {
  role: "tool";
  tool_call_id: string;
  content: string;
}

export interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
    strict?: boolean;
  };
}

// ─── Chat Completions SSE chunk types (what backend returns) ───

export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: ChatChunkChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  } | null;
}

export interface ChatChunkChoice {
  index: number;
  delta: ChatChunkDelta;
  finish_reason: string | null;
}

export interface ChatChunkDelta {
  role?: "assistant";
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: ChatChunkToolCall[];
}

export interface ChatChunkToolCall {
  index: number;
  id?: string;
  type?: "function";
  function?: {
    name?: string;
    arguments?: string;
  };
}
