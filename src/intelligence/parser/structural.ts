import { parse, type SgNode } from "@ast-grep/napi";
import { compareSourceRanges } from "../graph/shared.ts";
import { SourceCoordinateIndex, sha256 } from "./coordinates.ts";
import { defaultLanguageRegistry, type LanguageRegistry } from "./registry.ts";
import type {
  ParserLanguageId,
  StructuralMatch,
  StructuralRewriteCandidate,
  StructuralRewriteOperation,
} from "./types.ts";

function orderedMatches(
  source: string,
  languageId: ParserLanguageId,
  pattern: string,
  registry: LanguageRegistry,
): { matches: StructuralMatch[]; nodes: SgNode[] } {
  const grammar = registry.get(languageId);
  registry.registerDynamicGrammars();
  const root = parse(grammar.astGrepLanguage, source).root();
  const coordinates = new SourceCoordinateIndex(source);
  const nodes = root.findAll(pattern).sort((left, right) =>
    compareSourceRanges(left.range(), right.range(), {
      left: String(left.kind()),
      right: String(right.kind()),
    }),
  );
  const matches = nodes.map((node, ordinal) => {
    const range = coordinates.fromAstRange(node.range());
    return {
      id: sha256(
        JSON.stringify([
          grammar.grammarFingerprint,
          sha256(source),
          pattern,
          range.startCoordinate.utf16Offset,
          range.endCoordinate.utf16Offset,
        ]),
      ),
      kind: String(node.kind()),
      ordinal,
      range,
      text: node.text(),
    };
  });
  return { matches, nodes };
}

export function findStructuralMatches(
  source: string,
  languageId: ParserLanguageId,
  pattern: string,
  registry: LanguageRegistry = defaultLanguageRegistry,
): StructuralMatch[] {
  return orderedMatches(source, languageId, pattern, registry).matches;
}

function renderReplacement(template: string, node: SgNode): string {
  return template.replace(
    /\$\$\$([A-Z_][A-Z0-9_]*)|\$([A-Z_][A-Z0-9_]*)/g,
    (
      token,
      multipleName: string | undefined,
      singleName: string | undefined,
    ) => {
      if (multipleName) {
        const matches = node.getMultipleMatches(multipleName);
        const first = matches[0];
        const last = matches.at(-1);
        if (!first || !last) return "";
        return node
          .getRoot()
          .root()
          .text()
          .slice(first.range().start.index, last.range().end.index);
      }
      if (!singleName) return token;
      return node.getMatch(singleName)?.text() ?? token;
    },
  );
}

export function rewriteStructuralMatches(
  source: string,
  languageId: ParserLanguageId,
  operations: readonly StructuralRewriteOperation[],
  registry: LanguageRegistry = defaultLanguageRegistry,
): StructuralRewriteCandidate {
  const grammar = registry.get(languageId);
  registry.registerDynamicGrammars();
  const root = parse(grammar.astGrepLanguage, source).root();
  const coordinates = new SourceCoordinateIndex(source);
  const matches: StructuralMatch[] = [];
  const edits: Array<{
    matchId: string;
    range: StructuralMatch["range"];
    replacement: string;
  }> = [];
  const nativeEdits: Array<{
    startPos: number;
    endPos: number;
    insertedText: string;
  }> = [];

  for (const [operationIndex, operation] of operations.entries()) {
    if (
      !Number.isInteger(operation.expectedMatches) ||
      operation.expectedMatches < 0
    ) {
      throw new TypeError("Expected match count must be a nonnegative integer");
    }
    const nodes = root
      .findAll(operation.pattern)
      .sort((left, right) => compareSourceRanges(left.range(), right.range()));
    if (nodes.length !== operation.expectedMatches) {
      throw new RangeError(
        "Structural operation " +
          operationIndex +
          " expected " +
          operation.expectedMatches +
          " matches but found " +
          nodes.length,
      );
    }
    if (
      Array.isArray(operation.replacement) &&
      operation.replacement.length !== nodes.length
    ) {
      throw new RangeError(
        `Structural operation ${operationIndex} requires one replacement per match`,
      );
    }
    nodes.forEach((node, ordinal) => {
      const range = coordinates.fromAstRange(node.range());
      const match: StructuralMatch = {
        id: sha256(
          JSON.stringify([
            grammar.grammarFingerprint,
            sha256(source),
            operationIndex,
            operation.pattern,
            range.startCoordinate.utf16Offset,
            range.endCoordinate.utf16Offset,
          ]),
        ),
        kind: String(node.kind()),
        ordinal,
        range,
        text: node.text(),
      };
      const template = Array.isArray(operation.replacement)
        ? (operation.replacement[ordinal] ?? "")
        : operation.replacement;
      const replacement = renderReplacement(template, node);
      matches.push(match);
      edits.push({ matchId: match.id, range, replacement });
      nativeEdits.push({
        endPos: range.endCoordinate.utf16Offset,
        insertedText: replacement,
        startPos: range.startCoordinate.utf16Offset,
      });
    });
  }

  const ordered = edits
    .map((edit, index) => ({ edit, native: nativeEdits[index] }))
    .sort(
      (left, right) =>
        left.edit.range.startCoordinate.utf16Offset -
          right.edit.range.startCoordinate.utf16Offset ||
        left.edit.range.endCoordinate.utf16Offset -
          right.edit.range.endCoordinate.utf16Offset,
    );
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1]?.edit;
    const current = ordered[index]?.edit;
    if (
      previous &&
      current &&
      current.range.startCoordinate.utf16Offset <
        previous.range.endCoordinate.utf16Offset
    ) {
      throw new RangeError("Structural rewrite matches overlap");
    }
  }

  return {
    edits: ordered.map((entry) => entry.edit),
    matches: [...matches].sort(
      (left, right) =>
        left.range.startCoordinate.utf16Offset -
          right.range.startCoordinate.utf16Offset ||
        left.range.endCoordinate.utf16Offset -
          right.range.endCoordinate.utf16Offset,
    ),
    source: root.commitEdits(
      ordered.map((entry) => {
        if (!entry.native) throw new TypeError("Missing native edit");
        return entry.native;
      }),
    ),
  };
}
