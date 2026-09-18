import { type ParserError, parseFragment } from "parse5";

import type {
  ExactSourceRange,
  NormalizedSyntaxNode,
  SyntaxCall,
  SyntaxDiagnostic,
  SyntaxExport,
  SyntaxFacts,
  SyntaxImport,
  SyntaxReference,
  SyntaxRelationship,
  SyntaxSymbol,
} from "../../parser/index.ts";
import {
  EmbeddedSourceMap,
  parseSource,
  SourceCoordinateIndex,
  sha256,
} from "../../parser/index.ts";
import type {
  EmbeddedRegion,
  WebAnalyzeRequest,
  WebLanguageAnalysis,
  WebLanguageDiagnostic,
  WebLanguageId,
} from "./types.ts";

interface RegionCandidate {
  end: number;
  languageId: "javascript" | "typescript";
  start: number;
}

const templateExtractorVersion = "ast-mcp.web.templates.v2";

function id(
  sourceDigest: string,
  kind: string,
  range: ExactSourceRange,
  values: unknown[],
): string {
  return sha256(
    JSON.stringify([
      templateExtractorVersion,
      sourceDigest,
      kind,
      range.startCoordinate.utf16Offset,
      range.endCoordinate.utf16Offset,
      ...values,
    ]),
  );
}

interface HtmlLocation {
  endOffset: number;
  endTag?: HtmlLocation;
  startOffset: number;
  startTag?: HtmlLocation;
}

interface HtmlNode {
  attrs?: Array<{ name: string; value: string }>;
  childNodes?: HtmlNode[];
  content?: HtmlNode;
  sourceCodeLocation?: HtmlLocation;
  tagName?: string;
}

interface HtmlParseIssue {
  code: string;
  end: number;
  start: number;
}

interface ScriptExtraction {
  malformedStarts: number[];
  parseIssues: HtmlParseIssue[];
  regions: RegionCandidate[];
}

function scriptLanguage(
  attributes: readonly { name: string; value: string }[],
): "javascript" | "typescript" {
  const values = new Map(
    attributes.map(({ name, value }) => [
      name.toLowerCase(),
      value.toLowerCase(),
    ]),
  );
  return ["ts", "typescript"].includes(values.get("lang") ?? "") ||
    values.get("type") === "text/typescript"
    ? "typescript"
    : "javascript";
}

function tagRegions(source: string): ScriptExtraction {
  const extraction: ScriptExtraction = {
    malformedStarts: [],
    parseIssues: [],
    regions: [],
  };
  const parseIssues: HtmlParseIssue[] = [];
  const fragment = parseFragment(source, {
    onParseError(error: ParserError) {
      parseIssues.push({
        code: error.code,
        end: error.endOffset,
        start: error.startOffset,
      });
    },
    sourceCodeLocationInfo: true,
  }) as unknown as HtmlNode;
  const visited = new Set<HtmlNode>();
  const visit = (node: HtmlNode): void => {
    if (visited.has(node)) return;
    visited.add(node);
    if (node.tagName?.toLowerCase() === "script") {
      const location = node.sourceCodeLocation;
      const startTag = location?.startTag;
      const endTag = location?.endTag;
      if (!startTag || !endTag) {
        extraction.malformedStarts.push(
          startTag?.startOffset ?? location?.startOffset ?? 0,
        );
      } else {
        extraction.regions.push({
          end: endTag.startOffset,
          languageId: scriptLanguage(node.attrs ?? []),
          start: startTag.endOffset,
        });
        extraction.parseIssues.push(
          ...parseIssues.filter(
            (issue) =>
              issue.start >= endTag.startOffset &&
              issue.start <= endTag.endOffset,
          ),
        );
      }
    }
    for (const child of node.childNodes ?? []) visit(child);
    for (const child of node.content?.childNodes ?? []) visit(child);
  };
  visit(fragment);
  return extraction;
}

