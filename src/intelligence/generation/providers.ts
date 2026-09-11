import type {
  GENERATION_RESPONSE_JSON_SCHEMA,
  GenerationProviderConfig,
} from "./types.ts";

export interface ProviderGenerationRequest {
  evidence: readonly {
    artifactId: string;
    entityId: string;
    path: string;
    text: string;
  }[];
  maxTokens: number;
  prompt: string;
  responseSchema: typeof GENERATION_RESPONSE_JSON_SCHEMA;
  signal: AbortSignal;
}

export interface McpSamplingClient {
  capabilities?: { sampling?: unknown };
  createMessage(
    request: {
      maxTokens: number;
      messages: {
        content: { text: string; type: "text" };
        role: "user";
      }[];
      modelPreferences: { hints: { name: string }[] };
    },
    context?: { signal?: AbortSignal },
  ): Promise<unknown>;
}

export interface GenerationDependencies {
  fetch?: (
    input: Request | string | URL,
    init?: RequestInit,
  ) => Promise<Response>;
  mcpClients?: Readonly<Record<string, McpSamplingClient>>;
}

export class GenerationUnavailableError extends Error {
  constructor() {
    super("generation_provider_unavailable");
    this.name = "GenerationUnavailableError";
  }
}

export class GenerationRejectedError extends Error {
  constructor() {
    super("generation_provider_rejected");
    this.name = "GenerationRejectedError";
  }
}

function promptText(request: ProviderGenerationRequest): string {
  return JSON.stringify({
    evidence: request.evidence,
    instruction: request.prompt,
    responseContract: request.responseSchema,
  });
}

function httpBody(
  config: Extract<GenerationProviderConfig, { kind: "http" }>,
  request: ProviderGenerationRequest,
) {
  return {
    max_tokens: request.maxTokens,
    messages: [{ content: promptText(request), role: "user" }],
    model: config.model,
    response_format: {
      json_schema: {
        name: "evidence_answer",
        schema: request.responseSchema,
        strict: true,
      },
      type: "json_schema",
    },
    stream: false,
    temperature: 0,
  };
}

function mcpParameters(
  config: Extract<GenerationProviderConfig, { kind: "mcp" }>,
  request: ProviderGenerationRequest,
) {
  return {
    maxTokens: request.maxTokens,
    messages: [
      {
        content: { text: promptText(request), type: "text" as const },
        role: "user" as const,
      },
    ],
    modelPreferences: { hints: [{ name: config.model }] },
  };
}

export function serializedProviderRequest(
  config: GenerationProviderConfig,
  request: ProviderGenerationRequest,
): string {
  return JSON.stringify(
    config.kind === "http"
      ? httpBody(config, request)
      : mcpParameters(config, request),
  );
}

function textContent(content: unknown): unknown {
  if (Array.isArray(content)) {
    const text = content.map(textContent);
    return text.every((item) => typeof item === "string")
      ? text.join("")
      : content;
  }
  if (content && typeof content === "object" && "text" in content)
    return (content as { text: unknown }).text;
  return content;
}

function contentFromResponse(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const object = value as Record<string, unknown>;
  const choices = object.choices;
  if (Array.isArray(choices)) {
    const first = choices[0] as Record<string, unknown> | undefined;
    const message = first?.message as Record<string, unknown> | undefined;
    return textContent(message?.content);
  }
  return textContent(object.content ?? value);
}

export async function invokeHttpProvider(
  config: Extract<GenerationProviderConfig, { kind: "http" }>,
  request: ProviderGenerationRequest,
  dependencies: GenerationDependencies,
): Promise<unknown> {
  const fetcher = dependencies.fetch ?? globalThis.fetch;
  if (!fetcher) throw new GenerationUnavailableError();
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
  let response: Response;
  try {
    response = await fetcher(config.endpoint, {
      body: JSON.stringify(httpBody(config, request)),
      headers,
      method: "POST",
      signal: request.signal,
    });
  } catch (error) {
    if (request.signal.aborted) throw error;
    throw new GenerationUnavailableError();
  }
  if (!response.ok) throw new GenerationRejectedError();
  try {
    return contentFromResponse(await response.json());
  } catch {
    throw new TypeError("generation_response_malformed");
  }
}

export async function invokeMcpProvider(
  config: Extract<GenerationProviderConfig, { kind: "mcp" }>,
  request: ProviderGenerationRequest,
  dependencies: GenerationDependencies,
): Promise<unknown> {
  const client = dependencies.mcpClients?.[config.serverId];
  if (!client?.capabilities?.sampling) throw new GenerationUnavailableError();
  const response = await client.createMessage(mcpParameters(config, request), {
    signal: request.signal,
  });
  return contentFromResponse(response);
}
