import type { BackendConfig } from "../config.js";
import type {
  ResponsesRequest,
  ResponsesInputItem,
  ResponsesMessageItem,
  ResponsesFunctionCallItem,
  ResponsesFunctionCallOutputItem,
  ResponsesContentPart,
  ChatCompletionsRequest,
  ChatMessage,
  ChatUserContentPart,
  ChatAssistantMessage,
  ChatToolCall,
  ChatTool,
} from "./types.js";
import { convertTools, convertToolChoice } from "./tools.js";
import { getCachedReasoning, makeReasoningKey } from "../utils/reasoning-cache.js";

export function transformRequest(
  body: ResponsesRequest,
  backend: BackendConfig,
): ChatCompletionsRequest {
  let messages = buildMessages(body);
  messages = validateMessageSequence(messages);

  for (const msg of messages) {
    if (msg.role === "assistant") {
      const aMsg = msg as ChatAssistantMessage;
      const toolCallIds = aMsg.tool_calls?.map(tc => tc.id);
      const key = makeReasoningKey(aMsg.content, toolCallIds);
      const reasoning = getCachedReasoning(key);
      if (reasoning) {
        aMsg.reasoning_content = reasoning;
      }
    }
  }

  const model = backend.models.includes(body.model)
    ? body.model
    : backend.models[0];

  const req: ChatCompletionsRequest = {
    model,
    messages,
    stream: true,
  };

  if (body.max_output_tokens != null) req.max_tokens = body.max_output_tokens;
  if (body.temperature != null) req.temperature = body.temperature;
  if (body.top_p != null) req.top_p = body.top_p;

  const tools = convertTools(body.tools);
  if (tools) {
    req.tools = tools;

    // Handle tool_choice: backend config can force "required" to prevent text-only responses
    if (backend.forceToolChoice) {
      req.tool_choice = "required";
    } else {
      const toolChoice = convertToolChoice(body.tool_choice);
      if (toolChoice) req.tool_choice = toolChoice;
    }
  }

  if (backend.extraBody) {
    Object.assign(req, backend.extraBody);
  }
  // Note: backend.extraBody === null means explicitly disable extraBody
  // backend.extraBody === undefined should not happen (config sets default)

  return req;
}

function buildMessages(body: ResponsesRequest): ChatMessage[] {
  const raw: ChatMessage[] = [];

  if (body.instructions) {
    raw.push({ role: "system", content: body.instructions });
  }

  if (typeof body.input === "string") {
    raw.push({ role: "user", content: body.input });
    return mergeSystemMessages(raw);
  }

  if (Array.isArray(body.input)) {
    const items = body.input;
    let i = 0;
    while (i < items.length) {
      const item = items[i];

      if (isFunctionCallItem(item)) {
        const toolCalls: ChatToolCall[] = [];
        const prevMsg = raw.length > 0 ? raw[raw.length - 1] : null;
        let mergeTarget: ChatAssistantMessage | null = null;
        if (prevMsg && prevMsg.role === "assistant" && !("tool_call_id" in prevMsg)) {
          mergeTarget = prevMsg as ChatAssistantMessage;
        }

        while (i < items.length && isFunctionCallItem(items[i])) {
          const fc = items[i] as ResponsesFunctionCallItem;
          toolCalls.push({
            id: fc.call_id,
            type: "function",
            function: { name: fc.name, arguments: fc.arguments },
          });
          i++;
        }

        if (mergeTarget) {
          mergeTarget.tool_calls = [
            ...(mergeTarget.tool_calls ?? []),
            ...toolCalls,
          ];
        } else {
          raw.push({ role: "assistant", content: "", tool_calls: toolCalls });
        }
        continue;
      }

      const msg = convertInputItem(item);
      if (msg) raw.push(msg);
      i++;
    }
  }

  return mergeSystemMessages(raw);
}

function mergeSystemMessages(messages: ChatMessage[]): ChatMessage[] {
  const systemParts: string[] = [];
  const rest: ChatMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "system" && typeof msg.content === "string") {
      systemParts.push(msg.content);
    } else {
      rest.push(msg);
    }
  }

  if (systemParts.length === 0) return rest;
  return [{ role: "system", content: systemParts.join("\n\n") }, ...rest];
}

/**
 * Validate and clean message sequence for Chat Completions API compatibility.
 * - Remove orphaned tool messages (no matching preceding tool_call_id)
 * - Deduplicate duplicate tool_call_id in tool messages
 */
