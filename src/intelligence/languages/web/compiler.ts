import { posix } from "node:path";
import { version as typescriptVersion } from "typescript";
import {
  createScanner,
  LanguageVariant,
  SyntaxKind,
} from "typescript/unstable/ast";
import type { ExactSourceRange, SyntaxImport } from "../../parser/index.ts";
import {
  parseSource,
  SourceCoordinateIndex,
  sha256,
} from "../../parser/index.ts";
import type {
  CompilerResolution,
  ResolutionKind,
  WebAnalyzeRequest,
  WebLanguageAnalysis,
} from "./types.ts";

const compilerFingerprint = sha256(
  JSON.stringify(["ast-mcp.web.compiler.v1", typescriptVersion]),
);
interface CompilerToken {
  end: number;
  kind: SyntaxKind;
  start: number;
}

function normalizeFileName(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  return normalized.startsWith("/")
    ? posix.normalize(normalized)
    : posix.resolve("/", normalized);
}
function parserLanguage(
  languageId: WebAnalyzeRequest["languageId"],
): "typescript" | "tsx" {
  return languageId === "jsx" || languageId === "tsx" ? "tsx" : "typescript";
}

function defaultFileName(languageId: WebAnalyzeRequest["languageId"]): string {
  if (languageId === "javascript") return "/entry.js";
  if (languageId === "jsx") return "/entry.jsx";
  if (languageId === "tsx") return "/entry.tsx";
  return "/entry.ts";
}
function compilerTokens(source: string): CompilerToken[] {
  const scanner = createScanner(true, LanguageVariant.Standard, source);
  const tokens: CompilerToken[] = [];
  let kind = scanner.scan();
  while (kind !== SyntaxKind.EndOfFile) {
    tokens.push({
      end: scanner.getTokenEnd(),
      kind,
      start: scanner.getTokenStart(),
    });
    kind = scanner.scan();
  }
  return tokens;
}
function evidenceRange(
  range: ExactSourceRange,
  source: string,
  value: string,
  coordinates: SourceCoordinateIndex,
  quoted = false,
): ExactSourceRange {
  const start = range.startCoordinate.utf16Offset;
  const end = range.endCoordinate.utf16Offset;
  const candidates = quoted ? [`"${value}"`, `'${value}'`] : [value];
  for (const candidate of candidates) {
    const offset = source.indexOf(candidate, start);
    if (offset >= start && offset + candidate.length <= end) {
      return coordinates.range(offset, offset + candidate.length);
    }
  }
  return range;
}
function moduleCandidates(fileName: string, specifier: string): string[] {
  if (!specifier.startsWith(".") && !specifier.startsWith("/")) return [];
  const base = specifier.startsWith("/")
    ? normalizeFileName(specifier)
    : posix.resolve(posix.dirname(fileName), specifier);
  if (posix.extname(base)) return [base];
  return [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    posix.join(base, "index.ts"),
    posix.join(base, "index.js"),
  ];
}
function resolvedModule(
  fileName: string,
  specifier: string,
  companions: ReadonlyMap<string, string>,
): string | null {
  return (
    moduleCandidates(fileName, specifier).find((candidate) =>
      companions.has(candidate),
    ) ?? null
  );
}
function companionLanguage(fileName: string): "javascript" | "typescript" {
  const extension = posix.extname(fileName);
  return extension === ".js" || extension === ".jsx"
    ? "javascript"
    : "typescript";
}
function importedResolution(
  entry: SyntaxImport,
  resolvedFile: string | null,
  companions: ReadonlyMap<string, string>,
): string | null {
  if (!resolvedFile) return null;
  const source = companions.get(resolvedFile);
  if (source === undefined) return null;
  const facts = parseSource({
    languageId: companionLanguage(resolvedFile),
    source,
  });
  if (entry.importedName === "default")
    return (
      facts.exports.find((item) => item.exportedName === "default")
        ?.localName ?? "default"
    );
  if (entry.importedName === "*") return "*";
  return facts.exports.some((item) => item.exportedName === entry.importedName)
    ? entry.importedName
    : null;
}
function makeResolution(
  sourceDigest: string,
  kind: ResolutionKind,
  name: string,
  range: ExactSourceRange,
  resolvedFile: string | null,
  resolvedName: string | null,
): CompilerResolution {
  return {
    id: sha256(
      JSON.stringify([
        compilerFingerprint,
        sourceDigest,
        kind,
        name,
        range.startCoordinate.utf16Offset,
        range.endCoordinate.utf16Offset,
        resolvedFile,
        resolvedName,
      ]),
    ),
    kind,
    name,
    range,
    resolvedFile,
    resolvedName,
  };
}