function delimiterRegions(
  source: string,
  open: RegExp,
  close: RegExp,
  languageId: "javascript" | "typescript" = "javascript",
): RegionCandidate[] {
  const regions: RegionCandidate[] = [];
  const opener = new RegExp(
    open.source,
    open.flags.includes("g") ? open.flags : `${open.flags}g`,
  );
  let match = opener.exec(source);
  while (match) {
    const bodyStart = match.index + match[0].length;
    const closer = new RegExp(close.source, close.flags.replace("g", ""));
    const tail = source.slice(bodyStart);
    const endMatch = closer.exec(tail);
    if (!endMatch) break;
    regions.push({
      end: bodyStart + endMatch.index,
      languageId,
      start: bodyStart,
    });
    opener.lastIndex = bodyStart + endMatch.index + endMatch[0].length;
    match = opener.exec(source);
  }
  return regions;
}

function uniqueRegions(regions: RegionCandidate[]): RegionCandidate[] {
  return regions
    .filter((region) => region.end > region.start)
    .sort((left, right) => left.start - right.start || left.end - right.end)
    .filter(
      (region, index, all) =>
        !all.some(
          (other, otherIndex) =>
            otherIndex < index &&
            other.start <= region.start &&
            other.end >= region.end,
        ),
    );
}

