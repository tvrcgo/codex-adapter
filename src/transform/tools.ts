import type {
  ResponsesTool,
  ChatTool,
} from "./types.js";

/**
 * Convert Responses API tool definitions to Chat Completions format.
 * Only `function` type tools are supported; others are silently dropped.
 */
export function convertTools(tools: ResponsesTool[] | undefined): ChatTool[] | undefined {
  if (!tools?.length) return undefined;

  const converted: ChatTool[] = [];
  for (const t of tools) {
    if (t.type !== "function") continue;
    converted.push({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        strict: t.strict,
      },
    });
  }
  return converted.length ? converted : undefined;
}

/**
 * Convert Responses API tool_choice to Chat Completions format.
 */
export function convertToolChoice(
  choice: "auto" | "none" | "required" | { type: "function"; name: string } | undefined,
): "auto" | "none" | "required" | { type: "function"; function: { name: string } } | undefined {
  if (!choice) return undefined;
  if (typeof choice === "string") return choice;
  return {
    type: "function",
    function: { name: choice.name },
  };
}
