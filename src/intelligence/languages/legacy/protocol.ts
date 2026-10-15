import type { SyntaxFacts } from "../../parser/index.ts";
import {
  wasmExtractorFingerprint,
  wasmGrammarFingerprint,
  wasmParserFingerprint,
} from "../shared/wasm-assets.ts";
import {
  isLanguageWorkerId,
  isLanguageWorkerRequest,
  isLanguageWorkerResult,
  isSyntaxFacts,
  type LanguageWorkerCancel,
  type LanguageWorkerResult,
  type LanguageWorkerStart,
  syntaxFactsArtifactId,
  type WorkerExpectation,
} from "../shared/worker-protocol-validator.ts";
import type { LegacyLanguageId } from "./types.ts";

export interface LegacyWorkerStart extends LanguageWorkerStart<LegacyLanguageId> {}
export interface LegacyWorkerCancel extends LanguageWorkerCancel {}
export type LegacyWorkerRequest = LegacyWorkerStart | LegacyWorkerCancel;
export type LegacyWorkerResult = LanguageWorkerResult;
export interface LegacyWorkerExpectation extends WorkerExpectation<LegacyLanguageId> {}

const languageIds = new Set<LegacyLanguageId>([
  "common-lisp",
  "dreammaker",
  "ocaml",
  "pascal",
  "robot-framework",
]);

export const isLegacyWorkerId = isLanguageWorkerId;
export function legacyGrammarFingerprint(languageId: LegacyLanguageId): string {
  return wasmGrammarFingerprint(
    languageId === "common-lisp"
      ? "commonlisp"
      : languageId === "ocaml"
        ? languageId
        : `structured:${languageId}:v1`,
  );
}
export function legacyLanguageExtractorFingerprint(
  languageId: LegacyLanguageId,
): string {
  return wasmExtractorFingerprint(
    languageId === "common-lisp"
      ? "commonlisp"
      : languageId === "ocaml"
        ? languageId
        : `structured:${languageId}:v1`,
  );
}
export function legacyParserFingerprint(): string {
  return wasmParserFingerprint();
}
export function legacySyntaxFactsArtifactId(facts: SyntaxFacts): string {
  return syntaxFactsArtifactId(facts);
}
export function isLegacySyntaxFacts(
  value: unknown,
  expected: LegacyWorkerExpectation,
): value is SyntaxFacts {
  return isSyntaxFacts(value, expected, {
    extractorFingerprint: legacyLanguageExtractorFingerprint,
    grammarFingerprint: legacyGrammarFingerprint,
    hashedIds: true,
    parserFingerprint: legacyParserFingerprint,
    requireSemanticLinks: true,
  });
}
export function isLegacyWorkerRequest(
  value: unknown,
): value is LegacyWorkerRequest {
  return isLanguageWorkerRequest(value, languageIds);
}
export function isLegacyWorkerResult(
  value: unknown,
  expected?: LegacyWorkerExpectation,
): value is LegacyWorkerResult {
  return isLanguageWorkerResult(value, expected, isLegacySyntaxFacts);
}
