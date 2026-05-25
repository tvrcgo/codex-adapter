import type { BackendConfig } from "../config.js";
import type {
  ResponsesRequest,
  ResponsesInputItem,
  ResponsesMessageItem,
  ResponsesFunctionCallItem,
  ResponsesFunctionCallOutputItem,
  ResponsesReasoningItem,
  ResponsesContentPart,
  ChatCompletionsRequest,
  ChatMessage,
  ChatUserMessage,
  ChatUserContentPart,
  ChatAssistantMessage,
  ChatToolCall,
} from "./types.js";
import { convertTools, convertToolChoice } from "./tools.js";
import type { BackendFeatures } from "../config.js";
import { logger } from "../utils/logger.js";

export function transformRequest(
  body: ResponsesRequest,
  backend: BackendConfig,
): ChatCompletionsRequest {
  let messages = buildMessages(body, backend.features);
  messages = validateMessageSequence(messages);

  for (const msg of messages) {
    if (msg.role === "assistant") {
      const aMsg = msg as ChatAssistantMessage;

      if (aMsg.content === null || aMsg.content === undefined) {
        aMsg.content = "";
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
  // Note: backend.extraBody === null means explicitly disable extraBody
  // backend.extraBody === undefined should not happen (config sets default)

  return req;
}

function buildMessages(body: ResponsesRequest, features?: BackendFeatures): ChatMessage[] {
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
    let pendingReasoning: string | null = null;

    while (i < items.length) {
      const item = items[i];

      if (isReasoningItem(item)) {
        const text = extractReasoningSummary(item as ResponsesReasoningItem);
        if (text) {
          pendingReasoning = pendingReasoning ? pendingReasoning + "\n" + text : text;
        }
        i++;
        continue;
      }

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
          const asstMsg: ChatAssistantMessage = { role: "assistant", content: "", tool_calls: toolCalls };
          if (pendingReasoning) {
            asstMsg.reasoning_content = pendingReasoning;
            pendingReasoning = null;
          }
          raw.push(asstMsg);
        }
        continue;
      }

      const msg = convertInputItem(item, features);
      if (msg) {
        if (pendingReasoning) {
          if (msg.role === "assistant") {
            (msg as ChatAssistantMessage).reasoning_content = pendingReasoning;
          }
          pendingReasoning = null;
        }
        raw.push(msg);
      }
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
 * - Merge consecutive assistant messages (backends like GLM-5 reject them)
 * - Remove orphaned tool messages (no matching preceding tool_call_id)
 * - Deduplicate duplicate tool_call_id in tool messages
 * - Remove empty assistant messages (no content, no tool_calls, no reasoning)
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

  // Second pass: filter + merge
  const seenCallIds = new Set<string>();
  const result: ChatMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "tool" && "tool_call_id" in msg) {
      const callId = msg.tool_call_id;
      if (!allCallIds.has(callId)) continue;
      if (seenCallIds.has(callId)) continue;
      seenCallIds.add(callId);
    }

    // Merge consecutive assistant messages to avoid backend rejection.
    // Codex CLI may produce these when duplicate output_item.done events
    // are recorded, or when an empty synth message precedes a tool call.
    const prev = result.length > 0 ? result[result.length - 1] : null;
    if (msg.role === "assistant" && prev && prev.role === "assistant") {
      const prevAsst = prev as ChatAssistantMessage;
      const curAsst = msg as ChatAssistantMessage;

      if (curAsst.content && curAsst.content !== "") {
        if (prevAsst.content && prevAsst.content !== "") {
          prevAsst.content += "\n" + curAsst.content;
        } else {
          prevAsst.content = curAsst.content;
        }
      }

      if (curAsst.reasoning_content) {
        prevAsst.reasoning_content = prevAsst.reasoning_content
          ? prevAsst.reasoning_content + "\n" + curAsst.reasoning_content
          : curAsst.reasoning_content;
      }

      if ("tool_calls" in curAsst && curAsst.tool_calls?.length) {
        prevAsst.tool_calls = [
          ...(prevAsst.tool_calls ?? []),
          ...curAsst.tool_calls,
        ];
      }



      continue; // skip pushing; merged into prev
    }

    result.push(msg);
  }

  // Third pass: remove empty assistant messages (no content, no tool_calls).
  // These are artifacts from previously synthesized SSE events that pollute
  // conversation history. Backends like GLM-5 may reject or misbehave with them.
  const filtered: ChatMessage[] = [];
  for (const msg of result) {
    if (msg.role === "assistant") {
      const asst = msg as ChatAssistantMessage;
      const hasContent = asst.content != null && asst.content !== "";
      const hasTools = asst.tool_calls != null && asst.tool_calls.length > 0;
      const hasReasoning = asst.reasoning_content != null && asst.reasoning_content !== "";
      if (!hasContent && !hasTools && !hasReasoning) continue;
    }
    filtered.push(msg);
  }

  return filtered;
}

function convertInputItem(item: ResponsesInputItem, features?: BackendFeatures): ChatMessage | null {
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

  const parts = convertUserContentParts(msgItem.content, features);
  if (parts.every((p) => p.type === "text")) {
    return { role: "user", content: parts.map((p) => (p as { text: string }).text).join("") };
  }
  return { role: "user", content: parts };
}

function convertAssistantItem(item: ResponsesMessageItem): ChatAssistantMessage {
  const text = extractTextContent(item.content);
  return { role: "assistant", content: text || null };
}

function convertUserContentParts(
  content: string | ResponsesContentPart[] | null | undefined,
  features?: BackendFeatures,
): ChatUserContentPart[] {
  if (content == null) return [{ type: "text", text: "" }];
  if (typeof content === "string") return [{ type: "text", text: content }];

  const parts = content
    .map((p): ChatUserContentPart | null => {
      if (p.type === "input_text" || p.type === "text") {
        return { type: "text", text: p.text };
      }
      if (p.type === "input_image") {
        if (!features?.vision) return null;
        return { type: "image_url", image_url: { url: (p as { image_url: string }).image_url } };
      }
      if (p.type === "input_file") {
        if (!features?.files) return null;
        return { type: "file", file: { file_id: (p as { file_id: string }).file_id } };
      }
      return null;
    })
    .filter((p): p is ChatUserContentPart => p !== null);

  if (parts.length === 0) return [{ type: "text", text: "[media filtered]" }];
  return parts;
}

function extractTextContent(content: string | ResponsesContentPart[] | null | undefined): string {
  if (content == null) return "";
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

function isReasoningItem(item: ResponsesInputItem): boolean {
  return (item as { type?: string }).type === "reasoning";
}

function extractReasoningSummary(item: ResponsesReasoningItem): string {
  if (!item.summary?.length) return "";
  return item.summary
    .map(s => s.text)
    .join("\n");
}
