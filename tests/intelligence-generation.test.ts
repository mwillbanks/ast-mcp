import { afterAll, describe, expect, test } from "bun:test";
import { createIdentity } from "../src/intelligence/contracts/common.ts";
import { createStorageDomainId } from "../src/intelligence/contracts/storage.ts";
import {
  createRepositoryId,
  createRevisionId,
  createWorkspaceId,
} from "../src/intelligence/contracts/workspace.ts";
import {
  type GenerationRequest,
  generateWithEvidence,
  type McpSamplingClient,
} from "../src/intelligence/generation/index.ts";

const repositoryId = createRepositoryId({
  canonicalGitCommonDirectory: "/repo/.git",
});
const revisionId = createRevisionId({
  repositoryId,
  resolvedCommitOid: null,
  selector: { kind: "working" },
});
const storageDomainId = createStorageDomainId({
  engine: "lancedb",
  placement: { kind: "global" },
  pool: "shared",
  storagePath: "/indexes",
});
const workspaceId = createWorkspaceId({
  canonicalCheckoutRoot: "/repo",
  configurationGeneration: 1,
  dirtyOverlayId: null,
  repositoryId,
  revisionId,
  storageDomainId,
});
const scope = {
  generationId: createIdentity("generation", { test: "generation" }),
  repositoryId,
  revisionId,
  workspaceId,
};
const artifactId = createIdentity("chunk", { test: "evidence" });
const evidence = {
  artifactId,
  entityId: createIdentity("node", { test: "evidence" }),
  path: "src/evidence.ts",
  range: {
    end: { column: 8, line: 0 },
    endByte: 8,
    start: { column: 0, line: 0 },
    startByte: 0,
  },
  scope,
  text: "evidence",
};
const base = Object.freeze({ results: [{ artifactId }], stable: true });

function request(provider: GenerationRequest["provider"]): GenerationRequest {
  return {
    allowedCorpusArtifactIds: [artifactId],
    enabled: true,
    evidence: [evidence],
    prompt: "Explain the evidence.",
    provider,
    scope,
  };
}

let responseMode:
  | "invalid-citation"
  | "malformed"
  | "many-citations"
  | "out-of-range"
  | "reject"
  | "schema-invalid"
  | "success"
  | "timeout" = "success";
let observedAuthorization: string | null = null;
let observedBody: Record<string, unknown> | null = null;
const server = Bun.serve({
  fetch: async (incoming) => {
    observedAuthorization = incoming.headers.get("authorization");
    observedBody = (await incoming.json()) as Record<string, unknown>;
    if (responseMode === "reject")
      return new Response("secret=server-token", { status: 429 });
    if (responseMode === "timeout") {
      await Bun.sleep(100);
      return Response.json({});
    }
    const content =
      responseMode === "malformed"
        ? "not-json"
        : responseMode === "schema-invalid"
          ? JSON.stringify({ answer: "Unsupported shape." })
          : JSON.stringify({
              answer: "Supported.",
              citations:
                responseMode === "invalid-citation"
                  ? [{ end: 2, evidenceId: "invented", start: 0 }]
                  : responseMode === "out-of-range"
                    ? [{ end: 99, evidenceId: evidence.entityId, start: 0 }]
                    : responseMode === "many-citations"
                      ? Array.from({ length: 20 }, () => ({
                          end: 8,
                          evidenceId: evidence.entityId,
                          start: 0,
                        }))
                      : [{ end: 8, evidenceId: evidence.entityId, start: 0 }],
            });
    return Response.json({ choices: [{ message: { content } }] });
  },
  hostname: "127.0.0.1",
  port: 0,
});
const endpoint = `http://127.0.0.1:${server.port}/v1/chat/completions?token=hidden`;

afterAll(() => server.stop(true));

