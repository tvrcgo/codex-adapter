import type {
  ResponsesTool,
  ChatTool,
} from "./types.js";

/**
 * Convert Responses API tool definitions to Chat Completions format.
 * All tool types (including built-in tools like apply_patch, web_search_preview)
 * are converted to function format for backend compatibility.
 */
export function convertTools(tools: ResponsesTool[] | undefined): ChatTool[] | undefined {
  if (!tools?.length) return undefined;

  const converted: ChatTool[] = [];
  for (const t of tools) {
    // Convert all tool types to function format
    // Built-in tools (apply_patch, web_search_preview, etc.) use their type as name if name not provided
    const isBuiltin = t.type !== "function";
    const toolName = t.name ?? (isBuiltin ? t.type : undefined);
    if (!toolName) continue;

    // For built-in tools without description, provide a default one
    const description = t.description ?? (isBuiltin ? `Built-in tool: ${t.type}` : undefined);

    converted.push({
      type: "function",
      function: {
        name: toolName,
        description,
        // Chat Completions API requires parameters, default to empty object if not provided
        parameters: t.parameters ?? { type: "object", properties: {} },
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
