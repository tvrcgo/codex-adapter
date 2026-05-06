import type { BackendConfig } from "../config.js";
import type {
  AnthropicMessagesRequest,
  AnthropicMessage,
  AnthropicContentBlock,
  AnthropicTool,
  AnthropicToolChoice,
} from "./anthropic-types.js";
import type {
  ChatCompletionsRequest,
  ChatMessage,
  ChatUserContentPart,
  ChatTool,
  ChatToolCall,
} from "./types.js";

/**
 * Transform Anthropic Messages API request to OpenAI Chat Completions format.
 */
export function transformAnthropicRequest(
  body: AnthropicMessagesRequest,
  backend: BackendConfig,
): ChatCompletionsRequest {
  const messages = buildMessages(body);

  const req: ChatCompletionsRequest = {
    model: body.model,
    messages,
    max_tokens: body.max_tokens,
    stream: body.stream ?? true,
    stream_options: { include_usage: true },
  };

  if (body.temperature != null) req.temperature = body.temperature;
  if (body.top_p != null) req.top_p = body.top_p;

  const tools = convertAnthropicTools(body.tools);
  if (tools) {
    req.tools = tools;
    const toolChoice = convertAnthropicToolChoice(body.tool_choice);
    if (toolChoice) req.tool_choice = toolChoice;
  }

  if (backend.extraBody) {
    Object.assign(req, backend.extraBody);
  }

  return req;
}

function buildMessages(body: AnthropicMessagesRequest): ChatMessage[] {
  const messages: ChatMessage[] = [];

  // Handle system prompt
  if (body.system) {
    const systemContent = typeof body.system === "string"
      ? body.system
      : body.system.map(b => b.text).join("\n\n");
    messages.push({ role: "system", content: systemContent });
  }

  // Convert messages
  for (const msg of body.messages) {
    const converted = convertMessage(msg);
    messages.push(...converted);
  }

  return messages;
}

function convertMessage(msg: AnthropicMessage): ChatMessage[] {
  const result: ChatMessage[] = [];

  if (msg.role === "user") {
    const content = typeof msg.content === "string"
      ? msg.content
      : convertUserContent(msg.content);

    // Check for tool_result blocks
    if (Array.isArray(msg.content)) {
      const toolResults = msg.content.filter(b => b.type === "tool_result");
      const otherContent = msg.content.filter(b => b.type !== "tool_result");

      // Add tool result messages
      for (const tr of toolResults) {
        const block = tr as { type: "tool_result"; tool_use_id: string; content?: string };
        const toolContent = typeof block.content === "string"
          ? block.content
          : JSON.stringify(block.content);
        result.push({
          role: "tool",
          tool_call_id: block.tool_use_id,
          content: toolContent,
        });
      }

      // Add remaining user content
      if (otherContent.length > 0) {
        result.push({
          role: "user",
          content: convertUserContent(otherContent),
        });
      }
    } else {
      result.push({ role: "user", content });
    }
  } else if (msg.role === "assistant") {
    const assistantMsg: ChatMessage = { role: "assistant", content: "" };

    if (typeof msg.content === "string") {
      assistantMsg.content = msg.content;
    } else if (Array.isArray(msg.content)) {
      const textParts: string[] = [];
      const toolCalls: ChatToolCall[] = [];

      for (const block of msg.content) {
        if (block.type === "text") {
          textParts.push(block.text);
        } else if (block.type === "tool_use") {
          toolCalls.push({
            id: block.id,
            type: "function",
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input),
            },
          });
        }
      }

      assistantMsg.content = textParts.join("") || null;
      if (toolCalls.length > 0) {
        (assistantMsg as { role: "assistant"; content?: string | null; tool_calls?: ChatToolCall[] }).tool_calls = toolCalls;
      }
    }

    result.push(assistantMsg);
  }

  return result;
}

function convertUserContent(blocks: AnthropicContentBlock[]): string | ChatUserContentPart[] {
  const parts: ChatUserContentPart[] = [];

  for (const block of blocks) {
    if (block.type === "text") {
      parts.push({ type: "text", text: block.text });
    } else if (block.type === "image") {
      if (block.source.type === "base64" && block.source.data) {
        const imageUrl = `data:${block.source.media_type || "image/png"};base64,${block.source.data}`;
        parts.push({ type: "image_url", image_url: { url: imageUrl } });
      } else if (block.source.type === "url" && block.source.url) {
        parts.push({ type: "image_url", image_url: { url: block.source.url } });
      }
    }
    // Skip tool_result blocks - handled separately
  }

  // If only text, return as string for simplicity
  if (parts.length === 1 && parts[0].type === "text") {
    return parts[0].text;
  }

  return parts;
}

function convertAnthropicTools(tools: AnthropicTool[] | undefined): ChatTool[] | undefined {
  if (!tools || tools.length === 0) return undefined;

  return tools.map(tool => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  }));
}

function convertAnthropicToolChoice(choice: AnthropicToolChoice | undefined): ChatCompletionsRequest["tool_choice"] {
  if (!choice) return undefined;

  switch (choice.type) {
    case "auto":
      return "auto";
    case "any":
      return "required";
    case "tool":
      return { type: "function", function: { name: choice.name } };
    default:
      return undefined;
  }
}
