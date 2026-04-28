const MAX_ENTRIES = 200;

const cache = new Map<string, string>();

export function makeReasoningKey(
  content: string | null | undefined,
  toolCallIds?: string[],
): string {
  let key = (content || "").trim();
  if (toolCallIds?.length) {
    key += "\x00" + [...toolCallIds].sort().join(",");
  }
  return key;
}

export function cacheReasoning(key: string, reasoningContent: string): void {
  if (!key || !reasoningContent) return;

  if (cache.size >= MAX_ENTRIES) {
    const firstKey = cache.keys().next().value;
    if (firstKey !== undefined) cache.delete(firstKey);
  }

  cache.set(key, reasoningContent);
}

export function getCachedReasoning(key: string): string | undefined {
  if (!key) return undefined;
  return cache.get(key);
}
