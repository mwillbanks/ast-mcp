import { type SyntaxFacts, sha256 } from "../../parser/index.ts";
import {
  LanguageWorkerClient,
  type LanguageWorkerErrorCode,
} from "../shared/language-worker-client.ts";
import { isLegacyWorkerResult } from "./protocol.ts";
import type { LegacyAnalyzeRequest, LegacyLanguageId } from "./types.ts";

export const legacyExtractorFingerprint = sha256(
  "legacy-tree-sitter-wasm@1.1.8+structured@1+coordinates-v2",
);
export const LEGACY_WORKER_LIMITS = {
  maxOutstandingBytes: 8 * 1024 * 1024,
  maxPendingRequests: 64,
  timeoutMs: 10_000,
} as const;

export class LegacyLanguageUnavailableError extends Error {
  readonly code = "legacy_grammar_unavailable";
  readonly retryable = false;
  constructor(readonly languageId: LegacyLanguageId) {
    super(
      "Legacy language '" +
        languageId +
        "' has no validated bundled WASM grammar",
    );
    this.name = "LegacyLanguageUnavailableError";
  }
}

export class LegacyWorkerError extends Error {
  constructor(
    readonly code: LanguageWorkerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LegacyWorkerError";
  }
}

const client = new LanguageWorkerClient<LegacyLanguageId>({
  closeMode: "terminate",
  createError: (code, message) => new LegacyWorkerError(code, message),
  label: "Legacy",
  limits: LEGACY_WORKER_LIMITS,
  terminateOnProtocolError: true,
  terminateOnWorkerError: true,
  validateResult: isLegacyWorkerResult,
  workerUrl: new URL("./wasm-worker.ts", import.meta.url),
});

export function rejectPendingLegacyRequests(error: unknown): void {
  client.rejectPending(error);
}
export function analyzeLegacyLanguage(
  request: LegacyAnalyzeRequest,
): Promise<SyntaxFacts> {
  return client.analyze(request);
}
export function legacyWorkerStats(): {
  outstandingBytes: number;
  pendingRequests: number;
} {
  const { outstandingBytes, pendingRequests } = client.stats();
  return { outstandingBytes, pendingRequests };
}
export function drainLegacyLanguageWorker(): Promise<void> {
  return client.drain();
}
export function closeLegacyLanguageWorker(): Promise<void> {
  return client.close();
}
export function restartLegacyLanguageWorker(): Promise<void> {
  return client.restart();
}
export function terminateLegacyLanguageWorker(): Promise<number> {
  return client.terminate();
}
