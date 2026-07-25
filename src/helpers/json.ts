export interface TextResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

// biome-ignore lint/suspicious/noExplicitAny: Upstream JSON schemas are intentionally dynamic at this boundary.
export function parseTextResultJson(result: TextResult): Record<string, any> {
  const text = result.content
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
  if (result.isError) throw new Error(text || "ast-bro MCP call failed");
  if (!text) throw new Error("ast-bro MCP returned no JSON text");
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid ast-bro MCP JSON: ${text}`, { cause: error });
  }
}
