import { createHash } from "node:crypto";
import {
  createIdentity,
  type EvidenceRange,
  RepositoryIdSchema,
  RepositoryRelativePathSchema,
  RevisionIdSchema,
  Sha256Schema,
} from "../contracts/common.ts";
import type {
  CodeResolutionSource,
  DocumentResolutionSource,
  GraphMaterializationInput,
  MaterializedNode,
  MaterializedOccurrence,
  MaterializedRelationship,
  ProjectResolutionSource,
  ResolutionEvidence,
  ResolutionMembership,
  ResolutionSource,
  ResolutionStatus,
  ResolveGraphRequest,
} from "./types.ts";

const hashPattern = /^[a-f0-9]{64}$/u;
const legacySourceArtifactId = (sourceDigest: string): string =>
  createHash("sha256")
    .update(JSON.stringify(["source", sourceDigest]))
    .digest("hex");
const sourceArtifactMatchesDigest = (
  artifactId: unknown,
  sourceDigest: unknown,
): artifactId is string =>
  typeof sourceDigest === "string" &&
  typeof artifactId === "string" &&
  (artifactId === legacySourceArtifactId(sourceDigest) ||
    artifactId === createIdentity("source", { contentDigest: sourceDigest }));
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> => {
  if (!record(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
};
const hashValue = (value: unknown): value is string =>
  typeof value === "string" && hashPattern.test(value);
const artifactValue = (value: unknown, namespace: string): value is string =>
  hashValue(value) ||
  (typeof value === "string" &&
    new RegExp(`^${namespace}:v1:[a-f0-9]{64}$`, "u").test(value));
const nonnegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
function validRange(value: unknown): value is EvidenceRange {
  if (
    !exact(value, [
      "end",
      "endByte",
      "endCoordinate",
      "start",
      "startByte",
      "startCoordinate",
    ])
  )
    return false;
  if (
    !exact(value.start, ["column", "line"]) ||
    !exact(value.end, ["column", "line"]) ||
    !exact(value.startCoordinate, [
      "byteOffset",
      "characterOffset",
      "column",
      "line",
      "utf16Column",
      "utf16Offset",
    ]) ||
    !exact(value.endCoordinate, [
      "byteOffset",
      "characterOffset",
      "column",
      "line",
      "utf16Column",
      "utf16Offset",
    ])
  )
    return false;
  const start = value.start as Record<string, number>;
  const end = value.end as Record<string, number>;
  const a = value.startCoordinate as Record<string, number>;
  const b = value.endCoordinate as Record<string, number>;
  if (
    ![
      value.startByte,
      value.endByte,
      start.line,
      start.column,
      end.line,
      end.column,
      a.byteOffset,
      a.characterOffset,
      a.column,
      a.line,
      a.utf16Column,
      a.utf16Offset,
      b.byteOffset,
      b.characterOffset,
      b.column,
      b.line,
      b.utf16Column,
      b.utf16Offset,
    ].every(nonnegative)
  )
    return false;
  return (
    value.startByte === a.byteOffset &&
    value.endByte === b.byteOffset &&
    start.line === a.line &&
    start.column === a.column &&
    end.line === b.line &&
    end.column === b.column &&
    a.byteOffset <= b.byteOffset &&
    a.characterOffset <= b.characterOffset &&
    a.utf16Offset <= b.utf16Offset &&
    (a.line < b.line ||
      (a.line === b.line &&
        a.column <= b.column &&
        a.utf16Column <= b.utf16Column))
  );
}
const validIdRange = (
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> =>
  exact(value, keys) && hashValue(value.id) && validRange(value.range);
function validateCodeFacts(
  value: unknown,
): asserts value is CodeResolutionSource["facts"] {
  const keys = [
    "calls",
    "diagnostics",
    "exports",
    "extractorFingerprint",
    "grammarFingerprint",
    "implementations",
    "imports",
    "inheritance",
    "languageId",
    "nodes",
    "parserFingerprint",
    "partial",
    "references",
    "rootNodeId",
    "schemaVersion",
    "sourceArtifactId",
    "sourceDigest",
    "symbols",
    "syntaxFactsArtifactId",
  ];
  if (!exact(value, keys)) throw new TypeError("Invalid code facts");
  for (const key of [
    "extractorFingerprint",
    "grammarFingerprint",
    "parserFingerprint",
    "sourceDigest",
    "rootNodeId",
  ])
    if (!hashValue(value[key]))
      throw new TypeError("Invalid code artifact identity");
  if (
    !sourceArtifactMatchesDigest(value.sourceArtifactId, value.sourceDigest) ||
    !artifactValue(value.syntaxFactsArtifactId, "syntax-facts")
  )
    throw new TypeError("Invalid code artifact identity");
  if (
    value.schemaVersion !== "ast-mcp.syntax-facts.v1" ||
    typeof value.languageId !== "string" ||
    typeof value.partial !== "boolean"
  )
    throw new TypeError("Invalid code facts metadata");
  const collections = [
    "nodes",
    "symbols",
    "imports",
    "exports",
    "calls",
    "inheritance",
    "implementations",
    "references",
  ] as const;
  if (
    !collections.every((key) => Array.isArray(value[key])) ||
    !Array.isArray(value.diagnostics)
  )
    throw new TypeError("Invalid code fact collections");
  const nodeIds = new Set<string>();
  const semanticIds = new Set<string>();
  for (const item of value.nodes as unknown[]) {
    if (
      !validIdRange(item, [
        "childIds",
        "id",
        "kind",
        "named",
        "parentId",
        "range",
      ]) ||
      !Array.isArray(item.childIds) ||
      !item.childIds.every(hashValue) ||
      (item.parentId !== null && !hashValue(item.parentId)) ||
      typeof item.kind !== "string" ||
      typeof item.named !== "boolean"
    )
      throw new TypeError("Invalid syntax node");
    if (
      nodeIds.has(item.id as string) ||
      new Set(item.childIds).size !== item.childIds.length
    )
      throw new TypeError("Duplicate syntax identity");
    nodeIds.add(item.id as string);
  }
  if (!nodeIds.has(value.rootNodeId as string))
    throw new TypeError("Invalid syntax root");
  const syntaxNodes = value.nodes as Array<Record<string, unknown>>;
  const syntaxById = new Map(
    syntaxNodes.map((node) => [node.id as string, node]),
  );
  const syntaxRoot = syntaxById.get(value.rootNodeId as string);
  if (syntaxRoot?.parentId !== null)
    throw new TypeError("Invalid syntax root parent");
  for (const item of syntaxNodes) {
    if (
      (item.parentId !== null && !nodeIds.has(item.parentId as string)) ||
      (item.childIds as string[]).some((id) => !nodeIds.has(id))
    )
      throw new TypeError("Dangling syntax link");
    if (item.parentId !== null) {
      const parent = syntaxById.get(item.parentId as string);
      if (
        !(parent?.childIds as string[] | undefined)?.includes(item.id as string)
      )
        throw new TypeError("Nonreciprocal syntax parent");
    }
    for (const childId of item.childIds as string[]) {
      if (syntaxById.get(childId)?.parentId !== item.id)
        throw new TypeError("Nonreciprocal syntax child");
    }
    const visited = new Set<string>();
    let current: Record<string, unknown> | undefined = item;
    while (current && current.id !== value.rootNodeId) {
      if (visited.has(current.id as string))
        throw new TypeError("Cyclic syntax hierarchy");
      visited.add(current.id as string);
      current =
        current.parentId === null
          ? undefined
          : syntaxById.get(current.parentId as string);
    }
    if (!current) throw new TypeError("Unreachable syntax root");
  }
  const validators: Array<[unknown, readonly string[]]> = [];
  for (const item of value.symbols as unknown[])
    validators.push([
      item,
      [
        "declarationRange",
        "exported",
        "id",
        "kind",
        "name",
        "qualifiedName",
        "range",
      ],
    ]);
  for (const item of value.imports as unknown[])
    validators.push([
      item,
      ["id", "importedName", "localName", "range", "source", "typeOnly"],
    ]);
  for (const item of value.exports as unknown[])
    validators.push([
      item,
      ["exportedName", "id", "localName", "range", "source", "typeOnly"],
    ]);
  for (const item of value.calls as unknown[])
    validators.push([item, ["callee", "enclosingSymbolId", "id", "range"]]);
  for (const item of [
    ...(value.inheritance as unknown[]),
    ...(value.implementations as unknown[]),
  ])
    validators.push([item, ["id", "range", "sourceSymbolId", "targetName"]]);
  for (const item of value.references as unknown[])
    validators.push([
      item,
      ["enclosingSymbolId", "id", "name", "range", "role"],
    ]);
  for (const [item, itemKeys] of validators) {
    if (!validIdRange(item, itemKeys))
      throw new TypeError("Invalid semantic fact");
    if (semanticIds.has(item.id as string) || nodeIds.has(item.id as string))
      throw new TypeError("Duplicate fact identity");
    semanticIds.add(item.id as string);
  }
  const symbolKinds = [
    "class",
    "interface",
    "function",
    "method",
    "variable",
    "type",
    "enum",
    "namespace",
    "unknown",
  ];
  for (const item of value.symbols as Array<Record<string, unknown>>) {
    if (
      !validRange(item.declarationRange) ||
      typeof item.name !== "string" ||
      typeof item.qualifiedName !== "string" ||
      !symbolKinds.includes(String(item.kind)) ||
      typeof item.exported !== "boolean"
    )
      throw new TypeError("Invalid symbol");
  }
  for (const item of value.imports as Array<Record<string, unknown>>) {
    if (
      typeof item.importedName !== "string" ||
      typeof item.localName !== "string" ||
      typeof item.source !== "string" ||
      typeof item.typeOnly !== "boolean"
    )
      throw new TypeError("Invalid import");
  }
  for (const item of value.exports as Array<Record<string, unknown>>) {
    if (
      typeof item.exportedName !== "string" ||
      (item.localName !== null && typeof item.localName !== "string") ||
      (item.source !== null && typeof item.source !== "string") ||
      typeof item.typeOnly !== "boolean"
    )
      throw new TypeError("Invalid export");
  }
  for (const item of value.calls as Array<Record<string, unknown>>)
    if (typeof item.callee !== "string") throw new TypeError("Invalid call");
  for (const item of [
    ...(value.inheritance as Array<Record<string, unknown>>),
    ...(value.implementations as Array<Record<string, unknown>>),
  ])
    if (typeof item.targetName !== "string")
      throw new TypeError("Invalid relationship");
  for (const item of value.references as Array<Record<string, unknown>>)
    if (
      typeof item.name !== "string" ||
      !["read", "write", "type"].includes(String(item.role))
    )
      throw new TypeError("Invalid reference");
  const symbolIds = new Set(
    (value.symbols as Array<{ id: string }>).map(({ id }) => id),
  );
  for (const item of [
    ...(value.calls as Array<Record<string, unknown>>),
    ...(value.references as Array<Record<string, unknown>>),
  ]) {
    if (
      item.enclosingSymbolId !== null &&
      (!hashValue(item.enclosingSymbolId) ||
        !symbolIds.has(item.enclosingSymbolId))
    )
      throw new TypeError("Dangling enclosing symbol");
  }
  for (const item of [
    ...(value.inheritance as Array<Record<string, unknown>>),
    ...(value.implementations as Array<Record<string, unknown>>),
  ]) {
    if (
      item.sourceSymbolId !== null &&
      (!hashValue(item.sourceSymbolId) || !symbolIds.has(item.sourceSymbolId))
    )
      throw new TypeError("Dangling relationship symbol");
  }
  for (const item of value.diagnostics as unknown[]) {
    if (
      !exact(item, ["code", "message", "range", "severity"]) ||
      !validRange(item.range) ||
      typeof item.code !== "string" ||
      typeof item.message !== "string" ||
      typeof item.severity !== "string"
    )
      throw new TypeError("Invalid diagnostic");
  }
}
function validateDocumentFacts(
  value: unknown,
): asserts value is DocumentResolutionSource["facts"] {
  if (
    !exact(value, ["artifactId", "nodes", "relationships", "sourceDigest"]) ||
    !hashValue(value.sourceDigest) ||
    !sourceArtifactMatchesDigest(value.artifactId, value.sourceDigest) ||
    !Array.isArray(value.nodes) ||
    !Array.isArray(value.relationships)
  )
    throw new TypeError("Invalid document facts");
  const ids = new Set<string>();
  for (const node of value.nodes) {
    const keys =
      record(node) && "nodeKind" in node
        ? ["id", "name", "nodeKind", "parentId", "range"]
        : ["id", "name", "parentId", "range"];
    if (
      !validIdRange(node, keys) ||
      typeof node.name !== "string" ||
      (node.parentId !== null && !hashValue(node.parentId)) ||
      ("nodeKind" in node &&
        !["document", "section", "package", "resource"].includes(
          String(node.nodeKind),
        ))
    )
      throw new TypeError("Invalid document node");
    if (ids.has(node.id as string))
      throw new TypeError("Duplicate document identity");
    ids.add(node.id as string);
  }
  for (const node of value.nodes) {
    if (node.parentId !== null && !ids.has(node.parentId))
      throw new TypeError("Dangling document parent");
    const visited = new Set<string>();
    let current: (typeof value.nodes)[number] | undefined = node;
    while (current?.parentId !== null) {
      if (visited.has(current.id))
        throw new TypeError("Cyclic document hierarchy");
      visited.add(current.id);
      current = value.nodes.find(
        (candidate) => candidate.id === current?.parentId,
      );
    }
    if (!current) throw new TypeError("Unreachable document root");
  }
  for (const edge of value.relationships) {
    if (
      !validIdRange(edge, ["id", "kind", "range", "sourceNodeId", "target"]) ||
      !["document-link", "dependency", "reference", "resource"].includes(
        String(edge.kind),
      ) ||
      typeof edge.target !== "string" ||
      (edge.sourceNodeId !== null && !ids.has(edge.sourceNodeId as string))
    )
      throw new TypeError("Invalid document relationship");
    if (ids.has(edge.id as string))
      throw new TypeError("Duplicate document identity");
    ids.add(edge.id as string);
  }
}
function validateProjectFacts(
  value: unknown,
): asserts value is ProjectResolutionSource["facts"] {
  if (
    !exact(value, [
      "diagnostics",
      "format",
      "nodes",
      "parserFingerprint",
      "partial",
      "relationships",
      "rewriteSupported",
      "schemaVersion",
      "sourceArtifactId",
      "sourceByteLength",
      "sourceDigest",
      "syntaxFactsArtifactId",
    ]) ||
    !hashValue(value.parserFingerprint) ||
    !hashValue(value.sourceDigest) ||
    !sourceArtifactMatchesDigest(value.sourceArtifactId, value.sourceDigest) ||
    !artifactValue(value.syntaxFactsArtifactId, "syntax-facts") ||
    value.schemaVersion !== "ast-mcp.project-facts.v1" ||
    value.rewriteSupported !== false ||
    ![
      "dotnet-solution",
      "dotnet-solution-xml",
      "dotnet-project",
      "dotnet-build",
      "nuget-manifest",
      "nuget-packages",
      "dotnet-resource",
      "xaml",
      "lazarus-project",
      "lazarus-package",
      "lazarus-form",
      "delphi-form",
    ].includes(String(value.format)) ||
    typeof value.partial !== "boolean" ||
    !nonnegative(value.sourceByteLength) ||
    !Array.isArray(value.nodes) ||
    !Array.isArray(value.relationships) ||
    !Array.isArray(value.diagnostics)
  )
    throw new TypeError("Invalid project facts");
  const ids = new Set<string>();
  for (const node of value.nodes) {
    if (
      !validIdRange(node, [
        "attributes",
        "childIds",
        "id",
        "kind",
        "name",
        "parentId",
        "range",
      ]) ||
      !record(node.attributes) ||
      !Array.isArray(node.childIds) ||
      !node.childIds.every(hashValue) ||
      typeof node.name !== "string" ||
      ![
        "project",
        "package",
        "resource",
        "component",
        "property",
        "element",
      ].includes(String(node.kind)) ||
      (node.parentId !== null && !hashValue(node.parentId))
    )
      throw new TypeError("Invalid project node");
    if (
      ids.has(node.id as string) ||
      new Set(node.childIds).size !== node.childIds.length
    )
      throw new TypeError("Duplicate project identity");
    ids.add(node.id as string);
  }
  for (const node of value.nodes) {
    if (
      (node.parentId !== null && !ids.has(node.parentId)) ||
      node.childIds.some((id: string) => !ids.has(id))
    )
      throw new TypeError("Dangling project node");
    if (node.parentId !== null) {
      const parent = value.nodes.find(
        (candidate) => candidate.id === node.parentId,
      );
      if (!parent?.childIds.includes(node.id))
        throw new TypeError("Nonreciprocal project parent");
    }
    for (const childId of node.childIds) {
      const child = value.nodes.find((candidate) => candidate.id === childId);
      if (child?.parentId !== node.id)
        throw new TypeError("Nonreciprocal project child");
    }
  }
  for (const edge of value.relationships) {
    if (
      !validIdRange(edge, ["id", "kind", "range", "sourceNodeId", "target"]) ||
      !["dependency", "reference", "resource", "type-reference"].includes(
        String(edge.kind),
      ) ||
      typeof edge.target !== "string" ||
      (edge.sourceNodeId !== null && !ids.has(edge.sourceNodeId as string))
    )
      throw new TypeError("Invalid project relationship");
    if (ids.has(edge.id as string))
      throw new TypeError("Duplicate project identity");
    ids.add(edge.id as string);
  }
  for (const diagnostic of value.diagnostics)
    if (
      !exact(diagnostic, ["code", "message", "range", "severity"]) ||
      !validRange(diagnostic.range) ||
      !["malformed-project", "partial-format"].includes(
        String(diagnostic.code),
      ) ||
      typeof diagnostic.message !== "string" ||
      !["error", "warning"].includes(String(diagnostic.severity))
    )
      throw new TypeError("Invalid project diagnostic");
}
export function parseResolveGraphRequest(value: unknown): ResolveGraphRequest {
  if (
    !exact(value, [
      "environmentFingerprint",
      "repositoryId",
      "resolverFingerprint",
      "revisionId",
      "sources",
    ]) ||
    !Array.isArray(value.sources)
  )
    throw new TypeError("Invalid resolution request");
  RepositoryIdSchema.parse(value.repositoryId);
  RevisionIdSchema.parse(value.revisionId);
  Sha256Schema.parse(value.environmentFingerprint);
  Sha256Schema.parse(value.resolverFingerprint);
  for (const source of value.sources) {
    if (
      !record(source) ||
      !["code", "document", "project"].includes(String(source.kind)) ||
      !exact(source, ["facts", "kind", "path"]) ||
      typeof source.path !== "string"
    )
      throw new TypeError("Invalid resolution source");
    RepositoryRelativePathSchema.parse(source.path);
    if (source.kind === "code") validateCodeFacts(source.facts);
    else if (source.kind === "document") validateDocumentFacts(source.facts);
    else validateProjectFacts(source.facts);
  }
  return value as unknown as ResolveGraphRequest;
}

const extensionPattern = /\.[^/.]+$/u;
const sourceArtifact = (source: ResolutionSource): string =>
  source.kind === "code"
    ? source.facts.sourceArtifactId
    : source.kind === "project"
      ? source.facts.sourceArtifactId
      : source.facts.artifactId;
const identity = (
  namespace: string,
  values: readonly (string | number | null)[],
) => createIdentity(namespace, values);
const sorted = <T extends { id: string }>(items: T[]): T[] =>
  items.sort((left, right) => left.id.localeCompare(right.id));
const modulePath = (from: string, specifier: string): string | null => {
  if (!specifier.startsWith(".")) return null;
  const parts = from.split("/");
  parts.pop();
  for (const part of specifier.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.join("/");
};
const pathMatches = (candidate: string, requested: string): boolean => {
  const withoutExtension = candidate.replace(extensionPattern, "");
  const indexPath = candidate.replace(/\/index\.[^/.]+$/u, "");
  return (
    candidate === requested ||
    withoutExtension === requested ||
    indexPath === requested
  );
};
const resolutionStatus = (
  targets: readonly string[],
  exact: boolean,
): ResolutionStatus =>
  targets.length === 0
    ? "unresolved"
    : exact && targets.length === 1
      ? "resolved"
      : "ambiguous";

interface Mutable {
  evidence: ResolutionEvidence[];
  memberships: ResolutionMembership[];
  nodes: MaterializedNode[];
  occurrences: MaterializedOccurrence[];
  relationships: MaterializedRelationship[];
}
function addMembership(
  state: Mutable,
  request: ResolveGraphRequest,
  path: string,
  artifactId: string,
  entityId: string,
  entityKind: ResolutionMembership["entityKind"],
): void {
  state.memberships.push({
    entityId,
    entityKind,
    id: identity("membership", [
      request.repositoryId,
      request.revisionId,
      path,
      artifactId,
      entityKind,
      entityId,
    ]),
    path,
    repositoryId: request.repositoryId,
    revisionId: request.revisionId,
    sourceArtifactId: artifactId,
  });
}
function addOccurrence(
  state: Mutable,
  request: ResolveGraphRequest,
  source: ResolutionSource,
  sourceFactId: string,
  name: string,
  range: EvidenceRange,
  role: MaterializedOccurrence["role"],
  ordinal: number,
): MaterializedOccurrence {
  const artifactId = sourceArtifact(source);
  const occurrence = {
    id: identity("occurrence", [
      request.repositoryId,
      source.path,
      artifactId,
      sourceFactId,
      role,
      ordinal,
    ]),
    name,
    ordinal,
    path: source.path,
    range,
    role,
    sourceArtifactId: artifactId,
    sourceFactId,
  };
  state.occurrences.push(occurrence);
  addMembership(
    state,
    request,
    source.path,
    artifactId,
    occurrence.id,
    "occurrence",
  );
  return occurrence;
}
function addEvidence(
  state: Mutable,
  request: ResolveGraphRequest,
  source: ResolutionSource,
  occurrence: MaterializedOccurrence,
  basis: ResolutionEvidence["basis"],
): ResolutionEvidence {
  const evidence = {
    basis,
    id: identity("resolution-evidence", [
      request.environmentFingerprint,
      request.resolverFingerprint,
      occurrence.id,
      basis,
    ]),
    occurrenceId: occurrence.id,
    path: source.path,
    range: occurrence.range,
    sourceFactId: occurrence.sourceFactId,
  };
  state.evidence.push(evidence);
  addMembership(
    state,
    request,
    source.path,
    sourceArtifact(source),
    evidence.id,
    "evidence",
  );
  return evidence;
}
function addRelationship(
  state: Mutable,
  request: ResolveGraphRequest,
  source: ResolutionSource,
  occurrence: MaterializedOccurrence,
  evidence: ResolutionEvidence,
  kind: MaterializedRelationship["kind"],
  target: string,
  targetNodeIds: readonly string[],
  exact: boolean,
  sourceNodeId: string | null,
): void {
  const relationship = {
    evidenceIds: [evidence.id],
    id: identity("relationship", [
      request.environmentFingerprint,
      request.resolverFingerprint,
      occurrence.id,
      kind,
      target,
      ...targetNodeIds,
    ]),
    kind,
    sourceNodeId,
    status: resolutionStatus(targetNodeIds, exact),
    target,
    targetNodeIds: [...targetNodeIds].sort(),
  };
  state.relationships.push(relationship);
  addMembership(
    state,
    request,
    source.path,
    sourceArtifact(source),
    relationship.id,
    "relationship",
  );
}
function addNode(
  state: Mutable,
  request: ResolveGraphRequest,
  source: ResolutionSource,
  occurrence: MaterializedOccurrence,
  kind: MaterializedNode["kind"],
  name: string,
  qualifiedName: string | null,
): MaterializedNode {
  const node = {
    id: identity("graph-node", [
      request.repositoryId,
      source.path,
      sourceArtifact(source),
      occurrence.sourceFactId,
      occurrence.ordinal,
    ]),
    kind,
    name,
    occurrenceId: occurrence.id,
    parentNodeId: null,
    path: source.path,
    qualifiedName,
    range: occurrence.range,
    sourceArtifactId: sourceArtifact(source),
  };
  state.nodes.push(node);
  addMembership(
    state,
    request,
    source.path,
    sourceArtifact(source),
    node.id,
    "node",
  );
  return node;
}
function codeDeclarations(
  state: Mutable,
  request: ResolveGraphRequest,
  source: CodeResolutionSource,
): void {
  source.facts.symbols.forEach((fact, ordinal) => {
    const occurrence = addOccurrence(
      state,
      request,
      source,
      fact.id,
      fact.name,
      fact.declarationRange,
      "declaration",
      ordinal,
    );
    addNode(
      state,
      request,
      source,
      occurrence,
      "symbol",
      fact.name,
      fact.qualifiedName,
    );
    addEvidence(state, request, source, occurrence, "declaration");
  });
}
function structuredDeclarations(
  state: Mutable,
  request: ResolveGraphRequest,
  source: DocumentResolutionSource | ProjectResolutionSource,
  facts: readonly {
    id: string;
    kind: MaterializedNode["kind"];
    name: string;
    range: MaterializedOccurrence["range"];
  }[],
): void {
  facts.forEach((fact, ordinal) => {
    const occurrence = addOccurrence(
      state,
      request,
      source,
      fact.id,
      fact.name,
      fact.range,
      "declaration",
      ordinal,
    );
    addNode(state, request, source, occurrence, fact.kind, fact.name, null);
    addEvidence(state, request, source, occurrence, "declaration");
  });
}

function documentDeclarations(
  state: Mutable,
  request: ResolveGraphRequest,
  source: DocumentResolutionSource,
): void {
  structuredDeclarations(
    state,
    request,
    source,
    source.facts.nodes.map((fact) => ({
      id: fact.id,
      kind: fact.nodeKind ?? "document",
      name: fact.name,
      range: fact.range,
    })),
  );
}
function projectDeclarations(
  state: Mutable,
  request: ResolveGraphRequest,
  source: ProjectResolutionSource,
): void {
  structuredDeclarations(
    state,
    request,
    source,
    source.facts.nodes.map((fact) => ({
      id: fact.id,
      kind:
        fact.kind === "element" || fact.kind === "property"
          ? "component"
          : fact.kind,
      name: fact.name,
      range: fact.range,
    })),
  );
}
function declarationNode(
  state: Mutable,
  source: DocumentResolutionSource | ProjectResolutionSource,
  sourceFactId: string,
): MaterializedNode | undefined {
  const occurrence = state.occurrences.find(
    (item) =>
      item.path === source.path &&
      item.role === "declaration" &&
      item.sourceArtifactId === sourceArtifact(source) &&
      item.sourceFactId === sourceFactId,
  );
  return state.nodes.find((node) => node.occurrenceId === occurrence?.id);
}

function hierarchyRelationships(
  state: Mutable,
  request: ResolveGraphRequest,
  source: DocumentResolutionSource | ProjectResolutionSource,
): void {
  source.facts.nodes.forEach((fact, ordinal) => {
    if (fact.parentId === null) return;
    const parent = declarationNode(state, source, fact.parentId);
    const child = declarationNode(state, source, fact.id);
    if (!parent || !child)
      throw new TypeError("Validated hierarchy declaration is missing");
    child.parentNodeId = parent.id;
    const occurrence = addOccurrence(
      state,
      request,
      source,
      `${fact.id}:containment`,
      fact.name,
      fact.range,
      "relationship",
      ordinal,
    );
    const evidence = addEvidence(
      state,
      request,
      source,
      occurrence,
      "hierarchy",
    );
    addRelationship(
      state,
      request,
      source,
      occurrence,
      evidence,
      "containment",
      fact.name,
      [child.id],
      true,
      parent.id,
    );
  });
}

function targetsByName(
  nodes: readonly MaterializedNode[],
  name: string,
  path?: string,
  allowedKinds?: readonly MaterializedNode["kind"][],
): string[] {
  return nodes
    .filter(
      (node) =>
        node.name === name &&
        (path === undefined || node.path === path) &&
        (allowedKinds === undefined || allowedKinds.includes(node.kind)),
    )
    .map((node) => node.id)
    .sort();
}
function localCandidates(
  state: Mutable,
  source: CodeResolutionSource,
  name: string,
  atByte: number,
  enclosingSymbolId: string | null,
): string[] {
  const enclosing = enclosingSymbolId
    ? source.facts.symbols.find((item) => item.id === enclosingSymbolId)
    : undefined;
  const scope =
    enclosing?.qualifiedName.split(".").slice(0, -1).join(".") ?? "";
  let candidates = source.facts.symbols.filter((item) => item.name === name);
  if (scope) {
    const scoped = candidates.filter((item) =>
      item.qualifiedName.startsWith(`${scope}.`),
    );
    if (scoped.length) candidates = scoped;
  }
  const variables = candidates.filter(
    (item) =>
      item.kind === "variable" && item.declarationRange.startByte <= atByte,
  );
  if (variables.length) {
    const nearest = Math.max(
      ...variables.map((item) => item.declarationRange.startByte),
    );
    candidates = variables.filter(
      (item) => item.declarationRange.startByte === nearest,
    );
  }
  const ids = new Set(candidates.map((item) => item.id));
  return state.nodes
    .filter((node) => {
      const occurrence = state.occurrences.find(
        (item) => item.id === node.occurrenceId,
      );
      return (
        node.path === source.path &&
        Boolean(occurrence && ids.has(occurrence.sourceFactId))
      );
    })
    .map((node) => node.id)
    .sort();
}
function sourceSymbolNode(
  state: Mutable,
  source: CodeResolutionSource,
  symbolId: string | null,
): string | null {
  if (!symbolId) return null;
  const symbol = source.facts.symbols.find((item) => item.id === symbolId);
  const occurrence = symbol
    ? state.occurrences.find(
        (item) => item.sourceFactId === symbol.id && item.path === source.path,
      )
    : undefined;
  return (
    state.nodes.find((node) => node.occurrenceId === occurrence?.id)?.id ?? null
  );
}
function codeRelationships(
  state: Mutable,
  request: ResolveGraphRequest,
  source: CodeResolutionSource,
  sources: readonly ResolutionSource[],
): void {
  source.facts.references.forEach((fact, ordinal) => {
    const occurrence = addOccurrence(
      state,
      request,
      source,
      fact.id,
      fact.name,
      fact.range,
      fact.role,
      ordinal,
    );
    const targets = localCandidates(
      state,
      source,
      fact.name,
      fact.range.startByte,
      fact.enclosingSymbolId,
    );
    const evidence = addEvidence(
      state,
      request,
      source,
      occurrence,
      "local-scope",
    );
    addRelationship(
      state,
      request,
      source,
      occurrence,
      evidence,
      "reference",
      fact.name,
      targets,
      true,
      sourceSymbolNode(state, source, fact.enclosingSymbolId),
    );
  });
  source.facts.calls.forEach((fact, ordinal) => {
    const occurrence = addOccurrence(
      state,
      request,
      source,
      fact.id,
      fact.callee,
      fact.range,
      "call",
      ordinal,
    );
    const targets = localCandidates(
      state,
      source,
      fact.callee,
      fact.range.startByte,
      fact.enclosingSymbolId,
    );
    const evidence = addEvidence(
      state,
      request,
      source,
      occurrence,
      "name-only",
    );
    addRelationship(
      state,
      request,
      source,
      occurrence,
      evidence,
      "call",
      fact.callee,
      targets,
      false,
      sourceSymbolNode(state, source, fact.enclosingSymbolId),
    );
  });
  source.facts.imports.forEach((fact, ordinal) => {
    const occurrence = addOccurrence(
      state,
      request,
      source,
      fact.id,
      fact.importedName,
      fact.range,
      "import",
      ordinal,
    );
    const requestedPath = modulePath(source.path, fact.source);
    const exported =
      requestedPath === null
        ? targetsByName(state.nodes, fact.source, undefined, [
            "package",
            "project",
          ])
        : sources.flatMap((candidate) =>
            candidate.kind === "code" &&
            pathMatches(candidate.path, requestedPath)
              ? candidate.facts.exports
                  .filter((item) => item.exportedName === fact.importedName)
                  .flatMap((item) =>
                    targetsByName(
                      state.nodes,
                      item.localName ?? item.exportedName,
                      candidate.path,
                    ),
                  )
              : [],
          );
    const evidence = addEvidence(
      state,
      request,
      source,
      occurrence,
      "module-export",
    );
    addRelationship(
      state,
      request,
      source,
      occurrence,
      evidence,
      "import",
      fact.source,
      exported,
      true,
      null,
    );
  });
  source.facts.exports.forEach((fact, ordinal) => {
    const occurrence = addOccurrence(
      state,
      request,
      source,
      fact.id,
      fact.exportedName,
      fact.range,
      "export",
      ordinal,
    );
    const localName = fact.localName ?? fact.exportedName;
    const targets =
      fact.source === null
        ? targetsByName(state.nodes, localName, source.path)
        : [];
    const evidence = addEvidence(
      state,
      request,
      source,
      occurrence,
      fact.source === null ? "local-scope" : "module-export",
    );
    addRelationship(
      state,
      request,
      source,
      occurrence,
      evidence,
      "export",
      fact.exportedName,
      targets,
      fact.source === null,
      null,
    );
  });
  for (const [kind, facts] of [
    ["inheritance", source.facts.inheritance],
    ["implementation", source.facts.implementations],
  ] as const) {
    facts.forEach((fact, ordinal) => {
      const occurrence = addOccurrence(
        state,
        request,
        source,
        fact.id,
        fact.targetName,
        fact.range,
        "relationship",
        ordinal,
      );
      const local = targetsByName(state.nodes, fact.targetName, source.path);
      const evidence = addEvidence(
        state,
        request,
        source,
        occurrence,
        "local-scope",
      );
      addRelationship(
        state,
        request,
        source,
        occurrence,
        evidence,
        kind,
        fact.targetName,
        local,
        true,
        sourceSymbolNode(state, source, fact.sourceSymbolId),
      );
    });
  }
}
function directRelationships(
  state: Mutable,
  request: ResolveGraphRequest,
  source: DocumentResolutionSource | ProjectResolutionSource,
): void {
  source.facts.relationships.forEach((fact, ordinal) => {
    const occurrence = addOccurrence(
      state,
      request,
      source,
      fact.id,
      fact.target,
      fact.range,
      "relationship",
      ordinal,
    );
    const basis =
      source.kind === "project" ? "direct-project" : "direct-document";
    const evidence = addEvidence(state, request, source, occurrence, basis);
    const kind =
      fact.kind === "reference" && source.kind === "document"
        ? "document-link"
        : fact.kind;
    const allowedKinds: readonly MaterializedNode["kind"][] =
      kind === "dependency"
        ? ["package"]
        : kind === "resource"
          ? ["resource"]
          : kind === "document-link"
            ? ["document", "section"]
            : kind === "type-reference"
              ? ["symbol", "component"]
              : ["project", "document", "section"];
    const matching = targetsByName(
      state.nodes,
      fact.target,
      undefined,
      allowedKinds,
    );
    const sourceOccurrence = fact.sourceNodeId
      ? state.occurrences.find(
          (item) =>
            item.sourceFactId === fact.sourceNodeId &&
            item.path === source.path,
        )
      : undefined;
    const sourceNode =
      state.nodes.find((node) => node.occurrenceId === sourceOccurrence?.id)
        ?.id ?? null;
    if (matching.length) {
      addRelationship(
        state,
        request,
        source,
        occurrence,
        evidence,
        kind,
        fact.target,
        matching,
        true,
        sourceNode,
      );
      return;
    }
    const targetOccurrence = addOccurrence(
      state,
      request,
      source,
      `${fact.id}:target`,
      fact.target,
      fact.range,
      "declaration",
      ordinal,
    );
    const targetKind =
      fact.kind === "dependency"
        ? "package"
        : fact.kind === "resource"
          ? "resource"
          : "external";
    const targetNode = addNode(
      state,
      request,
      source,
      targetOccurrence,
      targetKind,
      fact.target,
      null,
    );
    addRelationship(
      state,
      request,
      source,
      occurrence,
      evidence,
      kind,
      fact.target,
      [targetNode.id],
      true,
      sourceNode,
    );
  });
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>))
      deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
export function materializeResolutionInput(
  request: ResolveGraphRequest,
): GraphMaterializationInput {
  request = parseResolveGraphRequest(request);
  RepositoryIdSchema.parse(request.repositoryId);
  RevisionIdSchema.parse(request.revisionId);
  Sha256Schema.parse(request.environmentFingerprint);
  Sha256Schema.parse(request.resolverFingerprint);
  const paths = new Set<string>();
  for (const source of request.sources) {
    RepositoryRelativePathSchema.parse(source.path);
    if (paths.has(source.path))
      throw new TypeError(`Duplicate resolution source path: ${source.path}`);
    paths.add(source.path);
  }
  const sources = [...request.sources].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  const state: Mutable = {
    evidence: [],
    memberships: [],
    nodes: [],
    occurrences: [],
    relationships: [],
  };
  for (const source of sources) {
    if (source.kind === "code") codeDeclarations(state, request, source);
    else if (source.kind === "document")
      documentDeclarations(state, request, source);
    else projectDeclarations(state, request, source);
  }
  for (const source of sources) {
    if (source.kind !== "code") hierarchyRelationships(state, request, source);
  }
  for (const source of sources) {
    if (source.kind === "code")
      codeRelationships(state, request, source, sources);
    else directRelationships(state, request, source);
  }
  const sourceArtifacts = [...new Set(sources.map(sourceArtifact))].sort();
  const reusableCollections = {
    evidence: sorted(state.evidence),
    nodes: sorted(state.nodes),
    occurrences: sorted(state.occurrences),
    relationships: sorted(state.relationships),
    sourceArtifacts,
  };
  const collections = {
    ...reusableCollections,
    memberships: sorted(state.memberships),
  };
  const output = {
    environmentFingerprint: request.environmentFingerprint,
    ...collections,
    id: identity("graph-materialization", [
      JSON.stringify({
        environmentFingerprint: request.environmentFingerprint,
        repositoryId: request.repositoryId,
        resolverFingerprint: request.resolverFingerprint,
        sources: sources.map((source) => ({
          facts: source.facts,
          kind: source.kind,
          path: source.path,
        })),
        ...reusableCollections,
      }),
    ]),
    repositoryId: request.repositoryId,
    resolverFingerprint: request.resolverFingerprint,
    revisionId: request.revisionId,
  };
  return deepFreeze(output);
}
