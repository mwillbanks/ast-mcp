import type { Worker } from "node:worker_threads";

import { type SyntaxFacts, sha256 } from "../../parser/index.ts";
import {
  createWorkerClient,
  validateWorkerEnvelope,
  type WorkerErrorCode,
  type WorkerResponse,
} from "../shared/worker-client.ts";
import { validateWorkerFactConsistency } from "../worker-client-validation.ts";
import type { InfraAnalyzeRequest } from "./types.ts";

export const infraExtractorFingerprint = sha256(
  "infra-structured-v1+tree-sitter-wasm@1.1.8+web-tree-sitter@0.27.0+coordinates-v2",
);
export const INFRA_WORKER_LIMITS = {
  maxOutstandingBytes: 8 * 1024 * 1024,
  maxPendingRequests: 64,
  timeoutMs: 10_000,
} as const;

export class InfraWorkerError extends Error {
  constructor(
    readonly code: WorkerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "InfraWorkerError";
  }
}

function validateFactConsistency(
  facts: SyntaxFacts,
  expected: { languageId: string; source: string },
): void {
  const grammarIdentity = ["sql", "hcl", "fortran"].includes(
    expected.languageId,
  )
    ? `structured:${expected.languageId}:v1`
    : expected.languageId === "verilog"
      ? "systemverilog:verilog-subset-v1"
      : expected.languageId;
  validateWorkerFactConsistency(facts, expected, {
    createError: () =>
      new InfraWorkerError(
        "protocol",
        "INFRA worker facts are internally inconsistent",
      ),
    extractorFingerprint: () => infraExtractorFingerprint,
    grammarFingerprint: () =>
      sha256(JSON.stringify([grammarIdentity, "1.1.8"])),
    parserFingerprint: () =>
      sha256(
        grammarIdentity.startsWith("structured")
          ? "ast-mcp-structured-parser-v1"
          : "web-tree-sitter@0.27.0",
      ),
    requireReciprocalNodeLinks: true,
  });
}

export function validateInfraWorkerResponse(
  value: unknown,
  expected?: { id: number; languageId: string; source: string },
): WorkerResponse {
  const response = validateWorkerEnvelope(value);
  if (expected && response.id !== expected.id) {
    throw new InfraWorkerError("protocol", "INFRA worker response id mismatch");
  }
  if (expected && response.ok)
    validateFactConsistency(response.facts, expected);
  return response;
}

const infraWorkerClient = createWorkerClient({
  createError: (code, message) => new InfraWorkerError(code, message),
  displayName: "Infra",
  limits: INFRA_WORKER_LIMITS,
  protocolName: "INFRA",
  validateResponse: validateInfraWorkerResponse,
  workerUrl: new URL("./wasm-worker.ts", import.meta.url),
});

export function rejectPendingInfraRequests(error: unknown): void {
  infraWorkerClient.rejectPending(error);
}

export function handleInfraWorkerError(active: Worker, error: Error): void {
  infraWorkerClient.handleError(active, error);
}

export function analyzeInfraLanguage(
  request: InfraAnalyzeRequest,
): Promise<SyntaxFacts> {
  return infraWorkerClient.analyze(request);
}

export function infraWorkerStats(): {
  outstandingBytes: number;
  pendingRequests: number;
} {
  return infraWorkerClient.stats();
}

export function drainInfraLanguageWorker(): Promise<void> {
  return infraWorkerClient.drain();
}

export function interruptInfraLanguageWorker(): Promise<void> {
  return infraWorkerClient.interrupt();
}

export function closeInfraLanguageWorker(): Promise<void> {
  return infraWorkerClient.close();
}

export function restartInfraLanguageWorker(): Promise<void> {
  return infraWorkerClient.restart();
}
