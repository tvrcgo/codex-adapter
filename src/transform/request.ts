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
} from "./types.js";
import { convertTools, convertToolChoice } from "./tools.js";
import { getCachedReasoning, makeReasoningKey } from "../utils/reasoning-cache.js";

export function transformRequest(
  body: ResponsesRequest,
  backend: BackendConfig,
): ChatCompletionsRequest {
  const messages = buildMessages(body);

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
    const toolChoice = convertToolChoice(body.tool_choice);
    if (toolChoice) req.tool_choice = toolChoice;
  }

  if (backend.extraBody) {
    Object.assign(req, backend.extraBody);
  }

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
  if (parts.length === 1 && parts[0].type === "text") {
    return { role: "user", content: parts[0].text };
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

// --- Context truncation ---

function estimateTokens(messages: ChatMessage[]): number {
  let chars = 0;
  for (const msg of messages) {
    chars += 4; // role overhead
    if (typeof msg.content === "string") {
      chars += msg.content.length;
    } else if (Array.isArray(msg.content)) {
      chars += JSON.stringify(msg.content).length;
    }
    if ("tool_calls" in msg && msg.tool_calls) {
      chars += JSON.stringify(msg.tool_calls).length;
    }
  }
  // ~3.5 chars per token on average (mixed English/Chinese/JSON)
  return Math.ceil(chars / 3.5);
}

interface TruncateResult {
  messages: ChatMessage[];
  dropped: number;
  beforeTokens: number;
  afterTokens: number;
}

function truncateMessages(messages: ChatMessage[], maxTokens: number): TruncateResult {
  const beforeTokens = estimateTokens(messages);
  if (beforeTokens <= maxTokens) {
    return { messages, dropped: 0, beforeTokens, afterTokens: beforeTokens };
  }

  // Split into: system (head) + conversation (middle + tail)
  let systemEnd = 0;
  while (systemEnd < messages.length && messages[systemEnd].role === "system") {
    systemEnd++;
  }
  const systemMsgs = messages.slice(0, systemEnd);
  const convMsgs = messages.slice(systemEnd);

  // Keep removing oldest conversation messages until under limit.
  // Respect tool call pairing: if an assistant message with tool_calls is kept,
  // its corresponding tool results must also be kept.
  const systemTokens = estimateTokens(systemMsgs);
  const budget = maxTokens - systemTokens;

  // Build from the tail (most recent messages first)
  const kept: ChatMessage[] = [];
  let keptTokens = 0;
  for (let i = convMsgs.length - 1; i >= 0; i--) {
    const msgTokens = estimateTokens([convMsgs[i]]);
    if (keptTokens + msgTokens > budget) break;
    kept.unshift(convMsgs[i]);
    keptTokens += msgTokens;
  }

  // Ensure tool_call pairing: if the first kept message is role=tool,
  // we need its preceding assistant message. Drop orphan tool messages from front.
  while (kept.length > 0 && kept[0].role === "tool") {
    keptTokens -= estimateTokens([kept[0]]);
    kept.shift();
  }

  const dropped = convMsgs.length - kept.length;
  const result = [...systemMsgs, ...kept];
  return {
    messages: result,
    dropped,
    beforeTokens,
    afterTokens: estimateTokens(result),
  };
}