function validateMessageSequence(messages: ChatMessage[]): ChatMessage[] {
  // First pass: collect all tool_call_ids from assistant messages
  const allCallIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role === "assistant" && "tool_calls" in msg && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        allCallIds.add(tc.id);
      }
    }
  }

  // Second pass: track seen tool_call_ids and filter orphaned/duplicate tool messages
  const seenCallIds = new Set<string>();
  const result: ChatMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "tool" && "tool_call_id" in msg) {
      const callId = msg.tool_call_id;
      // Skip orphaned tool message (no matching call_id in history)
      if (!allCallIds.has(callId)) continue;
      // Skip duplicate tool_call_id
      if (seenCallIds.has(callId)) continue;
      seenCallIds.add(callId);
    }
    result.push(msg);
  }

  return result;
}

function convertInputItem(item: ResponsesInputItem): ChatMessage | null {
  if (isFunctionCallOutputItem(item)) {
    return {
      role: "tool",
      tool_call_id: item.call_id,
      content: item.output,
    };
  }

  const msgItem = item as ResponsesMessageItem;
  const role = mapRole(msgItem.role);

  if (role === "system") {
    const text = extractTextContent(msgItem.content);
    return { role: "system", content: text };
  }

  if (role === "assistant") {
    return convertAssistantItem(msgItem);
  }

  // user
  if (typeof msgItem.content === "string") {
    return { role: "user", content: msgItem.content };
  }

  const parts = convertUserContentParts(msgItem.content);
  // If all parts are plain text, merge them into a string (WPS/GLM doesn't support array content)
  if (parts.every((p) => p.type === "text")) {
    return { role: "user", content: parts.map((p) => p.text).join("") };
  }
  return { role: "user", content: parts };
}

function convertAssistantItem(item: ResponsesMessageItem): ChatAssistantMessage {
  const text = extractTextContent(item.content);
  return { role: "assistant", content: text || null };
}

function convertUserContentParts(content: string | ResponsesContentPart[]): ChatUserContentPart[] {
  if (typeof content === "string") return [{ type: "text", text: content }];

  return content
    .map((p): ChatUserContentPart | null => {
      if (p.type === "input_text" || p.type === "text") {
        return { type: "text", text: p.text };
      }
      if (p.type === "input_image") {
        return { type: "image_url", image_url: { url: p.image_url } };
      }
      return null;
    })
    .filter((p): p is ChatUserContentPart => p !== null);
}

function extractTextContent(content: string | ResponsesContentPart[]): string {
  if (typeof content === "string") return content;
  return content
    .map((p) => {
      if ("text" in p) return p.text;
      if ("refusal" in p) return p.refusal;
      return "";
    })
    .join("");
}

function mapRole(role: string): "system" | "user" | "assistant" {
  if (role === "system" || role === "developer") return "system";
  if (role === "assistant") return "assistant";
  return "user";
}

function isFunctionCallItem(item: ResponsesInputItem): item is ResponsesFunctionCallItem {
  return (item as ResponsesFunctionCallItem).type === "function_call";
}

function isFunctionCallOutputItem(item: ResponsesInputItem): item is ResponsesFunctionCallOutputItem {
  return (item as ResponsesFunctionCallOutputItem).type === "function_call_output";
}

// --- Token estimation constants ---
// Conservative chars-per-token ratios; err toward overestimation.

const CHARS_PER_TOKEN_TEXT = 3.0;   // Natural language content
const CHARS_PER_TOKEN_JSON = 2.0;   // JSON / structured content (tool_calls, content parts)
const CHARS_PER_TOKEN_TOOLS = 1.8;  // Tool schemas (densest JSON with short keys)

const PER_MESSAGE_TOKENS = 6;       // Chat template boundary tokens per message
const PER_TOOL_CALL_ID_TOKENS = 4;  // tool_call_id field on tool-role messages

// --- Tool message compression ---
// When estimated tokens approach the context limit, compress old tool exchanges
// into compact text while keeping recent ones intact.

const KEEP_RECENT_TOOL_ROUNDS = 4;
const TOOL_RESULT_MAX_CHARS = 300;

/**
 * Compress old tool rounds when estimated tokens exceed threshold.
 * @param maxTokens Backend context token limit. If unset, defaults to 128000.
 */
