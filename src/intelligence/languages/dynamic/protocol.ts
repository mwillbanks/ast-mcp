import { type SyntaxFacts, sha256 } from "../../parser/index.ts";
import {
  isLanguageWorkerId,
  isLanguageWorkerRequest,
  isLanguageWorkerResult,
  isSyntaxFacts,
  type LanguageWorkerCancel,
  type LanguageWorkerResult,
  type LanguageWorkerStart,
  type WorkerExpectation,
} from "../shared/worker-protocol-validator.ts";
import type { DynamicLanguageId } from "./types.ts";

export interface DynamicWorkerStart
  extends LanguageWorkerStart<DynamicLanguageId> {}
export interface DynamicWorkerCancel extends LanguageWorkerCancel {}
export type DynamicWorkerRequest = DynamicWorkerStart | DynamicWorkerCancel;
export type DynamicWorkerResult = LanguageWorkerResult;
export interface DynamicWorkerExpectation
  extends WorkerExpectation<DynamicLanguageId> {}

const languageIds = new Set<DynamicLanguageId>([
  "elixir",
  "julia",
  "lua",
  "luau",
  "php",
  "python",
  "r",
  "ruby",
]);

export const isDynamicWorkerId = isLanguageWorkerId;
export function dynamicLanguageExtractorFingerprint(
  languageId: DynamicLanguageId,
): string {
  return sha256(
    JSON.stringify(["tree-sitter-wasm", "1.1.8", languageId, "coordinates-v2"]),
  );
}
export function dynamicGrammarFingerprint(
  languageId: DynamicLanguageId,
): string {
  return sha256(JSON.stringify(["tree-sitter-wasm", "1.1.8", languageId]));
}
export function dynamicParserFingerprint(): string {
  return sha256("web-tree-sitter@0.27.0");
}
export function isDynamicSyntaxFacts(
  value: unknown,
  expected: DynamicWorkerExpectation,
): value is SyntaxFacts {
  return isSyntaxFacts(value, expected, {
    extractorFingerprint: dynamicLanguageExtractorFingerprint,
    grammarFingerprint: dynamicGrammarFingerprint,
    hashedIds: false,
    parserFingerprint: dynamicParserFingerprint,
    requireSemanticLinks: false,
  });
}
export function isDynamicWorkerRequest(
  value: unknown,
): value is DynamicWorkerRequest {
  return isLanguageWorkerRequest(value, languageIds);
}
export function isDynamicWorkerResult(
  value: unknown,
  expected?: DynamicWorkerExpectation,
): value is DynamicWorkerResult {
  return isLanguageWorkerResult(value, expected, isDynamicSyntaxFacts);
}