function candidates(
  languageId: WebLanguageId,
  source: string,
  scripts: ScriptExtraction,
): RegionCandidate[] {
  if (languageId === "vue" || languageId === "svelte") {
    return uniqueRegions(scripts.regions);
  }
  if (languageId === "astro") {
    return uniqueRegions([
      ...delimiterRegions(
        source,
        /^---\s*\r?\n/m,
        /\r?\n---(?=\s*(?:\r?\n|$))/,
        "typescript",
      ),
      ...scripts.regions,
    ]);
  }
  if (languageId === "ejs") {
    return uniqueRegions(delimiterRegions(source, /<%(?:_|-|=|#)?/, /[-_]?%>/));
  }
  if (languageId === "blade") {
    return uniqueRegions([
      ...delimiterRegions(source, /@php\b/, /@endphp\b/),
      ...delimiterRegions(source, /{!!/, /!!}/),
      ...delimiterRegions(source, /{{/, /}}/),
    ]);
  }
  if (languageId === "razor") {
    return [];
  }
  return [];
}

function mapRange(
  sourceMap: EmbeddedSourceMap,
  range: ExactSourceRange,
): ExactSourceRange | null {
  return sourceMap.embeddedToHost(range);
}

function mapSymbols(
  values: SyntaxSymbol[],
  sourceMap: EmbeddedSourceMap,
  sourceDigest: string,
): SyntaxSymbol[] {
  return values.flatMap((value) => {
    const range = mapRange(sourceMap, value.range);
    const declarationRange = mapRange(sourceMap, value.declarationRange);
    if (!range || !declarationRange) return [];
    return [
      {
        ...value,
        declarationRange,
        id: id(sourceDigest, "symbol", range, [
          value.kind,
          value.qualifiedName,
        ]),
        range,
      },
    ];
  });
}

function mapImports(
  values: SyntaxImport[],
  sourceMap: EmbeddedSourceMap,
  sourceDigest: string,
): SyntaxImport[] {
  return values.flatMap((value) => {
    const range = mapRange(sourceMap, value.range);
    return range
      ? [
          {
            ...value,
            id: id(sourceDigest, "import", range, [
              value.importedName,
              value.localName,
              value.source,
            ]),
            range,
          },
        ]
      : [];
  });
}

function mapExports(
  values: SyntaxExport[],
  sourceMap: EmbeddedSourceMap,
  sourceDigest: string,
): SyntaxExport[] {
  return values.flatMap((value) => {
    const range = mapRange(sourceMap, value.range);
    return range
      ? [
          {
            ...value,
            id: id(sourceDigest, "export", range, [
              value.exportedName,
              value.localName,
              value.source,
            ]),
            range,
          },
        ]
      : [];
  });
}

function mapCalls(
  values: SyntaxCall[],
  sourceMap: EmbeddedSourceMap,
  sourceDigest: string,
  symbolIds: ReadonlyMap<string, string>,
): SyntaxCall[] {
  return values.flatMap((value) => {
    const range = mapRange(sourceMap, value.range);
    return range
      ? [
          {
            ...value,
            enclosingSymbolId: value.enclosingSymbolId
              ? (symbolIds.get(value.enclosingSymbolId) ?? null)
              : null,
            id: id(sourceDigest, "call", range, [value.callee]),
            range,
          },
        ]
      : [];
  });
}

function mapRelationships(
  values: SyntaxRelationship[],
  sourceMap: EmbeddedSourceMap,
  sourceDigest: string,
  kind: string,
  symbolIds: ReadonlyMap<string, string>,
): SyntaxRelationship[] {
  return values.flatMap((value) => {
    const range = mapRange(sourceMap, value.range);
    return range
      ? [
          {
            ...value,
            id: id(sourceDigest, kind, range, [value.targetName]),
            range,
            sourceSymbolId: value.sourceSymbolId
              ? (symbolIds.get(value.sourceSymbolId) ?? null)
              : null,
          },
        ]
      : [];
  });
}

function mapReferences(
  values: SyntaxReference[],
  sourceMap: EmbeddedSourceMap,
  sourceDigest: string,
  symbolIds: ReadonlyMap<string, string>,
): SyntaxReference[] {
  return values.flatMap((value) => {
    const range = mapRange(sourceMap, value.range);
    return range
      ? [
          {
            ...value,
            enclosingSymbolId: value.enclosingSymbolId
              ? (symbolIds.get(value.enclosingSymbolId) ?? null)
              : null,
            id: id(sourceDigest, "reference", range, [value.name, value.role]),
            range,
          },
        ]
      : [];
  });
}

function mapDiagnostics(
  values: SyntaxDiagnostic[],
  sourceMap: EmbeddedSourceMap,
): SyntaxDiagnostic[] {
  return values.flatMap((value) => {
    const range = mapRange(sourceMap, value.range);
    return range ? [{ ...value, range }] : [];
  });
}

function rootNode(source: string, sourceDigest: string): NormalizedSyntaxNode {
  const range = new SourceCoordinateIndex(source).range(0, source.length);
  return {
    childIds: [],
    id: id(sourceDigest, "template-root", range, []),
    kind: "template_document",
    named: true,
    parentId: null,
    range,
  };
}

function malformedDiagnostics(
  languageId: WebLanguageId,
  source: string,
  _regions: readonly EmbeddedRegion[],
  scripts: ScriptExtraction,
): WebLanguageDiagnostic[] {
  const coordinates = new SourceCoordinateIndex(source);
  const diagnostics: WebLanguageDiagnostic[] = [];
  if (["astro", "svelte", "vue"].includes(languageId)) {
    for (const start of scripts.malformedStarts) {
      diagnostics.push({
        code: "malformed-embedded-region",
        message: "Unclosed script element",
        range: coordinates.range(start, source.length),
        severity: "error",
      });
    }
    for (const issue of scripts.parseIssues) {
      const start = Math.min(issue.start, source.length);
      const end = Math.min(Math.max(issue.end, start), source.length);
      diagnostics.push({
        code: "malformed-embedded-region",
        message: `HTML parse error: ${issue.code}`,
        range: coordinates.range(start, end),
        severity: "error",
      });
    }
  }
  const checks: Array<[RegExp, RegExp, string]> =
    languageId === "ejs"
      ? [[/<%(?:_|-|=|#)?/g, /[-_]?%>/g, "Unclosed EJS block"]]
      : languageId === "blade"
        ? [[/@php\b/g, /@endphp\b/g, "Unclosed Blade PHP block"]]
        : [];
  for (const [open, close, message] of checks) {
    const openCount = [...source.matchAll(open)].length;
    const closeCount = [...source.matchAll(close)].length;
    if (openCount > closeCount) {
      const start = Math.max(0, source.search(open));
      diagnostics.push({
        code: "malformed-embedded-region",
        message,
        range: coordinates.range(start, source.length),
        severity: "error",
      });
    }
  }
  if (languageId === "razor") {
    const marker = /@(?:\{|\(|await\b)/u.exec(source);
    if (marker?.index !== undefined) {
      diagnostics.push({
        code: "unsupported-construct",
        message:
          "Razor C# blocks and expressions require the C# language adapter",
        range: coordinates.range(marker.index, marker.index + marker[0].length),
        severity: "warning",
      });
    }
  }
  return diagnostics;
}

function syntaxDiagnostic(diagnostic: WebLanguageDiagnostic): SyntaxDiagnostic {
  return {
    code:
      diagnostic.code === "malformed-embedded-region"
        ? "parse-error"
        : "missing-node",
    message: diagnostic.message,
    range: diagnostic.range,
    severity: diagnostic.severity,
  };
}

export function analyzeTemplate(
  request: WebAnalyzeRequest,
): WebLanguageAnalysis {
  const sourceDigest = sha256(request.source);
  const scripts = tagRegions(request.source);
  const regions: EmbeddedRegion[] = candidates(
    request.languageId,
    request.source,
    scripts,
  ).map((region, ordinal) => ({
    endUtf16: region.end,
    hostLanguageId: request.languageId,
    languageId: region.languageId,
    ordinal,
    source: request.source.slice(region.start, region.end),
    startUtf16: region.start,
  }));
  const root = rootNode(request.source, sourceDigest);
  const symbols: SyntaxSymbol[] = [];
  const imports: SyntaxImport[] = [];
  const exports: SyntaxExport[] = [];
  const calls: SyntaxCall[] = [];
  const inheritance: SyntaxRelationship[] = [];
  const implementations: SyntaxRelationship[] = [];
  const references: SyntaxReference[] = [];
  const diagnostics: SyntaxDiagnostic[] = [];

  for (const region of regions) {
    const sourceMap = new EmbeddedSourceMap(request.source, region.source, [
      {
        embeddedEnd: region.source.length,
        embeddedStart: 0,
        hostEnd: region.endUtf16,
        hostStart: region.startUtf16,
      },
    ]);
    const facts = parseSource({
      extractorVersion: templateExtractorVersion,
      languageId: region.languageId,
      source: region.source,
    });
    const regionSymbols = mapSymbols(facts.symbols, sourceMap, sourceDigest);
    const symbolIds = new Map(
      facts.symbols.flatMap((symbol, index) => {
        const mapped = regionSymbols[index];
        return mapped ? [[symbol.id, mapped.id] as const] : [];
      }),
    );
    symbols.push(...regionSymbols);
    imports.push(...mapImports(facts.imports, sourceMap, sourceDigest));
    exports.push(...mapExports(facts.exports, sourceMap, sourceDigest));
    calls.push(...mapCalls(facts.calls, sourceMap, sourceDigest, symbolIds));
    inheritance.push(
      ...mapRelationships(
        facts.inheritance,
        sourceMap,
        sourceDigest,
        "inheritance",
        symbolIds,
      ),
    );
    implementations.push(
      ...mapRelationships(
        facts.implementations,
        sourceMap,
        sourceDigest,
        "implementation",
        symbolIds,
      ),
    );
    references.push(
      ...mapReferences(facts.references, sourceMap, sourceDigest, symbolIds),
    );
    diagnostics.push(...mapDiagnostics(facts.diagnostics, sourceMap));
  }

  const syntaxFactsArtifactId = sha256(
    JSON.stringify([
      "ast-mcp.syntax-facts.v1",
      request.languageId,
      sourceDigest,
      templateExtractorVersion,
      regions.map((region) => [
        region.languageId,
        region.startUtf16,
        region.endUtf16,
      ]),
    ]),
  );
  const hostDiagnostics = malformedDiagnostics(
    request.languageId,
    request.source,
    regions,
    scripts,
  );
  diagnostics.push(...hostDiagnostics.map(syntaxDiagnostic));
  const facts: SyntaxFacts = {
    calls,
    diagnostics,
    exports,
    extractorFingerprint: sha256(templateExtractorVersion),
    grammarFingerprint: sha256(`${request.languageId}:embedded:v1`),
    implementations,
    imports,
    inheritance,
    languageId: request.languageId,
    nodes: [root],
    parserFingerprint: sha256("ast-mcp.web.template-parser.v2"),
    partial: diagnostics.some((diagnostic) => diagnostic.severity === "error"),
    references,
    rootNodeId: root.id,
    schemaVersion: "ast-mcp.syntax-facts.v1",
    sourceArtifactId: sha256(JSON.stringify(["source", sourceDigest])),
    sourceDigest,
    symbols,
    syntaxFactsArtifactId,
  };
  return {
    diagnostics: hostDiagnostics,
    embeddedRegions: regions,
    facts,
    languageId: request.languageId,
    resolutions: [],
  };
}
