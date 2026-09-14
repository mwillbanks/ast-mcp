import { type SyntaxFacts, sha256 } from "../parser/index.ts";
import {
  validateWorkerEnvelope,
  type WorkerResponse,
} from "./shared/worker-client.ts";

export interface WorkerFactsValidation {
  createError(): Error;
  extractorFingerprint(languageId: string): string;
  grammarFingerprint(languageId: string): string;
  parserFingerprint(languageId: string): string;
  requireReciprocalNodeLinks?: boolean;
}

const hash = /^[a-f0-9]{64}$/;

export function validateWorkerFactConsistency(
  facts: SyntaxFacts,
  expected: { languageId: string; source: string },
  validation: WorkerFactsValidation,
): void {
  const fail = () => {
    throw validation.createError();
  };
  const ranges = [
    ...facts.nodes.map((item) => item.range),
    ...facts.symbols.flatMap((item) => [item.range, item.declarationRange]),
    ...facts.imports.map((item) => item.range),
    ...facts.exports.map((item) => item.range),
    ...facts.calls.map((item) => item.range),
    ...facts.inheritance.map((item) => item.range),
    ...facts.implementations.map((item) => item.range),
    ...facts.references.map((item) => item.range),
    ...facts.diagnostics.map((item) => item.range),
  ];
  for (const range of ranges) {
    const start = range.startCoordinate;
    const end = range.endCoordinate;
    if (
      range.startByte !== start.byteOffset ||
      range.endByte !== end.byteOffset ||
      range.start.line !== start.line ||
      range.start.column !== start.column ||
      range.end.line !== end.line ||
      range.end.column !== end.column ||
      start.byteOffset > end.byteOffset ||
      start.utf16Offset > end.utf16Offset ||
      start.characterOffset > end.characterOffset ||
      start.line > end.line ||
      (start.line === end.line &&
        (start.column > end.column || start.utf16Column > end.utf16Column))
    )
      fail();
  }

  const collections = [
    facts.nodes,
    facts.symbols,
    facts.imports,
    facts.exports,
    facts.calls,
    facts.inheritance,
    facts.implementations,
    facts.references,
  ];
  const ids = collections.flatMap((items) => items.map((item) => item.id));
  if (ids.some((id) => !hash.test(id)) || new Set(ids).size !== ids.length)
    fail();

  const nodeIds = new Set(facts.nodes.map((node) => node.id));
  if (!nodeIds.has(facts.rootNodeId)) fail();
  const nodesById = validation.requireReciprocalNodeLinks
    ? new Map(facts.nodes.map((node) => [node.id, node]))
    : undefined;
  for (const node of facts.nodes) {
    const parent =
      node.parentId === null ? undefined : nodesById?.get(node.parentId);
    if (
      (node.parentId !== null && !nodeIds.has(node.parentId)) ||
      new Set(node.childIds).size !== node.childIds.length ||
      node.childIds.some((id) => !nodeIds.has(id)) ||
      (nodesById !== undefined &&
        parent !== undefined &&
        !parent.childIds.includes(node.id)) ||
      (nodesById !== undefined &&
        node.childIds.some((id) => nodesById.get(id)?.parentId !== node.id))
    )
      fail();
  }

  const symbolIds = new Set(facts.symbols.map((symbol) => symbol.id));
  const symbolPointers = [
    ...facts.calls.map((item) => item.enclosingSymbolId),
    ...facts.references.map((item) => item.enclosingSymbolId),
    ...facts.inheritance.map((item) => item.sourceSymbolId),
    ...facts.implementations.map((item) => item.sourceSymbolId),
  ];
  if (symbolPointers.some((id) => id !== null && !symbolIds.has(id))) fail();

  const digest = sha256(expected.source);
  const syntaxFactsArtifactId = sha256(
    JSON.stringify([
      digest,
      validation.extractorFingerprint(expected.languageId),
      facts.symbols.map((item) => item.id),
      facts.imports.map((item) => item.id),
      facts.calls.map((item) => item.id),
      facts.inheritance.map((item) => item.id),
      facts.implementations.map((item) => item.id),
      facts.exports.map((item) => item.id),
    ]),
  );
  if (
    facts.languageId !== expected.languageId ||
    facts.sourceDigest !== digest ||
    facts.sourceArtifactId !== sha256(JSON.stringify(["source", digest])) ||
    facts.extractorFingerprint !==
      validation.extractorFingerprint(expected.languageId) ||
    facts.grammarFingerprint !==
      validation.grammarFingerprint(expected.languageId) ||
    facts.parserFingerprint !==
      validation.parserFingerprint(expected.languageId) ||
    facts.syntaxFactsArtifactId !== syntaxFactsArtifactId ||
    ![
      facts.sourceDigest,
      facts.sourceArtifactId,
      facts.extractorFingerprint,
      facts.grammarFingerprint,
      facts.parserFingerprint,
      facts.syntaxFactsArtifactId,
      facts.rootNodeId,
    ].every((id) => hash.test(id))
  )
    fail();
}

export function createTreeSitterWorkerFactsValidator(options: {
  createError(): Error;
  grammarIdentity(languageId: string): string;
}): (
  facts: SyntaxFacts,
  expected: { languageId: string; source: string },
) => void {
  return (facts, expected) => {
    const grammarIdentity = options.grammarIdentity(expected.languageId);
    validateWorkerFactConsistency(facts, expected, {
      createError: options.createError,
      extractorFingerprint: () =>
        sha256(
          JSON.stringify([
            "tree-sitter-wasm",
            "1.1.8",
            grammarIdentity,
            "coordinates-v2",
          ]),
        ),
      grammarFingerprint: () =>
        sha256(JSON.stringify(["tree-sitter-wasm", "1.1.8", grammarIdentity])),
      parserFingerprint: () => sha256("web-tree-sitter@0.27.0"),
    });
  };
}

export function createLanguageWorkerResponseValidator(options: {
  createError(message: string): Error;
  factsMismatchMessage?: string;
  responseIdMismatchMessage: string;
  validateFacts(
    facts: SyntaxFacts,
    expected: { languageId: string; source: string },
  ): void;
}): (
  value: unknown,
  expected?: { id: number; languageId: string; source: string },
) => WorkerResponse {
  return (value, expected) => {
    const response = validateWorkerEnvelope(value);
    if (expected && response.id !== expected.id)
      throw options.createError(options.responseIdMismatchMessage);
    if (expected && response.ok) {
      if (options.factsMismatchMessage) {
        const sourceDigest = sha256(expected.source);
        const sourceArtifactId = sha256(
          JSON.stringify(["source", sourceDigest]),
        );
        if (
          response.facts.languageId !== expected.languageId ||
          response.facts.sourceDigest !== sourceDigest ||
          response.facts.sourceArtifactId !== sourceArtifactId
        )
          throw options.createError(options.factsMismatchMessage);
      }
      options.validateFacts(response.facts, expected);
    }
    return response;
  };
}