describe("optional evidence generation", () => {
  test("is disabled by default and preserves the base result", async () => {
    const result = await generateWithEvidence(base, {
      allowedCorpusArtifactIds: [artifactId],
      evidence: [evidence],
      prompt: "ignored",
      scope,
    });
    expect(result).toMatchObject({
      base,
      generated: null,
      modelIdentity: null,
      provider: null,
      reason: "generation_disabled",
      status: "disabled",
    });
    expect(result.base).toBe(base);
  });

  test("does not silently select a missing provider", async () => {
    let calls = 0;
    const result = await generateWithEvidence(base, request(null), {
      fetch: async () => {
        calls += 1;
        return Response.json({});
      },
    });
    expect(result.status).toBe("unavailable");
    expect(result.reason).toBe("generation_provider_unavailable");
    expect(result.base).toBe(base);
    expect(calls).toBe(0);
  });

  test("uses an OpenAI-compatible endpoint with schema and budgets", async () => {
    responseMode = "success";
    const result = await generateWithEvidence(base, {
      ...request({
        apiKey: "top-secret",
        endpoint,
        kind: "http",
        model: "local/model",
      }),
      budget: {
        maxEvidenceBytes: 10_000,
        maxEvidenceItems: 1,
        maxOutputBytes: 1_000,
        maxOutputTokens: 256,
        timeoutMs: 1_000,
      },
    });
    expect(result.status).toBe("succeeded");
    expect(result.generated).toEqual({
      answer: "Supported.",
      citations: [{ end: 8, evidenceId: evidence.entityId, start: 0 }],
    });
    expect(result.base).toBe(base);
    expect(result.modelIdentity).toHaveLength(64);
    expect(observedAuthorization).toBe("Bearer top-secret");
    expect(observedBody).toMatchObject({
      max_tokens: 256,
      model: "local/model",
      response_format: {
        json_schema: { name: "evidence_answer", strict: true },
        type: "json_schema",
      },
      stream: false,
      temperature: 0,
    });
    const messages = observedBody?.messages as
      | { content: string; role: string }[]
      | undefined;
    const serializedPrompt = JSON.parse(messages?.[0]?.content ?? "{}");
    expect(serializedPrompt).toMatchObject({
      evidence: [
        {
          artifactId,
          entityId: evidence.entityId,
          path: evidence.path,
          range: evidence.range,
          scope,
        },
      ],
      instruction: "Explain the evidence.",
    });
    expect(serializedPrompt.responseContract).toMatchObject({
      required: ["answer", "citations"],
      type: "object",
    });
  });

  test("rejects HTTP failures without exposing secrets", async () => {
    responseMode = "reject";
    const result = await generateWithEvidence(
      base,
      request({
        apiKey: "top-secret",
        endpoint,
        kind: "http",
        model: "local/model",
      }),
    );
    expect(result.status).toBe("rejected");
    expect(result.reason).toBe("generation_provider_rejected");
    expect(JSON.stringify(result)).not.toContain("top-secret");
    expect(JSON.stringify(result)).not.toContain("server-token");
    expect(JSON.stringify(result)).not.toContain("hidden");
  });

  test.each([
    "malformed",
    "schema-invalid",
    "invalid-citation",
    "out-of-range",
  ] as const)("rejects %s provider output", async (mode) => {
    responseMode = mode;
    const result = await generateWithEvidence(
      base,
      request({
        endpoint,
        kind: "http",
        model: "local/model",
      }),
    );
    expect(result.status).toBe("rejected");
    expect(result.generated).toBeNull();
    expect(result.base).toBe(base);
    expect(result.reason).toMatch(/^generation_(response|citation)/);
  });

  test("rejects cross-scope evidence before invoking a provider", async () => {
    let calls = 0;
    const result = await generateWithEvidence(
      base,
      {
        ...request({
          endpoint,
          kind: "http",
          model: "local/model",
        }),
        evidence: [
          {
            ...evidence,
            scope: {
              ...scope,
              generationId: createIdentity("generation", { other: true }),
            },
          },
        ],
      },
      {
        fetch: async () => {
          calls += 1;
          return Response.json({});
        },
      },
    );
    expect(result.status).toBe("rejected");
    expect(result.reason).toBe("generation_evidence_rejected");
    expect(calls).toBe(0);
  });

  test("counts serialized metadata and merges partial budget defaults", async () => {
    let calls = 0;
    const provider = {
      endpoint,
      kind: "http" as const,
      model: "local/model",
    };
    const metadata = await generateWithEvidence(
      base,
      {
        ...request(provider),
        budget: { maxEvidenceBytes: 3_000 },
        evidence: [{ ...evidence, path: `src/${"a".repeat(3_900)}.ts` }],
      },
      {
        fetch: async () => {
          calls += 1;
          return Response.json({});
        },
      },
    );
    expect(metadata.status).toBe("rejected");
    expect(metadata.reason).toBe("generation_evidence_budget");
    expect(calls).toBe(0);

    responseMode = "success";
    const partial = await generateWithEvidence(base, {
      ...request(provider),
      budget: { maxEvidenceBytes: 10_000 },
    });
    expect(partial.status).toBe("succeeded");
    expect(observedBody?.max_tokens).toBe(2_048);
  });

  test("enforces evidence, output byte, and token budgets", async () => {
    const provider = {
      endpoint,
      kind: "http" as const,
      model: "local/model",
    };
    const evidenceBudget = await generateWithEvidence(base, {
      ...request(provider),
      budget: {
        maxEvidenceBytes: 1,
        maxEvidenceItems: 1,
        maxOutputBytes: 1_000,
        maxOutputTokens: 100,
        timeoutMs: 1_000,
      },
    });
    expect(evidenceBudget.reason).toBe("generation_evidence_budget");

    responseMode = "success";
    const outputBudget = await generateWithEvidence(base, {
      ...request(provider),
      budget: {
        maxEvidenceBytes: 10_000,
        maxEvidenceItems: 1,
        maxOutputBytes: 10,
        maxOutputTokens: 1,
        timeoutMs: 1_000,
      },
    });
    expect(outputBudget.status).toBe("rejected");
    expect(outputBudget.reason).toBe("generation_output_budget");

    responseMode = "many-citations";
    const citationTokens = await generateWithEvidence(base, {
      ...request(provider),
      budget: {
        maxEvidenceBytes: 10_000,
        maxEvidenceItems: 1,
        maxOutputBytes: 10_000,
        maxOutputTokens: 32,
        timeoutMs: 1_000,
      },
    });
    expect(citationTokens.status).toBe("rejected");
    expect(citationTokens.reason).toBe("generation_output_budget");
  });

  test("reports timeout and cancellation deterministically", async () => {
    responseMode = "timeout";
    const timed = await generateWithEvidence(base, {
      ...request({
        endpoint,
        kind: "http",
        model: "local/model",
      }),
      budget: {
        maxEvidenceBytes: 10_000,
        maxEvidenceItems: 1,
        maxOutputBytes: 1_000,
        maxOutputTokens: 100,
        timeoutMs: 10,
      },
    });
    expect(timed.status).toBe("timeout");
    expect(timed.reason).toBe("generation_timeout");

    const controller = new AbortController();
    const cancellation = generateWithEvidence(base, {
      ...request({
        endpoint,
        kind: "http",
        model: "local/model",
      }),
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 1);
    const cancelled = await cancellation;
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.reason).toBe("generation_cancelled");
  });

  test("requires advertised MCP sampling and preserves provider choice", async () => {
    let calls = 0;
    const unavailable = await generateWithEvidence(
      base,
      request({
        kind: "mcp",
        model: "sampling/model",
        serverId: "client",
      }),
      {
        mcpClients: {
          client: {
            capabilities: {},
            createMessage: async () => {
              calls += 1;
              return {};
            },
          },
        },
      },
    );
    expect(unavailable.status).toBe("unavailable");
    expect(calls).toBe(0);

    let received: unknown;
    const client: McpSamplingClient = {
      capabilities: { sampling: {} },
      createMessage: async (input, context) => {
        calls += 1;
        received = { context, input };
        return {
          content: {
            text: JSON.stringify({
              answer: "MCP supported.",
              citations: [{ end: 8, evidenceId: evidence.entityId, start: 0 }],
            }),
            type: "text",
          },
        };
      },
    };
    const succeeded = await generateWithEvidence(
      base,
      request({
        kind: "mcp",
        model: "sampling/model",
        serverId: "client",
      }),
      { mcpClients: { client } },
    );
    expect(succeeded.status).toBe("succeeded");
    expect(succeeded.provider).toBe("mcp");
    expect(succeeded.generated?.answer).toBe("MCP supported.");
    expect(received).toMatchObject({
      context: { signal: expect.any(AbortSignal) },
      input: {
        modelPreferences: { hints: [{ name: "sampling/model" }] },
      },
    });
    expect(
      Object.keys(
        (received as { input: Record<string, unknown> }).input,
      ).sort(),
    ).toEqual(["maxTokens", "messages", "modelPreferences"]);
    const arrayClient: McpSamplingClient = {
      capabilities: { sampling: {} },
      createMessage: async () => ({
        content: [
          { text: '{"answer":"Array MCP","citations":[', type: "text" },
          {
            text: `{"evidenceId":"${evidence.entityId}","start":0,"end":8}]}`,
            type: "text",
          },
        ],
      }),
    };
    const arrayResult = await generateWithEvidence(
      base,
      request({
        kind: "mcp",
        model: "sampling/model",
        serverId: "array",
      }),
      { mcpClients: { array: arrayClient } },
    );
    expect(arrayResult.status).toBe("succeeded");
    expect(arrayResult.generated?.answer).toBe("Array MCP");
    expect(calls).toBe(1);
  });

  test("keeps model identity stable while excluding credentials", async () => {
    responseMode = "success";
    const first = await generateWithEvidence(
      base,
      request({
        apiKey: "first-secret",
        endpoint,
        kind: "http",
        model: "local/model",
      }),
    );
    const second = await generateWithEvidence(
      base,
      request({
        apiKey: "second-secret",
        endpoint,
        kind: "http",
        model: "local/model",
      }),
    );
    expect(first.modelIdentity).toBe(second.modelIdentity);
    expect(first.modelIdentity).not.toContain("secret");
  });
});
