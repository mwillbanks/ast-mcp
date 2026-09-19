import * as ts from "typescript-strada";

import type { ExactSourceRange, SyntaxFacts } from "../../parser/index.ts";
import { SourceCoordinateIndex, sha256 } from "../../parser/index.ts";
import { analyzeCompilerLanguage, compilerFingerprint } from "./compiler.ts";
import type {
  CompilerResolution,
  ResolutionKind,
  WebAnalyzeRequest,
  WebLanguageAnalysis,
} from "./types.ts";

export interface TypeScriptProjectAnalyzeRequest extends WebAnalyzeRequest {
  program: ts.Program;
}

function targetFor(
  node: ts.Node,
): { kind: ResolutionKind; target: ts.Node } | null {
  if (ts.isImportDeclaration(node)) {
    return { kind: "import", target: node.moduleSpecifier };
  }
  if (ts.isExportDeclaration(node)) {
    return node.moduleSpecifier
      ? { kind: "export", target: node.moduleSpecifier }
      : null;
  }
  if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
    return { kind: "call", target: node.expression };
  }
  if (ts.isExpressionWithTypeArguments(node)) {
    const heritage = node.parent;
    return {
      kind:
        ts.isHeritageClause(heritage) &&
        heritage.token === ts.SyntaxKind.ImplementsKeyword
          ? "implementation"
          : "inheritance",
      target: node.expression,
    };
  }
  return null;
}

function resolvedDeclaration(
  checker: ts.TypeChecker,
  target: ts.Node,
): { file: string | null; name: string | null } {
  let symbol = checker.getSymbolAtLocation(target);
  if (!symbol) return { file: null, name: null };
  if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    symbol = checker.getAliasedSymbol(symbol);
  }
  const declaration = symbol.declarations?.[0];
  return {
    file: declaration?.getSourceFile().fileName ?? null,
    name: declaration ? checker.symbolToString(symbol) : null,
  };
}

function applyCompilerRanges(
  facts: SyntaxFacts,
  resolutions: readonly CompilerResolution[],
): SyntaxFacts {
  const used = new Set<string>();
  const take = (
    kind: ResolutionKind,
    name: string,
    factRange: ExactSourceRange,
  ): CompilerResolution | undefined => {
    const matches = resolutions.filter(
      (resolution) =>
        !used.has(resolution.id) &&
        resolution.kind === kind &&
        (resolution.name === name ||
          resolution.name.replace(/^["']|["']$/gu, "") === name),
    );
    const contained = matches.find(
      (resolution) =>
        resolution.range.startCoordinate.utf16Offset >=
          factRange.startCoordinate.utf16Offset &&
        resolution.range.endCoordinate.utf16Offset <=
          factRange.endCoordinate.utf16Offset,
    );
    const selected = contained ?? matches[0];
    if (selected) used.add(selected.id);
    return selected;
  };
  return {
    ...facts,
    calls: facts.calls.map((call) => ({
      ...call,
      range: take("call", call.callee, call.range)?.range ?? call.range,
    })),
    exports: facts.exports.map((entry) => ({
      ...entry,
      range:
        (entry.source
          ? take("export", entry.source, entry.range)?.range
          : undefined) ?? entry.range,
    })),
    implementations: facts.implementations.map((entry) => ({
      ...entry,
      range:
        take("implementation", entry.targetName, entry.range)?.range ??
        entry.range,
    })),
    imports: facts.imports.map((entry) => ({
      ...entry,
      range: take("import", entry.source, entry.range)?.range ?? entry.range,
    })),
    inheritance: facts.inheritance.map((entry) => ({
      ...entry,
      range:
        take("inheritance", entry.targetName, entry.range)?.range ??
        entry.range,
    })),
  };
}

export function analyzeTypeScriptProject(
  request: TypeScriptProjectAnalyzeRequest,
): WebLanguageAnalysis {
  const fileName = request.fileName ?? "/entry.ts";
  const sourceFile = request.program.getSourceFile(fileName);
  if (!sourceFile) {
    throw new TypeError(`Compiler project does not contain ${fileName}`);
  }
  const compilerSourceFile = sourceFile;
  const checker = request.program.getTypeChecker();
  const coordinates = new SourceCoordinateIndex(compilerSourceFile.text);
  const resolutions: CompilerResolution[] = [];

  function visit(node: ts.Node): void {
    const record = targetFor(node);
    if (record) {
      const start = record.target.getStart(compilerSourceFile);
      const end = record.target.getEnd();
      const resolution = resolvedDeclaration(checker, record.target);
      const name = record.target.getText(compilerSourceFile);
      resolutions.push({
        id: sha256(
          JSON.stringify([
            compilerFingerprint,
            ts.version,
            sha256(compilerSourceFile.text),
            record.kind,
            name,
            start,
            end,
            resolution.file,
            resolution.name,
            request.program.getCompilerOptions(),
          ]),
        ),
        kind: record.kind,
        name,
        range: coordinates.range(start, end),
        resolvedFile: resolution.file,
        resolvedName: resolution.name,
      });
    }
    ts.forEachChild(node, visit);
  }

  visit(compilerSourceFile);
  resolutions.sort(
    (left, right) =>
      left.range.startCoordinate.utf16Offset -
        right.range.startCoordinate.utf16Offset ||
      left.kind.localeCompare(right.kind),
  );
  const structural = analyzeCompilerLanguage({
    ...request,
    source: compilerSourceFile.text,
  });
  return {
    ...structural,
    facts: applyCompilerRanges(structural.facts, resolutions),
    resolutions,
  };
}
