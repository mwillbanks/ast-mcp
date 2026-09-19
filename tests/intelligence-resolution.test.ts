import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { sourceArtifactIdentity } from "../src/intelligence/contracts/artifacts.ts";
import type { SyntaxFacts } from "../src/intelligence/parser/types.ts";
import {
  materializeResolutionInput,
  type ResolveGraphRequest,
} from "../src/intelligence/resolution/index.ts";

const range = (startByte: number, endByte: number) => ({
  end: { column: endByte, line: 0 },
  endByte,
  endCoordinate: {
    byteOffset: endByte,
    characterOffset: endByte,
    column: endByte,
    line: 0,
    utf16Column: endByte,
    utf16Offset: endByte,
  },
  start: { column: startByte, line: 0 },
  startByte,
  startCoordinate: {
    byteOffset: startByte,
    characterOffset: startByte,
    column: startByte,
    line: 0,
    utf16Column: startByte,
    utf16Offset: startByte,
  },
});
const hash = (char: string) => char.repeat(64);
const sourceArtifact = (digest: string) =>
  createHash("sha256")
    .update(JSON.stringify(["source", digest]))
    .digest("hex");
const facts = (overrides: Partial<SyntaxFacts> = {}): SyntaxFacts => ({
  calls: [],
  diagnostics: [],
  exports: [],
  extractorFingerprint: hash("1"),
  grammarFingerprint: hash("2"),
  implementations: [],
  imports: [],
  inheritance: [],
  languageId: "typescript",
  nodes: [
    {
      childIds: [],
      id: hash("3"),
      kind: "program",
      named: true,
      parentId: null,
      range: range(0, 10),
    },
  ],
  parserFingerprint: hash("4"),
  partial: false,
  references: [],
  rootNodeId: hash("3"),
  schemaVersion: "ast-mcp.syntax-facts.v1",
  sourceArtifactId: sourceArtifact(hash("6")),
  sourceDigest: hash("6"),
  symbols: [],
  syntaxFactsArtifactId: hash("7"),
  ...overrides,
});
const symbol = (id: string, name: string, start: number) => ({
  declarationRange: range(start, start + name.length),
  exported: true,
  id,
  kind: "function" as const,
  name,
  qualifiedName: name,
  range: range(start, start + name.length),
});
const fixture = JSON.parse(
  await readFile(
    new URL(
      "./fixtures/intelligence/graph/resolution/corpus.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const base = { ...fixture, sources: [] } satisfies ResolveGraphRequest;

describe("deterministic resolution materialization", () => {
  test("preserves duplicate names, overloads, occurrences, and observations", () => {
    const output = materializeResolutionInput({
      ...base,
      sources: [
        {
          facts: facts({
            calls: [
              {
                callee: "run",
                enclosingSymbolId: null,
                id: hash("c"),
                range: range(20, 23),
              },
              {
                callee: "run",
                enclosingSymbolId: null,
                id: hash("d"),
                range: range(24, 27),
              },
            ],
            references: [
              {
                enclosingSymbolId: null,
                id: hash("e"),
                name: "run",
                range: range(28, 31),
                role: "read",
              },
            ],
            symbols: [
              symbol(hash("8"), "run", 0),
              symbol(hash("9"), "run", 10),
            ],
          }),
          kind: "code",
          path: "src/a.ts",
        },
      ],
    });
    expect(output.nodes.filter(({ name }) => name === "run")).toHaveLength(2);
    expect(
      output.occurrences.filter(({ name }) => name === "run"),
    ).toHaveLength(5);
    expect(
      output.relationships.filter(({ kind }) => kind === "call"),
    ).toHaveLength(2);
    expect(
      output.relationships
        .filter(({ kind }) => kind === "call")
        .every(({ status }) => status === "ambiguous"),
    ).toBe(true);
    expect(
      output.relationships.find(({ kind }) => kind === "reference")?.status,
    ).toBe("ambiguous");
    expect(new Set(output.evidence.map(({ id }) => id)).size).toBe(
      output.evidence.length,
    );
  });
  test("resolves exact module exports and keeps unresolved evidence explicit", () => {
    const output = materializeResolutionInput({
      ...base,
      sources: [
        {
          facts: facts({
            imports: [
              {
                id: hash("a"),
                importedName: "value",
                localName: "value",
                range: range(0, 5),
                source: "./b",
                typeOnly: false,
              },
              {
                id: hash("b"),
                importedName: "missing",
                localName: "missing",
                range: range(6, 13),
                source: "./none",
                typeOnly: false,
              },
            ],
          }),
          kind: "code",
          path: "src/a.ts",
        },
        {
          facts: facts({
            exports: [
              {
                exportedName: "value",
                id: hash("c"),
                localName: "value",
                range: range(8, 13),
                source: null,
                typeOnly: false,
              },
            ],
            sourceArtifactId: sourceArtifact(hash("6")),
            symbols: [symbol(hash("e"), "value", 0)],
          }),
          kind: "code",
          path: "src/b.ts",
        },
      ],
    });
    const imports = output.relationships.filter(
      ({ kind }) => kind === "import",
    );
    expect(imports.map(({ status }) => status).sort()).toEqual([
      "resolved",
      "unresolved",
    ]);
    expect(
      imports.find(({ status }) => status === "resolved")?.targetNodeIds,
    ).toHaveLength(1);
  });
  test("resolves local inheritance and implementation evidence", () => {
    const output = materializeResolutionInput({
      ...base,
      sources: [
        {
          facts: facts({
            implementations: [
              {
                id: hash("d"),
                range: range(30, 38),
                sourceSymbolId: hash("c"),
                targetName: "Contract",
              },
            ],
            inheritance: [
              {
                id: hash("e"),
                range: range(20, 24),
                sourceSymbolId: hash("c"),
                targetName: "Base",
              },
            ],
            symbols: [
              symbol(hash("a"), "Base", 0),
              symbol(hash("b"), "Contract", 5),
              symbol(hash("c"), "Child", 14),
            ],
          }),
          kind: "code",
          path: "src/types.ts",
        },
      ],
    });
    const relationships = output.relationships.filter(
      ({ kind }) => kind === "inheritance" || kind === "implementation",
    );
    expect(relationships.map(({ status }) => status)).toEqual([
      "resolved",
      "resolved",
    ]);
    expect(
      relationships.every(({ sourceNodeId }) => sourceNodeId !== null),
    ).toBe(true);
  });

  test("materializes document and project direct evidence with memberships", () => {
    const output = materializeResolutionInput({
      ...base,
      sources: [
        {
          facts: {
            artifactId: sourceArtifact(hash("d")),
            nodes: [
              {
                id: hash("b"),
                name: "Guide",
                nodeKind: "document",
                parentId: null,
                range: range(0, 5),
              },
              {
                id: hash("8"),
                name: "API",
                nodeKind: "section",
                parentId: hash("b"),
                range: range(11, 14),
              },
            ],
            relationships: [
              {
                id: hash("c"),
                kind: "reference",
                range: range(6, 10),
                sourceNodeId: hash("b"),
                target: "API",
              },
            ],
            sourceDigest: hash("d"),
          },
          kind: "document",
          path: "docs/guide.md",
        },
        {
          facts: {
            diagnostics: [],
            format: "dotnet-project",
            nodes: [
              {
                attributes: {},
                childIds: [],
                id: hash("e"),
                kind: "project",
                name: "App",
                parentId: null,
                range: range(0, 3),
              },
            ],
            parserFingerprint: hash("f"),
            partial: false,
            relationships: [
              {
                id: hash("1"),
                kind: "dependency",
                range: range(4, 7),
                sourceNodeId: hash("e"),
                target: "Pkg",
              },
            ],
            rewriteSupported: false,
            schemaVersion: "ast-mcp.project-facts.v1",
            sourceArtifactId: sourceArtifact(hash("3")),
            sourceByteLength: 8,
            sourceDigest: hash("3"),
            syntaxFactsArtifactId: hash("4"),
          },
          kind: "project",
          path: "app.csproj",
        },
      ],
    });
    expect(output.nodes.map(({ name }) => name)).toEqual(
      expect.arrayContaining(["Guide", "API", "App", "Pkg"]),
    );
    expect(
      output.relationships.filter(({ status }) => status === "resolved"),
    ).toHaveLength(3);
    expect(output.memberships).toHaveLength(
      output.nodes.length +
        output.occurrences.length +
        output.relationships.length +
        output.evidence.length,
    );
    expect(Object.isFrozen(output.relationships[0]?.targetNodeIds)).toBe(true);
  });
  test("is deterministic across source order and environment-sensitive", () => {
    const sources: ResolveGraphRequest["sources"] = [
      {
        facts: facts({ symbols: [symbol(hash("8"), "x", 0)] }),
        kind: "code",
        path: "z.ts",
      },
      {
        facts: facts({
          sourceArtifactId: sourceArtifact(hash("6")),
          symbols: [symbol(hash("a"), "y", 0)],
        }),
        kind: "code",
        path: "a.ts",
      },
    ];
    const first = materializeResolutionInput({ ...base, sources });
    const reordered = materializeResolutionInput({
      ...base,
      sources: [...sources].reverse(),
    });
    const environmentChanged = materializeResolutionInput({
      ...base,
      environmentFingerprint: hash("c"),
      sources,
    });
    expect(first).toEqual(reordered);
    expect(first.id).toBe(reordered.id);
    expect(first.id).not.toBe(environmentChanged.id);
  });
  test("rejects invalid identities, paths, and duplicate source paths", () => {
    expect(() =>
      materializeResolutionInput({ ...base, repositoryId: "bad" }),
    ).toThrow();
    expect(() =>
      materializeResolutionInput({
        ...base,
        sources: [{ facts: facts(), kind: "code", path: "../bad.ts" }],
      }),
    ).toThrow();
    expect(() =>
      materializeResolutionInput({
        ...base,
        sources: [
          { facts: facts(), kind: "code", path: "same.ts" },
          {
            facts: facts({ sourceArtifactId: sourceArtifact(hash("6")) }),
            kind: "code",
            path: "same.ts",
          },
        ],
      }),
    ).toThrow("Duplicate resolution source path");
  });

  test("accepts WP05 artifact identities and freezes nested output", () => {
    const output = materializeResolutionInput({
      ...base,
      sources: [
        {
          facts: facts({
            sourceArtifactId: sourceArtifactIdentity({
              contentDigest: hash("6"),
            }),
            symbols: [symbol(hash("c"), "value", 0)],
            syntaxFactsArtifactId: `syntax-facts:v1:${hash("b")}`,
          }),
          kind: "code",
          path: "src/value.ts",
        },
      ],
    });
    expect(output.sourceArtifacts).toEqual([
      sourceArtifactIdentity({ contentDigest: hash("6") }),
    ]);
    expect(Object.isFrozen(output)).toBe(true);
    expect(Object.isFrozen(output.nodes)).toBe(true);
    expect(Object.isFrozen(output.nodes[0]?.range)).toBe(true);
  });

  test("uses lexical declaration ranges for shadowing and preserves overload ambiguity", () => {
    const outer = {
      ...symbol(hash("a"), "value", 0),
      kind: "variable" as const,
      qualifiedName: "Scope.value",
    };
    const inner = {
      ...symbol(hash("b"), "value", 10),
      kind: "variable" as const,
      qualifiedName: "Scope.value",
    };
    const enclosing = {
      ...symbol(hash("d"), "run", 15),
      qualifiedName: "Scope.run",
    };
    const output = materializeResolutionInput({
      ...base,
      sources: [
        {
          facts: facts({
            references: [
              {
                enclosingSymbolId: hash("d"),
                id: hash("c"),
                name: "value",
                range: range(20, 25),
                role: "read",
              },
            ],
            symbols: [outer, inner, enclosing],
          }),
          kind: "code",
          path: "src/scope.ts",
        },
      ],
    });
    const relationship = output.relationships.find(
      ({ kind }) => kind === "reference",
    );
    expect(relationship?.status).toBe("resolved");
    expect(relationship?.targetNodeIds).toHaveLength(1);
    const target = output.nodes.find(
      ({ id }) => id === relationship?.targetNodeIds[0],
    );
    expect(target?.range.startByte).toBe(10);
  });

  test("resolves explicit and directory-index modules and bounds traversal", () => {
    const imported = (id: string, source: string, start: number) => ({
      id,
      importedName: "value",
      localName: "value",
      range: range(start, start + 5),
      source,
      typeOnly: false,
    });
    const output = materializeResolutionInput({
      ...base,
      sources: [
        {
          facts: facts({
            imports: [
              imported(hash("a"), "./lib/index.ts", 0),
              imported(hash("b"), "./lib", 6),
              imported(hash("c"), "../../../outside", 12),
            ],
          }),
          kind: "code",
          path: "src/main.ts",
        },
        {
          facts: facts({
            exports: [
              {
                exportedName: "value",
                id: hash("d"),
                localName: "value",
                range: range(6, 11),
                source: null,
                typeOnly: false,
              },
            ],
            sourceArtifactId: sourceArtifact(hash("6")),
            symbols: [symbol(hash("f"), "value", 0)],
          }),
          kind: "code",
          path: "src/lib/index.ts",
        },
      ],
    });
    expect(
      output.relationships
        .filter(({ kind }) => kind === "import")
        .map(({ status }) => status)
        .sort(),
    ).toEqual(["resolved", "resolved", "unresolved"]);
  });

  test("resolves bare package imports only to package declarations", () => {
    const output = materializeResolutionInput({
      ...base,
      sources: [
        {
          facts: facts({
            imports: [
              {
                id: hash("a"),
                importedName: "default",
                localName: "pkg",
                range: range(0, 3),
                source: "pkg",
                typeOnly: false,
              },
            ],
          }),
          kind: "code",
          path: "src/main.ts",
        },
        {
          facts: {
            artifactId: sourceArtifact(hash("d")),
            nodes: [
              {
                id: hash("c"),
                name: "pkg",
                nodeKind: "package",
                parentId: null,
                range: range(0, 3),
              },
            ],
            relationships: [],
            sourceDigest: hash("d"),
          },
          kind: "document",
          path: "packages/catalog.md",
        },
      ],
    });
    const imported = output.relationships.find(({ kind }) => kind === "import");
    expect(imported?.status).toBe("resolved");
    expect(imported?.targetNodeIds).toHaveLength(1);
  });

  test("materializes nested document and project containment after child-first declarations", () => {
    const documentDigest = hash("a");
    const projectDigest = hash("d");
    const output = materializeResolutionInput({
      ...base,
      sources: [
        {
          facts: {
            artifactId: sourceArtifact(documentDigest),
            nodes: [
              {
                id: hash("b"),
                name: "Same",
                parentId: hash("c"),
                range: range(0, 4),
              },
              {
                id: hash("c"),
                name: "Same",
                parentId: null,
                range: range(10, 14),
              },
            ],
            relationships: [],
            sourceDigest: documentDigest,
          },
          kind: "document",
          path: "docs/nested.md",
        },
        {
          facts: {
            diagnostics: [],
            format: "dotnet-project",
            nodes: [
              {
                attributes: {},
                childIds: [],
                id: hash("e"),
                kind: "component",
                name: "Same",
                parentId: hash("f"),
                range: range(0, 4),
              },
              {
                attributes: {},
                childIds: [hash("e")],
                id: hash("f"),
                kind: "project",
                name: "Same",
                parentId: null,
                range: range(10, 14),
              },
            ],
            parserFingerprint: hash("1"),
            partial: false,
            relationships: [],
            rewriteSupported: false,
            schemaVersion: "ast-mcp.project-facts.v1",
            sourceArtifactId: sourceArtifact(projectDigest),
            sourceByteLength: 14,
            sourceDigest: projectDigest,
            syntaxFactsArtifactId: hash("2"),
          },
          kind: "project",
          path: "nested.csproj",
        },
      ],
    });
    const children = output.nodes.filter(({ range }) => range.startByte === 0);
    expect(children).toHaveLength(2);
    for (const child of children) {
      const parent = output.nodes.find(({ id }) => id === child.parentNodeId);
      expect(parent?.name).toBe("Same");
      expect(parent?.range.startByte).toBe(10);
    }
    const containment = output.relationships.filter(
      ({ kind }) => kind === "containment",
    );
    expect(containment).toHaveLength(2);
    expect(
      containment.every(
        ({ evidenceIds, sourceNodeId, status, targetNodeIds }) =>
          evidenceIds.length === 1 &&
          sourceNodeId !== null &&
          status === "resolved" &&
          targetNodeIds.length === 1,
      ),
    ).toBe(true);
    expect(
      output.memberships.filter(
        ({ entityKind }) => entityKind === "relationship",
      ),
    ).toHaveLength(output.relationships.length);
  });

  test("rejects cyclic document hierarchies", () => {
    const digest = hash("a");
    expect(() =>
      materializeResolutionInput({
        ...base,
        sources: [
          {
            facts: {
              artifactId: sourceArtifact(digest),
              nodes: [
                {
                  id: hash("b"),
                  name: "A",
                  parentId: hash("c"),
                  range: range(0, 1),
                },
                {
                  id: hash("c"),
                  name: "B",
                  parentId: hash("b"),
                  range: range(2, 3),
                },
              ],
              relationships: [],
              sourceDigest: digest,
            },
            kind: "document",
            path: "docs/cycle.md",
          },
        ],
      }),
    ).toThrow("Cyclic document hierarchy");
  });

  test("rejects nonreciprocal project parent and child links", () => {
    const digest = hash("a");
    const project = {
      diagnostics: [],
      format: "dotnet-project" as const,
      nodes: [
        {
          attributes: {},
          childIds: [],
          id: hash("b"),
          kind: "project" as const,
          name: "Parent",
          parentId: null,
          range: range(0, 1),
        },
        {
          attributes: {},
          childIds: [],
          id: hash("c"),
          kind: "component" as const,
          name: "Child",
          parentId: hash("b"),
          range: range(2, 3),
        },
      ],
      parserFingerprint: hash("d"),
      partial: false,
      relationships: [],
      rewriteSupported: false as const,
      schemaVersion: "ast-mcp.project-facts.v1" as const,
      sourceArtifactId: sourceArtifact(digest),
      sourceByteLength: 3,
      sourceDigest: digest,
      syntaxFactsArtifactId: hash("e"),
    };
    expect(() =>
      materializeResolutionInput({
        ...base,
        sources: [{ facts: project, kind: "project", path: "bad.csproj" }],
      }),
    ).toThrow("Nonreciprocal project parent");
    const reverseMismatch = {
      ...structuredClone(project),
      nodes: [
        { ...project.nodes[0], childIds: [hash("c")] },
        { ...project.nodes[1], parentId: null },
      ],
    };
    expect(() =>
      materializeResolutionInput({
        ...base,
        sources: [
          { facts: reverseMismatch, kind: "project", path: "bad.csproj" },
        ],
      }),
    ).toThrow("Nonreciprocal project child");
  });

  test("binds document and project artifacts to source digests", () => {
    expect(() =>
      materializeResolutionInput({
        ...base,
        sources: [
          {
            facts: {
              artifactId: hash("a"),
              nodes: [],
              relationships: [],
              sourceDigest: hash("b"),
            },
            kind: "document",
            path: "bad.md",
          },
        ],
      }),
    ).toThrow("Invalid document facts");
    expect(() =>
      materializeResolutionInput({
        ...base,
        sources: [
          {
            facts: {
              diagnostics: [],
              format: "dotnet-project",
              nodes: [],
              parserFingerprint: hash("c"),
              partial: false,
              relationships: [],
              rewriteSupported: false,
              schemaVersion: "ast-mcp.project-facts.v1",
              sourceArtifactId: hash("d"),
              sourceByteLength: 0,
              sourceDigest: hash("e"),
              syntaxFactsArtifactId: hash("f"),
            },
            kind: "project",
            path: "bad.csproj",
          },
        ],
      }),
    ).toThrow("Invalid project facts");
  });

  test("includes content-significant source metadata in materialization identity", () => {
    const build = (digest: string) =>
      materializeResolutionInput({
        ...base,
        sources: [
          {
            facts: {
              artifactId: sourceArtifact(digest),
              nodes: [],
              relationships: [],
              sourceDigest: digest,
            },
            kind: "document",
            path: "empty.md",
          },
        ],
      });
    expect(build(hash("a")).nodes).toEqual(build(hash("b")).nodes);
    expect(build(hash("a")).id).not.toBe(build(hash("b")).id);
  });

  test("rejects unrelated code artifacts and nonreciprocal syntax links", () => {
    const invalid = facts({
      nodes: [
        {
          childIds: [],
          id: hash("3"),
          kind: "program",
          named: true,
          parentId: null,
          range: range(0, 10),
        },
        {
          childIds: [],
          id: hash("a"),
          kind: "identifier",
          named: true,
          parentId: hash("3"),
          range: range(1, 2),
        },
      ],
      sourceArtifactId: hash("f"),
    });
    expect(() =>
      materializeResolutionInput({
        ...base,
        sources: [{ facts: invalid, kind: "code", path: "bad.ts" }],
      }),
    ).toThrow("Invalid code artifact identity");
    invalid.sourceArtifactId = sourceArtifact(invalid.sourceDigest);
    expect(() =>
      materializeResolutionInput({
        ...base,
        sources: [{ facts: invalid, kind: "code", path: "bad.ts" }],
      }),
    ).toThrow("Nonreciprocal syntax parent");
  });

  test("rejects cyclic and root-unreachable syntax hierarchies", () => {
    const cyclic = facts({
      nodes: [
        {
          childIds: [],
          id: hash("3"),
          kind: "program",
          named: true,
          parentId: null,
          range: range(0, 10),
        },
        {
          childIds: [hash("b")],
          id: hash("a"),
          kind: "block",
          named: true,
          parentId: hash("b"),
          range: range(1, 4),
        },
        {
          childIds: [hash("a")],
          id: hash("b"),
          kind: "block",
          named: true,
          parentId: hash("a"),
          range: range(5, 8),
        },
      ],
    });
    expect(() =>
      materializeResolutionInput({
        ...base,
        sources: [{ facts: cyclic, kind: "code", path: "cycle.ts" }],
      }),
    ).toThrow("Cyclic syntax hierarchy");
  });

  test("rejects exact-key, range, link, pointer, and identity tampering", () => {
    const source = {
      facts: facts({ symbols: [symbol(hash("a"), "x", 0)] }),
      kind: "code" as const,
      path: "x.ts",
    };
    expect(() =>
      materializeResolutionInput({
        ...base,
        extra: true,
        sources: [],
      } as never),
    ).toThrow();
    expect(() =>
      materializeResolutionInput({
        ...base,
        sources: [{ ...source, extra: true } as never],
      }),
    ).toThrow();
    const badRange = structuredClone(source);
    const badSymbol = badRange.facts.symbols[0];
    if (!badSymbol) throw new Error("fixture symbol missing");
    badSymbol.range.endByte = -1;
    expect(() =>
      materializeResolutionInput({ ...base, sources: [badRange] }),
    ).toThrow();
    const dangling = structuredClone(source);
    const root = dangling.facts.nodes[0];
    if (!root) throw new Error("fixture root missing");
    root.parentId = hash("f");
    expect(() =>
      materializeResolutionInput({ ...base, sources: [dangling] }),
    ).toThrow();
    const pointer = structuredClone(source);
    pointer.facts.references = [
      {
        enclosingSymbolId: hash("f"),
        id: hash("b"),
        name: "x",
        range: range(5, 6),
        role: "read",
      },
    ];
    expect(() =>
      materializeResolutionInput({ ...base, sources: [pointer] }),
    ).toThrow();
    const duplicate = structuredClone(source);
    duplicate.facts.references = [
      {
        enclosingSymbolId: null,
        id: hash("a"),
        name: "x",
        range: range(5, 6),
        role: "read",
      },
    ];
    expect(() =>
      materializeResolutionInput({ ...base, sources: [duplicate] }),
    ).toThrow();
  });
});
