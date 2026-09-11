import { createHash } from "node:crypto";
import {
  type GenerationDependencies,
  GenerationUnavailableError,
  invokeHttpProvider,
  invokeMcpProvider,
  serializedProviderRequest,
} from "./providers.ts";
import {
  GENERATION_RESPONSE_JSON_SCHEMA,
  GeneratedAnswerSchema,
  type GenerationEvidence,
  type GenerationProviderConfig,
  type GenerationRequest,
  GenerationRequestSchema,
  type GenerationResult,
} from "./types.ts";

function sameScope(
  left: GenerationEvidence["scope"],
  right: GenerationEvidence["scope"],
): boolean {
  return (
    left.generationId === right.generationId &&
    left.repositoryId === right.repositoryId &&
    left.revisionId === right.revisionId &&
    left.workspaceId === right.workspaceId
  );
}

function modelIdentity(config: GenerationProviderConfig): string {
  const endpoint =
    config.kind === "http" ? new URL(config.endpoint) : undefined;
  const identity =
    config.kind === "http"
      ? ["http", `${endpoint?.origin}${endpoint?.pathname}`, config.model]
      : ["mcp", config.serverId, config.model];
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

function parseAnswer(raw: unknown) {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      throw new TypeError("generation_response_malformed");
    }
  }
  return GeneratedAnswerSchema.parse(value);
}

function validateEvidence(
  answer: ReturnType<typeof parseAnswer>,
  evidence: readonly GenerationEvidence[],
  allowed: ReadonlySet<string>,
): void {
  const byId = new Map(evidence.map((item) => [item.entityId, item]));
  for (const citation of answer.citations) {
    const item = byId.get(citation.evidenceId);
    if (
      !item ||
      !allowed.has(item.artifactId) ||
      citation.start >= citation.end ||
      citation.end > item.text.length
    )
      throw new TypeError("generation_citation_invalid");
  }
}

async function waitForProvider(
  operation: Promise<unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  if (signal.aborted) throw new Error("generation_aborted");
  return await new Promise((resolve, reject) => {
    const aborted = () => reject(new Error("generation_aborted"));
    signal.addEventListener("abort", aborted, { once: true });
    operation.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", aborted);
    });
  });
}

function abortedResult<T>(
  base: T,
  provider: "http" | "mcp",
  identity: string,
  timedOut: boolean,
): GenerationResult<T> {
  return {
    base,
    generated: null,
    modelIdentity: identity,
    provider,
    reason: timedOut ? "generation_timeout" : "generation_cancelled",
    status: timedOut ? "timeout" : "cancelled",
  };
}

export async function generateWithEvidence<T>(
  base: T,
  input: GenerationRequest,
  dependencies: GenerationDependencies = {},
): Promise<GenerationResult<T>> {
  const request = GenerationRequestSchema.parse(input);
  if (!request.enabled)
    return {
      base,
      generated: null,
      modelIdentity: null,
      provider: null,
      reason: "generation_disabled",
      status: "disabled",
    };
  if (!request.provider)
    return {
      base,
      generated: null,
      modelIdentity: null,
      provider: null,
      reason: "generation_provider_unavailable",
      status: "unavailable",
    };

  const provider = request.provider.kind;
  const identity = modelIdentity(request.provider);
  const allowed = new Set(request.allowedCorpusArtifactIds);
  const evidenceIds = new Set(request.evidence.map((item) => item.entityId));
  if (
    allowed.size === 0 ||
    request.evidence.length === 0 ||
    evidenceIds.size !== request.evidence.length ||
    request.evidence.length > request.budget.maxEvidenceItems ||
    request.evidence.some(
      (item) =>
        !sameScope(item.scope, request.scope) || !allowed.has(item.artifactId),
    )
  )
    return {
      base,
      generated: null,
      modelIdentity: identity,
      provider,
      reason: "generation_evidence_rejected",
      status: "rejected",
    };
  const evidenceBytes = Buffer.byteLength(
    serializedProviderRequest(request.provider, {
      evidence: request.evidence,
      maxTokens: request.budget.maxOutputTokens,
      prompt: request.prompt,
      responseSchema: GENERATION_RESPONSE_JSON_SCHEMA,
      signal: new AbortController().signal,
    }),
  );
  if (evidenceBytes > request.budget.maxEvidenceBytes)
    return {
      base,
      generated: null,
      modelIdentity: identity,
      provider,
      reason: "generation_evidence_budget",
      status: "rejected",
    };

  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, request.budget.timeoutMs);
  const abort = () => controller.abort();
  input.signal?.addEventListener("abort", abort, { once: true });
  if (input.signal?.aborted) controller.abort();
  try {
    const providerRequest = {
      evidence: request.evidence,
      maxTokens: request.budget.maxOutputTokens,
      prompt: request.prompt,
      responseSchema: GENERATION_RESPONSE_JSON_SCHEMA,
      signal: controller.signal,
    };
    const raw = await waitForProvider(
      request.provider.kind === "http"
        ? invokeHttpProvider(request.provider, providerRequest, dependencies)
        : invokeMcpProvider(request.provider, providerRequest, dependencies),
      controller.signal,
    );
    if (controller.signal.aborted)
      return abortedResult(base, provider, identity, timedOut);
    const answer = parseAnswer(raw);
    const serializedAnswer = JSON.stringify(answer);
    if (
      Buffer.byteLength(serializedAnswer) > request.budget.maxOutputBytes ||
      Math.ceil(serializedAnswer.length / 4) > request.budget.maxOutputTokens
    )
      return {
        base,
        generated: null,
        modelIdentity: identity,
        provider,
        reason: "generation_output_budget",
        status: "rejected",
      };
    validateEvidence(answer, request.evidence, allowed);
    return {
      base,
      generated: answer,
      modelIdentity: identity,
      provider,
      reason: null,
      status: "succeeded",
    };
  } catch (error) {
    if (controller.signal.aborted)
      return abortedResult(base, provider, identity, timedOut);
    if (error instanceof GenerationUnavailableError)
      return {
        base,
        generated: null,
        modelIdentity: identity,
        provider,
        reason: "generation_provider_unavailable",
        status: "unavailable",
      };
    if (
      (error instanceof TypeError &&
        (error.message === "generation_citation_invalid" ||
          error.message === "generation_response_malformed")) ||
      (error instanceof Error && error.name === "ZodError")
    )
      return {
        base,
        generated: null,
        modelIdentity: identity,
        provider,
        reason:
          error.message === "generation_citation_invalid"
            ? error.message
            : "generation_response_malformed",
        status: "rejected",
      };
    return {
      base,
      generated: null,
      modelIdentity: identity,
      provider,
      reason:
        error instanceof Error &&
        error.message === "generation_provider_rejected"
          ? "generation_provider_rejected"
          : "generation_failed",
      status:
        error instanceof Error &&
        error.message === "generation_provider_rejected"
          ? "rejected"
          : "failed",
    };
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener("abort", abort);
  }
}