export function compilerResolutions(
  request: WebAnalyzeRequest,
): CompilerResolution[] {
  const fileName = normalizeFileName(
    request.fileName ?? defaultFileName(request.languageId),
  );
  const companions = new Map(
    Object.entries(request.companionSources ?? {}).map(([name, source]) => [
      normalizeFileName(name),
      source,
    ]),
  );
  const facts = parseSource({
    languageId: parserLanguage(request.languageId),
    source: request.source,
  });
  const coordinates = new SourceCoordinateIndex(request.source);
  compilerTokens(request.source);
  const sourceDigest = sha256(request.source);
  const localNames = new Set(facts.symbols.map((symbol) => symbol.name));
  const importedByLocalName = new Map<
    string,
    { importedName: string; resolvedFile: string | null }
  >();
  const records: CompilerResolution[] = [];
  for (const entry of facts.imports) {
    const resolvedFile = resolvedModule(fileName, entry.source, companions);
    importedByLocalName.set(entry.localName, {
      importedName: entry.importedName,
      resolvedFile,
    });
    records.push(
      makeResolution(
        sourceDigest,
        "import",
        entry.source,
        evidenceRange(
          entry.range,
          request.source,
          entry.source,
          coordinates,
          true,
        ),
        resolvedFile,
        importedResolution(entry, resolvedFile, companions),
      ),
    );
  }
  for (const entry of facts.exports) {
    if (!entry.source) continue;
    const resolvedFile = resolvedModule(fileName, entry.source, companions);
    records.push(
      makeResolution(
        sourceDigest,
        "export",
        entry.source,
        evidenceRange(
          entry.range,
          request.source,
          entry.source,
          coordinates,
          true,
        ),
        resolvedFile,
        entry.exportedName,
      ),
    );
  }
  for (const entry of facts.calls) {
    const rootName = entry.callee.split(".")[0] ?? entry.callee;
    const imported = importedByLocalName.get(rootName);
    records.push(
      makeResolution(
        sourceDigest,
        "call",
        entry.callee,
        evidenceRange(entry.range, request.source, entry.callee, coordinates),
        imported?.resolvedFile ?? (localNames.has(rootName) ? fileName : null),
        imported?.importedName ?? rootName,
      ),
    );
  }
  for (const [kind, relationships] of [
    ["inheritance", facts.inheritance],
    ["implementation", facts.implementations],
  ] as const) {
    for (const entry of relationships) {
      const rootName = entry.targetName.split(".")[0] ?? entry.targetName;
      const imported = importedByLocalName.get(rootName);
      records.push(
        makeResolution(
          sourceDigest,
          kind,
          entry.targetName,
          evidenceRange(
            entry.range,
            request.source,
            entry.targetName,
            coordinates,
          ),
          imported?.resolvedFile ??
            (localNames.has(rootName) ? fileName : null),
          imported?.importedName ?? rootName,
        ),
      );
    }
  }
  return records.sort(
    (left, right) =>
      left.range.startCoordinate.utf16Offset -
        right.range.startCoordinate.utf16Offset ||
      left.kind.localeCompare(right.kind),
  );
}

export function analyzeCompilerLanguage(
  request: WebAnalyzeRequest,
): WebLanguageAnalysis {
  const parsed = parseSource({
    extractorVersion: `ast-mcp.web.compiler-facts.v1+${typescriptVersion}`,
    languageId: parserLanguage(request.languageId),
    source: request.source,
  });
  const facts = {
    ...parsed,
    languageId: request.languageId,
    syntaxFactsArtifactId: sha256(
      JSON.stringify([
        parsed.syntaxFactsArtifactId,
        request.languageId,
        compilerFingerprint,
      ]),
    ),
  };
  return {
    diagnostics: [],
    embeddedRegions: [],
    facts,
    languageId: request.languageId,
    resolutions: compilerResolutions(request),
  };
}
export { compilerFingerprint };