export function compressToolMessages(
  chatReq: ChatCompletionsRequest,
  maxTokens?: number,
): { compressed: boolean; rounds: number } {
  const limit = maxTokens ?? 128000;
  const threshold = Math.floor(limit * 0.75);

  const currentEst = estimateTokens(chatReq.messages) + estimateToolTokens(chatReq.tools);
  if (currentEst <= threshold) return { compressed: false, rounds: 0 };

  let compressedCount = 0;

  while (true) {
    const rounds = identifyToolRounds(chatReq.messages);
    if (rounds.length <= KEEP_RECENT_TOOL_ROUNDS) break;

    compressRound(chatReq.messages, rounds[0]);
    compressedCount++;

    if (estimateTokens(chatReq.messages) + estimateToolTokens(chatReq.tools) <= threshold) break;
  }

  return { compressed: compressedCount > 0, rounds: compressedCount };
}

interface ToolRound {
  assistantIdx: number;
  toolIndices: number[];
}

function identifyToolRounds(messages: ChatMessage[]): ToolRound[] {
  const rounds: ToolRound[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "assistant" || !("tool_calls" in msg) || !msg.tool_calls?.length) continue;

    const callIds = new Set(msg.tool_calls.map(tc => tc.id));
    const toolIndices: number[] = [];

    for (let j = i + 1; j < messages.length; j++) {
      const next = messages[j];
      if (next.role === "tool" && "tool_call_id" in next && callIds.has(next.tool_call_id)) {
        toolIndices.push(j);
      } else if (next.role !== "tool") {
        break;
      }
    }

    if (toolIndices.length > 0) {
      rounds.push({ assistantIdx: i, toolIndices });
    }
  }

  return rounds;
}

function compressRound(messages: ChatMessage[], round: ToolRound): void {
  const assistantMsg = messages[round.assistantIdx] as ChatAssistantMessage;
  const toolCalls = assistantMsg.tool_calls!;

  // Build compact text representation
  const parts: string[] = [];
  if (assistantMsg.content) parts.push(assistantMsg.content);

  for (const tc of toolCalls) {
    const args = tc.function.arguments;
    const argsSummary = args.length > 100 ? args.slice(0, 100) + "..." : args;
    parts.push(`[Called ${tc.function.name}(${argsSummary})]`);
  }

  // Merge tool results into the text
  for (const idx of round.toolIndices) {
    const toolMsg = messages[idx] as { role: "tool"; tool_call_id: string; content: string };
    const matchingCall = toolCalls.find(tc => tc.id === toolMsg.tool_call_id);
    const name = matchingCall?.function.name ?? "tool";

    const content = toolMsg.content;
    if (content.length > TOOL_RESULT_MAX_CHARS) {
      parts.push(`[${name} result (${content.length} chars): ${content.slice(0, TOOL_RESULT_MAX_CHARS)}...]`);
    } else {
      parts.push(`[${name} result: ${content}]`);
    }
  }

  // Replace assistant message: remove tool_calls, set content to compact text
  (messages[round.assistantIdx] as ChatAssistantMessage) = {
    role: "assistant",
    content: parts.join("\n"),
  };

  // Remove tool result messages (iterate in reverse to preserve indices)
  const sortedIndices = [...round.toolIndices].sort((a, b) => b - a);
  for (const idx of sortedIndices) {
    messages.splice(idx, 1);
  }
}

// --- Token estimation ---

export function estimateTokens(messages: ChatMessage[]): number {
  let tokens = 0;
  for (const msg of messages) {
    tokens += PER_MESSAGE_TOKENS;

    if (typeof msg.content === "string") {
      tokens += Math.ceil(msg.content.length / CHARS_PER_TOKEN_TEXT);
    } else if (Array.isArray(msg.content)) {
      tokens += Math.ceil(JSON.stringify(msg.content).length / CHARS_PER_TOKEN_JSON);
    }

    if ("tool_calls" in msg && msg.tool_calls) {
      tokens += Math.ceil(JSON.stringify(msg.tool_calls).length / CHARS_PER_TOKEN_JSON);
    }

    if ("tool_call_id" in msg) {
      tokens += PER_TOOL_CALL_ID_TOKENS;
    }
  }
  return tokens;
}

export function estimateToolTokens(tools: ChatTool[] | undefined): number {
  if (!tools?.length) return 0;

  const toolsJsonLen = JSON.stringify(tools).length;
  let tokens = Math.ceil(toolsJsonLen / CHARS_PER_TOKEN_TOOLS);

  // Per-tool chat template formatting overhead
  tokens += tools.length * 8;

  // System prompt overhead for tool definitions
  tokens += 40;

  return tokens;
}
