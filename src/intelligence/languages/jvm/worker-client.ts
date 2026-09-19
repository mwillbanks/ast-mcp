import type { Worker } from "node:worker_threads";

import { type SyntaxFacts, sha256 } from "../../parser/index.ts";
import {
  createWorkerClient,
  type WorkerErrorCode,
} from "../shared/worker-client.ts";
import {
  createLanguageWorkerResponseValidator,
  createTreeSitterWorkerFactsValidator,
} from "../worker-client-validation.ts";
import type { JvmAnalyzeRequest } from "./types.ts";

export const jvmExtractorFingerprint = sha256(
  "tree-sitter-wasm@1.1.8+web-tree-sitter@0.27.0+coordinates-v2",
);
export const JVM_WORKER_LIMITS = {
  maxOutstandingBytes: 8 * 1024 * 1024,
  maxPendingRequests: 64,
  timeoutMs: 10_000,
} as const;

export class JvmWorkerError extends Error {
  constructor(
    readonly code: WorkerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "JvmWorkerError";
  }
}

const validateFactConsistency = createTreeSitterWorkerFactsValidator({
  createError: () =>
    new JvmWorkerError(
      "protocol",
      "JVM worker facts are internally inconsistent",
    ),
  grammarIdentity: (languageId) =>
    languageId === "apex" ? "java:apex-compatible-subset-v1" : languageId,
});

export const validateJvmWorkerResponse = createLanguageWorkerResponseValidator({
  createError: (message) => new JvmWorkerError("protocol", message),
  factsMismatchMessage:
    "JVM worker facts do not match the requested language and source",
  responseIdMismatchMessage: "JVM worker response id mismatch",
  validateFacts: validateFactConsistency,
});

const jvmWorkerClient = createWorkerClient({
  createError: (code, message) => new JvmWorkerError(code, message),
  displayName: "Jvm",
  limits: JVM_WORKER_LIMITS,
  protocolName: "JVM",
  validateResponse: validateJvmWorkerResponse,
  workerUrl: new URL("./wasm-worker.ts", import.meta.url),
});

export function handleJvmWorkerError(active: Worker, error: Error): void {
  jvmWorkerClient.handleError(active, error);
}

export function analyzeJvmLanguage(
  request: JvmAnalyzeRequest,
): Promise<SyntaxFacts> {
  return jvmWorkerClient.analyze(request);
}

export function jvmWorkerStats(): {
  outstandingBytes: number;
  pendingRequests: number;
} {
  return jvmWorkerClient.stats();
}

export function drainJvmLanguageWorker(): Promise<void> {
  return jvmWorkerClient.drain();
}

export function interruptJvmLanguageWorker(): Promise<void> {
  return jvmWorkerClient.interrupt();
}

export function closeJvmLanguageWorker(): Promise<void> {
  return jvmWorkerClient.close();
}
