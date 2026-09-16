import { type SyntaxFacts, sha256 } from "../../parser/index.ts";
import {
  LanguageWorkerClient,
  type LanguageWorkerErrorCode,
} from "../shared/language-worker-client.ts";
import { isDynamicWorkerResult } from "./protocol.ts";
import type { DynamicAnalyzeRequest, DynamicLanguageId } from "./types.ts";

export const dynamicExtractorFingerprint = sha256(
  "tree-sitter-wasm@1.1.8+web-tree-sitter@0.27.0+coordinates-v2",
);
export const DYNAMIC_WORKER_LIMITS = {
  maxOutstandingBytes: 8 * 1024 * 1024,
  maxPendingRequests: 64,
  timeoutMs: 10_000,
} as const;

export class DynamicLanguageUnavailableError extends Error {
  readonly code = "dynamic_grammar_unavailable";
  readonly retryable = false;
  constructor(readonly languageId: DynamicLanguageId) {
    super(
      "Dynamic language '" +
        languageId +
        "' has no validated bundled WASM grammar",
    );
    this.name = "DynamicLanguageUnavailableError";
  }
}

export class DynamicWorkerError extends Error {
  constructor(
    readonly code: LanguageWorkerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DynamicWorkerError";
  }
}

const client = new LanguageWorkerClient<DynamicLanguageId>({
  closeMode: "detach-first",
  createError: (code, message) => new DynamicWorkerError(code, message),
  label: "Dynamic",
  limits: DYNAMIC_WORKER_LIMITS,
  terminateOnProtocolError: false,
  terminateOnWorkerError: false,
  validateResult: isDynamicWorkerResult,
  workerUrl: new URL("./wasm-worker.ts", import.meta.url),
});

export function rejectPendingDynamicRequests(error: unknown): void {
  client.rejectPending(error);
}
export function analyzeDynamicLanguage(
  request: DynamicAnalyzeRequest,
): Promise<SyntaxFacts> {
  return client.analyze(request);
}
export function dynamicWorkerStats(): {
  active: boolean;
  outstandingBytes: number;
  pendingRequests: number;
} {
  return client.stats();
}
export function drainDynamicLanguageWorker(): Promise<void> {
  return client.drain();
}
export function closeDynamicLanguageWorker(): Promise<void> {
  return client.close();
}
export function restartDynamicLanguageWorker(): Promise<void> {
  return client.restart();
}
export function terminateDynamicLanguageWorker(): Promise<number> {
  return client.terminate();
}
