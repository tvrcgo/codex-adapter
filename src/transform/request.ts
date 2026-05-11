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
  ChatUserMessage,
  ChatUserContentPart,
  ChatAssistantMessage,
  ChatToolCall,
} from "./types.js";
import { convertTools, convertToolChoice } from "./tools.js";
import { logger } from "../utils/logger.js";

const IMAGE_TAG_RE = /<\/?image>/gi;

/**
 * Strip image_url parts from user messages and collapse to plain text.
 * Text-only backends (GLM-5) reject image_url with "模型推理异常".
 */
function stripImageContent(messages: ChatMessage[]): void {
  for (const msg of messages) {
    if (msg.role !== "user") continue;
    const um = msg as ChatUserMessage;
    if (typeof um.content === "string") continue;
    if (!Array.isArray(um.content)) continue;

    const hasImage = um.content.some(p => p.type === "image_url");
    if (!hasImage) continue;

    // Keep only text parts, drop image_url and <image>/<image> markers
    const text = um.content
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map(p => p.text)
      .join("")
      .replace(IMAGE_TAG_RE, "")
      .trim();

    um.content = text || "[image]";
  }
}

export function transformRequest(
  body: ResponsesRequest,
  backend: BackendConfig,
): ChatCompletionsRequest {
  let messages = buildMessages(body);
  messages = validateMessageSequence(messages);

  // Strip image content — text-only backends (e.g. GLM-5) reject image_url parts
  // with "模型推理异常". Convert array content to plain text, dropping images and
  // their <image></image> markers.
  stripImageContent(messages);

  for (const msg of messages) {
    if (msg.role === "assistant") {
      const aMsg = msg as ChatAssistantMessage;

      if (aMsg.content === null || aMsg.content === undefined) {
        aMsg.content = "";
      }

      // Sanitize malformed tool_call arguments (defense-in-depth).
      // Primary protection is in response.ts; this catches edge cases
      // where malformed args somehow entered the conversation history.
      if (aMsg.tool_calls) {
        for (const tc of aMsg.tool_calls) {
          try {
            JSON.parse(tc.function.arguments);
          } catch {
            logger.warn(
              `[request] Malformed tool_call arguments in history for ${tc.function.name}, normalizing to {}`
            );
            tc.function.arguments = "{}";
          }
        }
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
          let args = fc.arguments;
          try {
            JSON.parse(args);
          } catch {
            logger.warn(`[request] Malformed function_call arguments from client for ${fc.name}, normalizing to {}`);
            args = "{}";
          }
          toolCalls.push({
            id: fc.call_id,
            type: "function",
            function: { name: fc.name, arguments: args },
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
 * - Merge consecutive assistant messages (backends like GLM-5 reject them)
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

      // Merge content: keep non-empty content, prefer the one with substance
      if (curAsst.content && (!prevAsst.content || prevAsst.content === "")) {
        prevAsst.content = curAsst.content;
      }

      // Merge tool_calls
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

  return result;
}

function convertInputItem(item: ResponsesInputItem): ChatMessage | null {
  if (isReasoningItem(item)) {
    return null;
  }

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

function convertUserContentParts(content: string | ResponsesContentPart[] | null | undefined): ChatUserContentPart[] {
  if (content == null) return [{ type: "text", text: "" }];
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
