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
import type { SystemsAnalyzeRequest } from "./types.ts";

export const systemsExtractorFingerprint = sha256(
  "tree-sitter-wasm@1.1.8+web-tree-sitter@0.27.0+coordinates-v2",
);
export const SYSTEMS_WORKER_LIMITS = {
  maxOutstandingBytes: 8 * 1024 * 1024,
  maxPendingRequests: 64,
  timeoutMs: 10_000,
} as const;

export class SystemsWorkerError extends Error {
  constructor(
    readonly code: WorkerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SystemsWorkerError";
  }
}

const validateFactConsistency = createTreeSitterWorkerFactsValidator({
  createError: () =>
    new SystemsWorkerError(
      "protocol",
      "SYSTEMS worker facts are internally inconsistent",
    ),
  grammarIdentity: (languageId) =>
    languageId === "apex" ? "java:apex-compatible-subset-v1" : languageId,
});

export const validateSystemsWorkerResponse =
  createLanguageWorkerResponseValidator({
    createError: (message) => new SystemsWorkerError("protocol", message),
    factsMismatchMessage:
      "SYSTEMS worker facts do not match the requested language and source",
    responseIdMismatchMessage: "SYSTEMS worker response id mismatch",
    validateFacts: validateFactConsistency,
  });

const systemsWorkerClient = createWorkerClient({
  createError: (code, message) => new SystemsWorkerError(code, message),
  displayName: "Systems",
  interruptViaErrorHandler: true,
  limits: SYSTEMS_WORKER_LIMITS,
  protocolName: "SYSTEMS",
  validateResponse: validateSystemsWorkerResponse,
  workerUrl: new URL("./wasm-worker.ts", import.meta.url),
});

export function rejectPendingSystemsRequests(error: unknown): void {
  systemsWorkerClient.rejectPending(error);
}

export function handleSystemsWorkerError(active: Worker, error: Error): void {
  systemsWorkerClient.handleError(active, error);
}

export function handleSystemsWorkerResponse(
  active: Worker,
  value: unknown,
): void {
  systemsWorkerClient.handleResponse(active, value);
}

export function handleSystemsWorkerExit(active: Worker, code: number): void {
  systemsWorkerClient.handleExit(active, code);
}

export function analyzeSystemsLanguage(
  request: SystemsAnalyzeRequest,
): Promise<SyntaxFacts> {
  return systemsWorkerClient.analyze(request);
}

export function systemsWorkerStats(): {
  outstandingBytes: number;
  pendingRequests: number;
} {
  return systemsWorkerClient.stats();
}

export function drainSystemsLanguageWorker(): Promise<void> {
  return systemsWorkerClient.drain();
}

export function interruptSystemsLanguageWorker(): Promise<void> {
  return systemsWorkerClient.interrupt();
}

export function closeSystemsLanguageWorker(): Promise<void> {
  return systemsWorkerClient.close();
}

export function restartSystemsLanguageWorker(): Promise<void> {
  return systemsWorkerClient.restart();
}
