import { describe, expect, test } from "bun:test";

import {
  AbsolutePathSchema,
  assertReaderPinsGeneration,
  CapabilityClaimSchema,
  ChunkArtifactInputSchema,
  COMPLETE_GENERATION_TABLES,
  canonicalIdentityPayload,
  canonicalStoragePlacement,
  chunkArtifactIdentity,
  compareRepositoryPaths,
  createIdentity,
  createJobIdempotencyKey,
  createPublicationGenerationId,
  createRepositoryId,
  createRevisionId,
  createStorageDomainId,
  createWorkspaceId,
  DirtyOverlayArtifactInputSchema,
  dirtyOverlayArtifactIdentity,
  EvidenceRangeSchema,
  embeddingArtifactIdentity,
  FreshnessSchema,
  GraphNodeKindSchema,
  GraphNodeSchema,
  GraphRelationshipSchema,
  graphEdgeIdentity,
  graphEvidenceIdentity,
  graphNodeIdentity,
  graphOccurrenceIdentity,
  INTELLIGENCE_SCHEMA_VERSION,
  IntelligenceErrorSchema,
  IntelligenceResultSchema,
  LanguageCapabilitySchema,
  PaginationSchema,
  PublicationGenerationSchema,
  ReaderPinSchema,
  RepositoryRelativePathSchema,
  ResolutionStatusSchema,
  ResolvedRevisionSchema,
  ResultScopeSchema,
  RevisionManifestArtifactInputSchema,
  RevisionMembershipSchema,
  resolvedRelationshipsArtifactIdentity,
  revisionManifestArtifactIdentity,
  revisionMembershipIdentity,
  Sha256Schema,
  StorageDomainSchema,
  StoragePlacementSchema,
  sourceArtifactIdentity,
  syntaxFactsArtifactIdentity,
  TruncationBudgetSchema,
  WorkspaceContextSchema,
} from "../src/intelligence/contracts/index.ts";

const digest = (value: string) =>
  value
    .padEnd(64, value)
    .slice(0, 64)
    .replace(/[^a-f0-9]/g, "a");
const identity = (namespace: string, value: string) =>
  createIdentity(namespace, { value });
const now = "2026-09-10T12:00:00.000Z";
const later = "2026-09-10T12:05:00.000Z";

test("path contracts recognize portable absolute path forms", () => {
  for (const absolute of [
    "/var/lib/ast-mcp",
    "C:\\workspace\\source.ts",
    "\\\\server\\share\\source.ts",
    "\\\\?\\C:\\workspace\\source.ts",
  ]) {
    expect(AbsolutePathSchema.parse(absolute)).toBe(absolute);
    expect(() => RepositoryRelativePathSchema.parse(absolute)).toThrow(
      /relative/i,
    );
  }
  expect(RepositoryRelativePathSchema.parse("src/source.ts")).toBe(
    "src/source.ts",
  );
});

const range = {
  end: { column: 9, line: 0 },
  endByte: 9,
  start: { column: 2, line: 0 },
  startByte: 2,
};

function storageDomain() {
  const coordinates = {
    engine: "lancedb" as const,
    placement: { kind: "global" as const },
    pool: "shared" as const,
    storagePath: "/var/lib/ast-mcp",
  };
  return {
    ...coordinates,
    domainId: createStorageDomainId(coordinates),
    schemaVersion: INTELLIGENCE_SCHEMA_VERSION,
  };
}

describe("workspace and revision contracts", () => {
  test("makes identity helpers deterministic and key-order independent", () => {
    const left = createIdentity("example", { a: 1, b: 2 });
    const right = createIdentity(
      "example",
      Object.fromEntries([
        ["b", 2],
        ["a", 1],
      ]),
    );
    expect(left).toBe(right);
    expect(Sha256Schema.safeParse(left).success).toBe(false);

    const repositoryId = createRepositoryId({
      canonicalGitCommonDirectory: "/repo/.git",
    });
    const revisionId = createRevisionId({
      repositoryId,
      resolvedCommitOid: null,
      selector: { kind: "working" },
    });
    expect(
      createWorkspaceId({
        canonicalCheckoutRoot: "/repo",
        configurationGeneration: 4,
        dirtyOverlayId: null,
        repositoryId,
        revisionId,
        storageDomainId: storageDomain().domainId,
      }),
    ).toBe(
      createWorkspaceId({
        canonicalCheckoutRoot: "/repo",
        configurationGeneration: 4,
        dirtyOverlayId: null,
        repositoryId,
        revisionId,
        storageDomainId: storageDomain().domainId,
      }),
    );
  });

  test("accepts working writes and rejects historical writes or overlays", () => {
    const repositoryId = createRepositoryId({
      canonicalGitCommonDirectory: "/repo/.git",
    });
    const revisionId = createRevisionId({
      repositoryId,
      resolvedCommitOid: null,
      selector: { kind: "working" },
    });
    const valid = {
      canonicalRootAnchor: "/repo-worktree",
      checkoutRoot: "/repo-worktree",
      configurationGeneration: 7,
      dirtyOverlayId: identity("dirty-overlay", "current"),
      repositoryId,
      repositoryRoot: "/repo",
      schemaVersion: INTELLIGENCE_SCHEMA_VERSION,
      selectedRevision: {
        readOnly: false,
        resolvedCommitOid: null,
        revisionId,
        selector: { kind: "working" as const },
      },
      storageDomain: storageDomain(),
      workspaceId: createWorkspaceId({
        canonicalCheckoutRoot: "/repo-worktree",
        configurationGeneration: 7,
        dirtyOverlayId: identity("dirty-overlay", "current"),
        repositoryId,
        revisionId,
        storageDomainId: storageDomain().domainId,
      }),
      writeEligibility: { eligible: true as const },
    };
    expect(WorkspaceContextSchema.parse(valid).writeEligibility.eligible).toBe(
      true,
    );
    expect(() =>
      WorkspaceContextSchema.parse({
        ...valid,
        selectedRevision: {
          ...valid.selectedRevision,
          revisionId: identity("revision", "forged"),
        },
      }),
    ).toThrow(/selected revision identity/i);
    expect(() =>
      WorkspaceContextSchema.parse({
        ...valid,
        workspaceId: identity("workspace", "forged"),
      }),
    ).toThrow(/workspace identity/i);

    expect(() =>
      WorkspaceContextSchema.parse({
        ...valid,
        selectedRevision: {
          readOnly: true,
          resolvedCommitOid: "a".repeat(40),
          revisionId: identity("revision", "commit"),
          selector: { kind: "commit", oid: "a".repeat(40) },
        },
        writeEligibility: { eligible: true },
      }),
    ).toThrow(/historical revision cannot be write eligible/i);

    expect(() =>
      WorkspaceContextSchema.parse({
        ...valid,
        dirtyOverlayId: identity("dirty-overlay", "invalid"),
        selectedRevision: {
          readOnly: true,
          resolvedCommitOid: "b".repeat(40),
          revisionId: identity("revision", "branch"),
          selector: { kind: "branch", name: "feature" },
        },
        writeEligibility: {
          eligible: false,
          reason: "historical-revision",
        },
      }),
    ).toThrow(/dirty overlays only belong/i);
  });
});

describe("content-addressed artifact contracts", () => {
  test("separates syntax facts from environment-dependent resolution", () => {
    const source = sourceArtifactIdentity({ contentDigest: digest("a") });
    const syntax = syntaxFactsArtifactIdentity({
      languageId: "typescript",
      parserFingerprint: digest("b"),
      sourceArtifactId: source,
    });
    const first = resolvedRelationshipsArtifactIdentity({
      environmentFingerprint: digest("c"),
      resolverFingerprint: digest("d"),
      syntaxFactsArtifactId: syntax,
    });
    const second = resolvedRelationshipsArtifactIdentity({
      environmentFingerprint: digest("e"),
      resolverFingerprint: digest("d"),
      syntaxFactsArtifactId: syntax,
    });
    expect(first).not.toBe(second);
    expect(
      syntaxFactsArtifactIdentity({
        languageId: "typescript",
        parserFingerprint: digest("b"),
        sourceArtifactId: source,
      }),
    ).toBe(syntax);
  });

  test("canonicalizes manifest and overlay entry order", () => {
    const source = sourceArtifactIdentity({ contentDigest: digest("1") });
    const syntax = syntaxFactsArtifactIdentity({
      languageId: "typescript",
      parserFingerprint: digest("2"),
      sourceArtifactId: source,
    });
    const manifest = {
      dirtyOverlayId: null,
      entries: [
        {
          path: "b.ts",
          resolvedRelationshipsArtifactId: null,
          sourceArtifactId: source,
          syntaxFactsArtifactId: syntax,
        },
        {
          path: "a.ts",
          resolvedRelationshipsArtifactId: null,
          sourceArtifactId: source,
          syntaxFactsArtifactId: syntax,
        },
      ],
      repositoryId: identity("repository", "repo"),
      revisionId: identity("revision", "rev"),
    };
    RevisionManifestArtifactInputSchema.parse(manifest);
    expect(revisionManifestArtifactIdentity(manifest)).toBe(
      revisionManifestArtifactIdentity({
        ...manifest,
        entries: [...manifest.entries].reverse(),
      }),
    );

    const overlay = {
      baseRevisionId: manifest.revisionId,
      checkoutRoot: "/repo-worktree",
      entries: [
        { contentDigest: null, path: "z.ts", status: "deleted" as const },
        {
          contentDigest: digest("3"),
          path: "a.ts",
          status: "modified" as const,
        },
      ],
      repositoryId: manifest.repositoryId,
    };
    expect(dirtyOverlayArtifactIdentity(overlay)).toBe(
      dirtyOverlayArtifactIdentity({
        ...overlay,
        entries: [...overlay.entries].reverse(),
      }),
    );
    expect(() =>
      dirtyOverlayArtifactIdentity({
        ...overlay,
        entries: [
          { contentDigest: digest("4"), path: "deleted.ts", status: "deleted" },
        ],
      }),
    ).toThrow(/cannot have content/i);
  });

  test("validates chunk reuse boundaries", () => {
    const source = sourceArtifactIdentity({ contentDigest: digest("5") });
    expect(
      ChunkArtifactInputSchema.safeParse({
        chunkerFingerprint: digest("6"),
        documentKind: "markdown",
        extractedContentDigest: digest("7"),
        semanticContextDigest: digest("8"),
        sourceArtifactId: source,
      }).success,
    ).toBe(true);
    expect(
      ChunkArtifactInputSchema.safeParse({
        chunkerFingerprint: digest("6"),
        documentKind: "code",
        extractedContentDigest: digest("7"),
        semanticContextDigest: digest("8"),
        sourceArtifactId: source,
      }).success,
    ).toBe(false);
    expect(() =>
      syntaxFactsArtifactIdentity({
        languageId: "typescript",
        parserFingerprint: digest("9"),
        sourceArtifactId: identity("embedding", "wrong-source"),
      }),
    ).toThrow(/source namespace/i);
    expect(() =>
      chunkArtifactIdentity({
        chunkerFingerprint: digest("a"),
        documentKind: "code",
        extractedContentDigest: digest("b"),
        semanticContextDigest: digest("c"),
        syntaxFactsArtifactId: source,
      }),
    ).toThrow(/syntax-facts namespace/i);
    expect(() =>
      embeddingArtifactIdentity({
        chunkArtifactId: source,
        dimensions: 384,
        dtype: "float32",
        exactInputDigest: digest("d"),
        modelId: "model",
        modelRevision: "revision",
        normalized: true,
        pooling: "mean",
        tokenizerId: "tokenizer",
        tokenizerRevision: "revision",
      }),
    ).toThrow(/chunks namespace/i);
  });
});

describe("LanceDB publication contracts", () => {
  const tableVersions = COMPLETE_GENERATION_TABLES.map((table, index) => ({
    table,
    version: index + 1,
  }));
  const coordinates = {
    manifestArtifactId: identity("revision-manifest", "m1"),
    revisionId: identity("revision", "r1"),
    storageDomainId: storageDomain().domainId,
    tableVersions,
    workspaceId: identity("workspace", "w1"),
  };
  const generationId = createPublicationGenerationId(coordinates);
  const publication = {
    ...coordinates,
    generationId,
    immutable: true as const,
    publishedAt: now,
    schemaVersion: INTELLIGENCE_SCHEMA_VERSION,
    state: "published" as const,
  };

  test("accepts canonical storage placement values", () => {
    expect(StorageDomainSchema.parse(storageDomain()).engine).toBe("lancedb");
    expect(() =>
      StorageDomainSchema.parse({
        ...storageDomain(),
        domainId: identity("storage-domain", "forged"),
      }),
    ).toThrow(/storage domain identity/i);
    expect(canonicalStoragePlacement({ kind: "global" })).toBe("global");
    expect(canonicalStoragePlacement({ kind: "local" })).toBe("local");
    expect(canonicalStoragePlacement({ kind: "parent", levels: 2 })).toBe(
      "parent:2",
    );
    expect(
      canonicalStoragePlacement({ kind: "explicit", path: "/data/index" }),
    ).toBe("explicit:/data/index");
    expect(
      StoragePlacementSchema.safeParse({
        kind: "explicit",
        path: "relative/index",
      }).success,
    ).toBe(false);
  });

  test("rejects duplicate table versions and mixed reader generations", () => {
    expect(PublicationGenerationSchema.parse(publication).immutable).toBe(true);
    expect(
      createPublicationGenerationId({
        ...coordinates,
        tableVersions: [...tableVersions].reverse(),
      }),
    ).toBe(generationId);
    expect(() =>
      createPublicationGenerationId({
        ...coordinates,
        manifestArtifactId: identity("source", "wrong-manifest"),
      }),
    ).toThrow(/revision-manifest namespace/i);
    expect(() =>
      createPublicationGenerationId({
        ...coordinates,
        storageDomainId: identity("workspace", "wrong-storage"),
      }),
    ).toThrow(/storage-domain namespace/i);
    expect(() =>
      PublicationGenerationSchema.parse({
        ...publication,
        tableVersions: [
          { table: "artifacts", version: 1 },
          { table: "artifacts", version: 2 },
        ],
      }),
    ).toThrow(/every required table/i);

    const pin = ReaderPinSchema.parse({
      createdAt: now,
      expiresAt: later,
      ...coordinates,
      generationId,
      pinId: identity("reader-pin", "p1"),
      readerId: "agent-1",
      tableVersions: publication.tableVersions,
    });
    expect(() =>
      assertReaderPinsGeneration(
        PublicationGenerationSchema.parse(publication),
        {
          ...pin,
          generationId: identity("generation", "g2"),
        },
      ),
    ).toThrow();
  });

  test("produces idempotent job keys", () => {
    const input = {
      inputFingerprint: digest("9"),
      revisionId: publication.revisionId,
      storageDomainId: storageDomain().domainId,
      type: "parse" as const,
      workspaceId: publication.workspaceId,
    };
    expect(createJobIdempotencyKey(input)).toBe(createJobIdempotencyKey(input));
    expect(() =>
      createJobIdempotencyKey({
        ...input,
        workspaceId: identity("revision", "wrong-workspace"),
      }),
    ).toThrow(/workspace namespace/i);
  });
});

describe("graph and language capability contracts", () => {
  test("preserves parallel edges and independent evidence", () => {
    const source = identity("graph-node", "source");
    const target = identity("graph-node", "target");
    const common = {
      kind: "calls" as const,
      sourceNodeId: source,
      targetNodeId: target,
    };
    const staticEdge = graphEdgeIdentity({
      ...common,
      discriminator: "static-call",
    });
    const callbackEdge = graphEdgeIdentity({
      ...common,
      discriminator: "callback-registration",
    });
    expect(staticEdge).not.toBe(callbackEdge);
    expect(
      graphEdgeIdentity({
        ...common,
        discriminator: "static-call",
      }),
    ).toBe(staticEdge);

    const firstEvidence = graphEvidenceIdentity({
      edgeId: staticEdge,
      extractionMethod: "ast",
      extractionVersion: "1.0.0",
      extractorFingerprint: digest("c"),
      occurrenceId: identity("graph-occurrence", "first"),
      path: "src/a.ts",
      range: { ...range, endByte: 8, startByte: 4 },
      sourceArtifactId: identity("source", "file"),
    });
    const secondEvidence = graphEvidenceIdentity({
      edgeId: staticEdge,
      extractionMethod: "ast",
      extractionVersion: "1.0.0",
      extractorFingerprint: digest("c"),
      occurrenceId: identity("graph-occurrence", "second"),
      path: "src/a.ts",
      range: { ...range, endByte: 24, startByte: 20 },
      sourceArtifactId: identity("source", "file"),
    });
    expect(firstEvidence).not.toBe(secondEvidence);
  });

  test("requires honest capability claims", () => {
    expect(() =>
      CapabilityClaimSchema.parse({
        implementationFingerprint: digest("d"),
        limitations: [],
        provider: "ast-grep",
        status: "unsupported",
      }),
    ).toThrow(/cannot claim an implementation/i);

    const supported = {
      implementationFingerprint: digest("e"),
      limitations: [],
      provider: "tree-sitter" as const,
      status: "supported" as const,
    };
    expect(() =>
      CapabilityClaimSchema.parse({
        ...supported,
        limitations: ["Some constructs are omitted"],
      }),
    ).toThrow(/must be marked partial/i);
    const unsupported = {
      implementationFingerprint: null,
      limitations: ["No safe grammar is installed"],
      provider: "none" as const,
      status: "unsupported" as const,
    };
    expect(() =>
      LanguageCapabilitySchema.parse({
        callResolution: unsupported,
        embeddedLanguageIds: [],
        embeddedLanguages: unsupported,
        exportResolution: unsupported,
        extensions: [".example"],
        importResolution: unsupported,
        inheritanceResolution: unsupported,
        languageId: "example",
        match: unsupported,
        parse: unsupported,
        rewrite: supported,
        schemaVersion: INTELLIGENCE_SCHEMA_VERSION,
        structuralRead: supported,
        structuredParser: { mode: "none" },
        symbolExtraction: supported,
      }),
    ).toThrow(/rewrite support requires/i);
  });
});

describe("result and error contracts", () => {
  function result() {
    const workspaceId = identity("workspace", "result");
    const revisionId = identity("revision", "result");
    const generationId = identity("generation", "result");
    return {
      budget: {
        consumedBytes: 120,
        consumedItems: 1,
        maxBytes: 10_000,
        maxItems: 10,
        reason: "none" as const,
        truncated: false,
      },
      coverage: {
        evaluatedCandidates: 5,
        excludedPaths: [],
        includedPaths: ["src/a.ts"],
        languages: ["typescript"],
        requestedPaths: ["src"],
        totalCandidates: 5,
      },
      freshness: {
        indexedAt: now,
        pendingJobCount: 0,
        reason: null,
        sourceObservedAt: now,
        stale: false,
      },
      generationId,
      pagination: {
        cursor: null,
        hasMore: true,
        limit: 1,
        nextCursor: "page-2",
        returned: 1,
      },
      results: [
        {
          entityId: identity("graph-node", "one"),
          evidence: [
            {
              excerpt: "function a() {}",
              path: "src/a.ts",
              range,
              sourceArtifactId: identity("source", "a"),
            },
          ],
          generationId,
          hitId: identity("search-hit", "one"),
          rankingReasons: [
            {
              contribution: 0.95,
              explanation: "Exact canonical symbol match",
              signal: "exact-symbol" as const,
            },
          ],
          revisionId,
          score: 0.95,
          workspaceId,
        },
      ],
      revisionId,
      schemaVersion: INTELLIGENCE_SCHEMA_VERSION,
      workspaceId,
    };
  }

  test("reports evidence, coverage, freshness, ranking, pagination, and budget", () => {
    const parsed = IntelligenceResultSchema.parse(result());
    expect(parsed.results[0]?.evidence[0]?.range).toEqual(
      EvidenceRangeSchema.parse(range),
    );
    expect(parsed.pagination.hasMore).toBe(true);
    expect(parsed.budget.consumedBytes).toBe(120);
  });

  test("rejects mixed-generation result rows and malformed metadata", () => {
    const mixed = result();
    const firstHit = mixed.results[0];
    if (!firstHit) throw new Error("Expected a fixture result");
    firstHit.generationId = identity("generation", "other");
    expect(() => IntelligenceResultSchema.parse(mixed)).toThrow(
      /envelope workspace, revision, and generation/i,
    );

    expect(() =>
      IntelligenceResultSchema.parse({
        ...result(),
        pagination: {
          cursor: null,
          hasMore: true,
          limit: 1,
          nextCursor: null,
          returned: 1,
        },
      }),
    ).toThrow(/hasMore must agree/i);
    expect(() =>
      IntelligenceResultSchema.parse({
        ...result(),
        pagination: {
          cursor: null,
          hasMore: false,
          limit: 1,
          nextCursor: null,
          returned: 0,
        },
      }),
    ).toThrow(/result row count/i);
    expect(() =>
      IntelligenceResultSchema.parse({
        ...result(),
        coverage: {
          ...result().coverage,
          includedPaths: ["../outside.ts"],
        },
      }),
    ).toThrow(/repository path/i);
    const unsafeEvidence = result();
    const unsafeHit = unsafeEvidence.results[0];
    if (!unsafeHit) throw new Error("Expected a fixture result");
    unsafeHit.evidence[0] = {
      ...unsafeHit.evidence[0],
      path: "/outside.ts",
    };
    expect(() => IntelligenceResultSchema.parse(unsafeEvidence)).toThrow(
      /repository path/i,
    );
  });

  test("requires actionable typed errors", () => {
    expect(
      IntelligenceErrorSchema.parse({
        actualGenerationId: null,
        capability: null,
        code: "path_denied",
        expectedGenerationId: null,
        message: "External path is outside the repository",
        path: { kind: "external", location: "/outside/file.ts" },
        retryAfterMs: null,
        retryable: false,
        schemaVersion: INTELLIGENCE_SCHEMA_VERSION,
        selector: null,
        suggestedAction: "request-path-access",
      }).path,
    ).toEqual({ kind: "external", location: "/outside/file.ts" });
    expect(() =>
      IntelligenceErrorSchema.parse({
        actualGenerationId: null,
        capability: null,
        code: "path_denied",
        expectedGenerationId: null,
        message: "Path traversal is invalid",
        path: { kind: "repository-relative", path: "../outside.ts" },
        retryAfterMs: null,
        retryable: false,
        schemaVersion: INTELLIGENCE_SCHEMA_VERSION,
        selector: null,
        suggestedAction: "correct-request",
      }),
    ).toThrow(/repository path/i);
    expect(
      IntelligenceErrorSchema.parse({
        actualGenerationId: identity("generation", "actual"),
        capability: null,
        code: "mixed_generation",
        expectedGenerationId: identity("generation", "expected"),
        message: "Reader pin does not match publication",
        path: null,
        retryAfterMs: 25,
        retryable: true,
        schemaVersion: INTELLIGENCE_SCHEMA_VERSION,
        selector: null,
        suggestedAction: "retry",
      }).suggestedAction,
    ).toBe("retry");

    expect(() =>
      IntelligenceErrorSchema.parse({
        actualGenerationId: null,
        capability: null,
        code: "mixed_generation",
        expectedGenerationId: null,
        message: "Reader pin does not match publication",
        path: null,
        retryAfterMs: null,
        retryable: true,
        schemaVersion: INTELLIGENCE_SCHEMA_VERSION,
        selector: null,
        suggestedAction: "retry",
      }),
    ).toThrow(/require expected and actual/i);
  });
});

describe("contract invariant branches", () => {
  test("canonicalizes identity values and rejects invalid primitives", () => {
    expect(
      canonicalIdentityPayload({
        array: [null, true, false, "x", -0],
        nested: { a: 1, b: 2 },
      }),
    ).toBe('{"array":[null,true,false,"x",0],"nested":{"a":1,"b":2}}');
    expect(() => createIdentity("Bad Namespace", { value: 1 })).toThrow(
      /namespace/i,
    );
    expect(() => canonicalIdentityPayload(Number.POSITIVE_INFINITY)).toThrow(
      /finite/i,
    );
    expect(() =>
      canonicalIdentityPayload({ invalid: undefined } as never),
    ).toThrow();
    expect(() =>
      EvidenceRangeSchema.parse({
        ...range,
        end: { column: 1, line: 0 },
        endByte: 1,
      }),
    ).toThrow(/endByte|end position/);
  });

  test("enforces resolved revision invariants", () => {
    expect(() =>
      ResolvedRevisionSchema.parse({
        readOnly: true,
        resolvedCommitOid: null,
        revisionId: identity("revision", "working-read-only"),
        selector: { kind: "working" },
      }),
    ).toThrow(/working revision must remain writable/i);
    expect(() =>
      ResolvedRevisionSchema.parse({
        readOnly: true,
        resolvedCommitOid: null,
        revisionId: identity("revision", "missing-commit"),
        selector: { kind: "tag", name: "v1" },
      }),
    ).toThrow(/must resolve to a commit/i);
  });

  test("covers code, document, and embedding artifact identities", () => {
    const source = sourceArtifactIdentity({ contentDigest: digest("a") });
    const syntax = syntaxFactsArtifactIdentity({
      languageId: "typescript",
      parserFingerprint: digest("b"),
      sourceArtifactId: source,
    });
    const codeChunk = chunkArtifactIdentity({
      chunkerFingerprint: digest("c"),
      documentKind: "code",
      extractedContentDigest: digest("d"),
      semanticContextDigest: digest("e"),
      syntaxFactsArtifactId: syntax,
    });
    const markdownChunk = chunkArtifactIdentity({
      chunkerFingerprint: digest("c"),
      documentKind: "markdown",
      extractedContentDigest: digest("d"),
      semanticContextDigest: digest("e"),
      sourceArtifactId: source,
    });
    expect(codeChunk).not.toBe(markdownChunk);
    expect(
      embeddingArtifactIdentity({
        chunkArtifactId: codeChunk,
        dimensions: 384,
        dtype: "float32",
        exactInputDigest: digest("f"),
        modelId: "onnx-community/granite-embedding-30m-english-ONNX",
        modelRevision: "abc123",
        normalized: true,
        pooling: "mean",
        tokenizerId: "granite-tokenizer",
        tokenizerRevision: "def456",
      }),
    ).toMatch(/^embedding:v1:/);
  });

  test("enforces complete immutable reader pins", () => {
    const coordinates = {
      manifestArtifactId: identity("revision-manifest", "pin-manifest"),
      revisionId: identity("revision", "pin-revision"),
      storageDomainId: storageDomain().domainId,
      tableVersions: COMPLETE_GENERATION_TABLES.map((table) => ({
        table,
        version: 2,
      })),
      workspaceId: identity("workspace", "pin-workspace"),
    };
    const generationId = createPublicationGenerationId(coordinates);
    const generation = PublicationGenerationSchema.parse({
      ...coordinates,
      generationId,
      immutable: true,
      publishedAt: now,
      schemaVersion: INTELLIGENCE_SCHEMA_VERSION,
      state: "published",
    });
    const basePin = {
      ...coordinates,
      createdAt: now,
      expiresAt: later,
      generationId,
      pinId: identity("reader-pin", "complete"),
      readerId: "reader",
    };
    expect(() =>
      assertReaderPinsGeneration(generation, ReaderPinSchema.parse(basePin)),
    ).not.toThrow();
    expect(() =>
      ReaderPinSchema.parse({
        ...basePin,
        tableVersions: coordinates.tableVersions.slice(1),
      }),
    ).toThrow(/every required table/i);
    expect(() => ReaderPinSchema.parse({ ...basePin, expiresAt: now })).toThrow(
      /expiration/i,
    );
    expect(() =>
      PublicationGenerationSchema.parse({
        ...generation,
        generationId: identity("generation", "forged"),
      }),
    ).toThrow(/does not match/i);
    expect(() =>
      assertReaderPinsGeneration(generation, {
        ...ReaderPinSchema.parse(basePin),
        storageDomainId: identity("storage-domain", "other"),
      }),
    ).toThrow();
    expect(() =>
      assertReaderPinsGeneration(generation, {
        ...ReaderPinSchema.parse(basePin),
        tableVersions: coordinates.tableVersions.map((pin, index) =>
          index === 0 ? { ...pin, version: 99 } : pin,
        ),
      }),
    ).toThrow();
  });

  test("keeps graph identities separate from materialized fingerprints", () => {
    const nodeId = graphNodeIdentity({
      canonicalName: "pkg.symbol",
      kind: "function",
    });
    const occurrenceId = graphOccurrenceIdentity({
      nodeId,
      path: "src/a.ts",
      range,
      role: "declaration",
      sourceArtifactId: identity("source", "occurrence"),
    });
    const membershipId = revisionMembershipIdentity({
      entityId: occurrenceId,
      entityKind: "occurrence",
      generationId: identity("generation", "membership"),
      revisionId: identity("revision", "membership"),
    });
    expect(nodeId).toMatch(/^graph-node:v1:/);
    expect(occurrenceId).toMatch(/^graph-occurrence:v1:/);
    expect(membershipId).toMatch(/^revision-membership:v1:/);
  });

  test("rejects dishonest cross-capability combinations", () => {
    const unsupported = {
      implementationFingerprint: null,
      limitations: ["Unavailable"],
      provider: "none" as const,
      status: "unsupported" as const,
    };
    const supported = {
      implementationFingerprint: digest("e"),
      limitations: [],
      provider: "structured-parser" as const,
      status: "supported" as const,
    };
    expect(() =>
      CapabilityClaimSchema.parse({
        implementationFingerprint: null,
        limitations: [],
        provider: "none",
        status: "unsupported",
      }),
    ).toThrow(/explain their limitation/i);
    expect(() =>
      CapabilityClaimSchema.parse({
        implementationFingerprint: null,
        limitations: ["Incomplete"],
        provider: "none",
        status: "partial",
      }),
    ).toThrow(/require an implementation/i);
    expect(() =>
      CapabilityClaimSchema.parse({
        implementationFingerprint: digest("f"),
        limitations: [],
        provider: "custom",
        status: "partial",
      }),
    ).toThrow(/state their limitations/i);
    const base = {
      callResolution: unsupported,
      embeddedLanguageIds: [],
      embeddedLanguages: unsupported,
      exportResolution: unsupported,
      extensions: [".data"],
      importResolution: unsupported,
      inheritanceResolution: unsupported,
      languageId: "data",
      match: supported,
      parse: supported,
      rewrite: supported,
      schemaVersion: INTELLIGENCE_SCHEMA_VERSION,
      structuralRead: supported,
      structuredParser: { mode: "none" as const },
      symbolExtraction: supported,
    };
    expect(() =>
      LanguageCapabilitySchema.parse({
        ...base,
        embeddedLanguageIds: ["javascript"],
      }),
    ).toThrow(/cannot list language IDs/i);
    expect(() =>
      LanguageCapabilitySchema.parse({
        ...base,
        structuralRead: unsupported,
        structuredParser: {
          formats: ["json"],
          mode: "native",
          preservesComments: false,
        },
      }),
    ).toThrow(/requires structural reads/i);
  });

  test("rejects inconsistent result metadata and retry guidance", () => {
    expect(() =>
      ResultScopeSchema.parse({
        evaluatedCandidates: 2,
        excludedPaths: [],
        includedPaths: [],
        languages: [],
        requestedPaths: [],
        totalCandidates: 1,
      }),
    ).toThrow(/cannot exceed/i);
    expect(() =>
      FreshnessSchema.parse({
        indexedAt: now,
        pendingJobCount: 0,
        reason: null,
        sourceObservedAt: now,
        stale: true,
      }),
    ).toThrow(/require a reason/i);
    expect(() =>
      PaginationSchema.parse({
        cursor: null,
        hasMore: false,
        limit: 1,
        nextCursor: null,
        returned: 2,
      }),
    ).toThrow(/cannot exceed/i);
    expect(() =>
      TruncationBudgetSchema.parse({
        consumedBytes: 11,
        consumedItems: 1,
        maxBytes: 10,
        maxItems: 1,
        reason: "none",
        truncated: false,
      }),
    ).toThrow(/cannot exceed/i);
    expect(() =>
      TruncationBudgetSchema.parse({
        consumedBytes: 1,
        consumedItems: 1,
        maxBytes: 10,
        maxItems: 1,
        reason: "byte-limit",
        truncated: false,
      }),
    ).toThrow(/must agree/i);
    expect(() =>
      IntelligenceErrorSchema.parse({
        actualGenerationId: null,
        capability: null,
        code: "invalid_request",
        expectedGenerationId: null,
        message: "Invalid input",
        path: null,
        retryAfterMs: 50,
        retryable: false,
        schemaVersion: INTELLIGENCE_SCHEMA_VERSION,
        selector: null,
        suggestedAction: "correct-request",
      }),
    ).toThrow(/cannot specify retry timing/i);
  });
});

describe("reviewed contract boundaries", () => {
  test("changes chunk and embedding identities for every reuse boundary", () => {
    const source = sourceArtifactIdentity({ contentDigest: digest("1") });
    const syntax = syntaxFactsArtifactIdentity({
      languageId: "typescript",
      parserFingerprint: digest("2"),
      sourceArtifactId: source,
    });
    const chunk = {
      chunkerFingerprint: digest("3"),
      documentKind: "code" as const,
      extractedContentDigest: digest("4"),
      semanticContextDigest: digest("5"),
      syntaxFactsArtifactId: syntax,
    };
    const chunkId = chunkArtifactIdentity(chunk);
    const chunkVariants = [
      chunkArtifactIdentity({ ...chunk, chunkerFingerprint: digest("6") }),
      chunkArtifactIdentity({ ...chunk, extractedContentDigest: digest("7") }),
      chunkArtifactIdentity({ ...chunk, semanticContextDigest: digest("8") }),
      chunkArtifactIdentity({
        ...chunk,
        syntaxFactsArtifactId: identity("syntax-facts", "other"),
      }),
    ];
    expect(new Set([chunkId, ...chunkVariants]).size).toBe(5);

    const embedding = {
      chunkArtifactId: chunkId,
      dimensions: 384,
      dtype: "float32" as const,
      exactInputDigest: digest("9"),
      modelId: "model",
      modelRevision: "revision-a",
      normalized: true,
      pooling: "mean" as const,
      tokenizerId: "tokenizer",
      tokenizerRevision: "tokenizer-a",
    };
    const embeddingId = embeddingArtifactIdentity(embedding);
    const embeddingVariants = [
      embeddingArtifactIdentity({
        ...embedding,
        chunkArtifactId: identity("chunks", "other"),
      }),
      embeddingArtifactIdentity({ ...embedding, dimensions: 768 }),
      embeddingArtifactIdentity({ ...embedding, dtype: "float16" }),
      embeddingArtifactIdentity({
        ...embedding,
        exactInputDigest: digest("a"),
      }),
      embeddingArtifactIdentity({ ...embedding, modelId: "other-model" }),
      embeddingArtifactIdentity({ ...embedding, modelRevision: "revision-b" }),
      embeddingArtifactIdentity({ ...embedding, normalized: false }),
      embeddingArtifactIdentity({ ...embedding, pooling: "cls" }),
      embeddingArtifactIdentity({
        ...embedding,
        tokenizerId: "other-tokenizer",
      }),
      embeddingArtifactIdentity({
        ...embedding,
        tokenizerRevision: "tokenizer-b",
      }),
    ];
    expect(new Set([embeddingId, ...embeddingVariants]).size).toBe(11);
  });

  test("rejects unsafe and duplicate manifest paths", () => {
    expect(RepositoryRelativePathSchema.safeParse("src/a.ts").success).toBe(
      true,
    );
    expect(RepositoryRelativePathSchema.safeParse("src/a:b.ts").success).toBe(
      true,
    );
    expect(compareRepositoryPaths("z", "ä")).toBe(-1);
    for (const path of [
      "/repo/a.ts",
      "../a.ts",
      "src\\a.ts",
      "./a.ts",
      "src/./a.ts",
      "C:/repo/a.ts",
    ]) {
      expect(RepositoryRelativePathSchema.safeParse(path).success).toBe(false);
    }
    const entry = {
      path: "src/a.ts",
      resolvedRelationshipsArtifactId: null,
      sourceArtifactId: identity("source", "manifest"),
      syntaxFactsArtifactId: null,
    };
    expect(() =>
      RevisionManifestArtifactInputSchema.parse({
        dirtyOverlayId: null,
        entries: [entry, entry],
        repositoryId: identity("repository", "manifest"),
        revisionId: identity("revision", "manifest"),
      }),
    ).toThrow(/unique repository paths/i);
    expect(() =>
      DirtyOverlayArtifactInputSchema.parse({
        baseRevisionId: identity("revision", "overlay"),
        checkoutRoot: "/repo",
        entries: [
          { contentDigest: digest("b"), path: "a.ts", status: "added" },
          { contentDigest: digest("c"), path: "a.ts", status: "modified" },
        ],
        repositoryId: identity("repository", "overlay"),
      }),
    ).toThrow(/unique repository paths/i);
  });

  test("validates all exported identity helper inputs", () => {
    expect(() =>
      createRepositoryId({ canonicalGitCommonDirectory: "relative/.git" }),
    ).toThrow(/absolute/i);
    expect(() =>
      createRevisionId({
        repositoryId: identity("repository", "helper"),
        resolvedCommitOid: null,
        selector: { kind: "branch", name: "main" },
      }),
    ).toThrow(/resolved commit/i);
    expect(() =>
      createWorkspaceId({
        canonicalCheckoutRoot: "relative",
        configurationGeneration: -1,
        dirtyOverlayId: null,
        repositoryId: identity("repository", "helper"),
        revisionId: identity("revision", "helper"),
        storageDomainId: identity("storage-domain", "helper"),
      }),
    ).toThrow();
    expect(() =>
      graphNodeIdentity({ canonicalName: "", kind: "function" }),
    ).toThrow();
    expect(() =>
      createJobIdempotencyKey({
        inputFingerprint: "not-a-digest",
        revisionId: identity("revision", "helper"),
        storageDomainId: identity("storage-domain", "helper"),
        type: "parse",
        workspaceId: identity("workspace", "helper"),
      }),
    ).toThrow();
  });

  test("requires concrete linked evidence for persisted relationships", () => {
    const sourceNodeId = identity("graph-node", "source-node");
    const targetNodeId = identity("graph-node", "target-node");
    const edgeId = graphEdgeIdentity({
      discriminator: "direct-call",
      kind: "calls",
      sourceNodeId,
      targetNodeId,
    });
    const edge = {
      contentFingerprint: digest("d"),
      direction: "directed" as const,
      discriminator: "direct-call",
      edgeId,
      environmentFingerprint: digest("e"),
      kind: "calls" as const,
      properties: [],
      resolutionStatus: "resolved" as const,
      sourceNodeId,
      targetNodeId,
    };
    const occurrenceInput = {
      nodeId: sourceNodeId,
      path: "src/a.ts",
      range,
      role: "call" as const,
      sourceArtifactId: identity("source", "evidence"),
    };
    const occurrence = {
      ...occurrenceInput,
      occurrenceId: graphOccurrenceIdentity(occurrenceInput),
    };
    const evidenceInput = {
      edgeId,
      extractionMethod: "tree-sitter-query" as const,
      extractionVersion: "1.2.3",
      extractorFingerprint: digest("f"),
      occurrenceId: occurrence.occurrenceId,
      path: occurrence.path,
      range: occurrence.range,
      sourceArtifactId: occurrence.sourceArtifactId,
    };
    const evidence = {
      ...evidenceInput,
      confidence: 1,
      evidenceId: graphEvidenceIdentity(evidenceInput),
    };
    const relationship = {
      edge,
      evidence: [evidence],
      occurrences: [occurrence],
    };
    expect(GraphRelationshipSchema.parse(relationship).edge).toEqual(edge);
    expect(() =>
      GraphRelationshipSchema.parse({
        ...relationship,
        evidence: [],
      }),
    ).toThrow();
    const otherEdgeEvidenceInput = {
      ...evidenceInput,
      edgeId: identity("graph-edge", "other"),
    };
    expect(() =>
      GraphRelationshipSchema.parse({
        ...relationship,
        evidence: [
          {
            ...otherEdgeEvidenceInput,
            confidence: 1,
            evidenceId: graphEvidenceIdentity(otherEdgeEvidenceInput),
          },
        ],
      }),
    ).toThrow(/link to its edge/i);
    const otherOccurrenceEvidenceInput = {
      ...evidenceInput,
      occurrenceId: identity("graph-occurrence", "other"),
    };
    expect(() =>
      GraphRelationshipSchema.parse({
        ...relationship,
        evidence: [
          {
            ...otherOccurrenceEvidenceInput,
            confidence: 1,
            evidenceId: graphEvidenceIdentity(otherOccurrenceEvidenceInput),
          },
        ],
      }),
    ).toThrow(/bundled occurrence/i);
    const otherRangeEvidenceInput = {
      ...evidenceInput,
      range: {
        ...range,
        end: { column: 10, line: 0 },
        endByte: 10,
      },
    };
    expect(() =>
      GraphRelationshipSchema.parse({
        ...relationship,
        evidence: [
          {
            ...otherRangeEvidenceInput,
            confidence: 1,
            evidenceId: graphEvidenceIdentity(otherRangeEvidenceInput),
          },
        ],
      }),
    ).toThrow(/range must match/i);
    const unrelatedOccurrenceInput = {
      ...occurrenceInput,
      nodeId: identity("graph-node", "unrelated"),
    };
    const unrelatedOccurrence = {
      ...unrelatedOccurrenceInput,
      occurrenceId: graphOccurrenceIdentity(unrelatedOccurrenceInput),
    };
    const unrelatedEvidenceInput = {
      ...evidenceInput,
      occurrenceId: unrelatedOccurrence.occurrenceId,
    };
    expect(() =>
      GraphRelationshipSchema.parse({
        ...relationship,
        evidence: [
          {
            ...unrelatedEvidenceInput,
            confidence: 1,
            evidenceId: graphEvidenceIdentity(unrelatedEvidenceInput),
          },
        ],
        occurrences: [unrelatedOccurrence],
      }),
    ).toThrow(/edge endpoint/i);
    expect(() =>
      GraphRelationshipSchema.parse({
        ...relationship,
        evidence: [{ ...evidence, occurrenceId: null }],
      }),
    ).toThrow();
    expect(GraphNodeKindSchema.parse("package")).toBe("package");
    expect(GraphNodeKindSchema.parse("concept")).toBe("concept");
    expect(GraphNodeKindSchema.parse("external-reference")).toBe(
      "external-reference",
    );
    const nodeInput = { canonicalName: "pkg.fn", kind: "function" as const };
    const node = {
      ...nodeInput,
      contentFingerprint: digest("a"),
      nodeId: graphNodeIdentity(nodeInput),
      properties: [],
    };
    expect(GraphNodeSchema.parse(node).nodeId).toBe(node.nodeId);
    expect(() =>
      GraphNodeSchema.parse({
        ...node,
        nodeId: identity("graph-node", "forged"),
      }),
    ).toThrow(/node identity/i);
    expect(() =>
      GraphRelationshipSchema.parse({
        ...relationship,
        edge: { ...edge, edgeId: identity("graph-edge", "forged") },
      }),
    ).toThrow(/edge identity/i);
    expect(() =>
      GraphRelationshipSchema.parse({
        ...relationship,
        occurrences: [
          {
            ...occurrence,
            occurrenceId: identity("graph-occurrence", "forged"),
          },
        ],
      }),
    ).toThrow(/occurrence identity/i);
    expect(() =>
      GraphRelationshipSchema.parse({
        ...relationship,
        evidence: [
          {
            ...evidence,
            evidenceId: identity("graph-evidence", "forged"),
          },
        ],
      }),
    ).toThrow(/evidence identity/i);
    const membershipInput = {
      entityId: edgeId,
      entityKind: "edge" as const,
      generationId: identity("generation", "membership-check"),
      revisionId: identity("revision", "membership-check"),
    };
    const membership = {
      ...membershipInput,
      membershipId: revisionMembershipIdentity(membershipInput),
    };
    expect(RevisionMembershipSchema.parse(membership).membershipId).toBe(
      membership.membershipId,
    );
    expect(() =>
      RevisionMembershipSchema.parse({
        ...membership,
        membershipId: identity("revision-membership", "forged"),
      }),
    ).toThrow(/membership identity/i);
    const mismatchedMembershipInput = {
      ...membershipInput,
      entityKind: "node" as const,
    };
    expect(() =>
      RevisionMembershipSchema.parse({
        ...mismatchedMembershipInput,
        membershipId: revisionMembershipIdentity(mismatchedMembershipInput),
      }),
    ).toThrow(/entity namespace/i);
    for (const status of [
      "explicit",
      "resolved",
      "inferred",
      "ambiguous",
      "unresolved",
    ] as const) {
      expect(ResolutionStatusSchema.parse(status)).toBe(status);
    }
  });

  test("rejects coherent graph bundles with wrong identity namespaces", () => {
    const sourceNodeId = identity("source", "wrong-source-node");
    const targetNodeId = identity("source", "wrong-target-node");
    const edgeInput = {
      discriminator: "wrong-namespace-call",
      kind: "calls" as const,
      sourceNodeId,
      targetNodeId,
    };
    const edgeId = createIdentity("graph-edge", edgeInput);
    const sourceArtifactId = identity("source", "wrong-namespace-source");
    const occurrenceInput = {
      nodeId: sourceNodeId,
      path: "src/wrong.ts",
      range,
      role: "call" as const,
      sourceArtifactId,
    };
    const occurrenceId = createIdentity("graph-occurrence", occurrenceInput);
    const evidenceInput = {
      edgeId,
      extractionMethod: "ast" as const,
      extractionVersion: "1.0.0",
      extractorFingerprint: digest("a"),
      occurrenceId,
      path: occurrenceInput.path,
      range,
      sourceArtifactId,
    };
    expect(() =>
      GraphRelationshipSchema.parse({
        edge: {
          ...edgeInput,
          contentFingerprint: digest("b"),
          direction: "directed",
          edgeId,
          environmentFingerprint: null,
          properties: [],
          resolutionStatus: "resolved",
        },
        evidence: [
          {
            ...evidenceInput,
            confidence: 1,
            evidenceId: createIdentity("graph-evidence", evidenceInput),
          },
        ],
        occurrences: [{ ...occurrenceInput, occurrenceId }],
      }),
    ).toThrow(/graph-node namespace/i);
  });

  test("represents import, export, call, and inheritance coverage independently", () => {
    const supported = {
      implementationFingerprint: digest("1"),
      limitations: [],
      provider: "tree-sitter" as const,
      status: "supported" as const,
    };
    const unsupported = {
      implementationFingerprint: null,
      limitations: ["Unavailable"],
      provider: "none" as const,
      status: "unsupported" as const,
    };
    const partial = {
      implementationFingerprint: digest("2"),
      limitations: ["Dynamic bases remain unresolved"],
      provider: "custom" as const,
      status: "partial" as const,
    };
    const capability = LanguageCapabilitySchema.parse({
      callResolution: unsupported,
      embeddedLanguageIds: [],
      embeddedLanguages: unsupported,
      exportResolution: partial,
      extensions: [".ts"],
      importResolution: supported,
      inheritanceResolution: partial,
      languageId: "typescript",
      match: supported,
      parse: supported,
      rewrite: supported,
      schemaVersion: INTELLIGENCE_SCHEMA_VERSION,
      structuralRead: supported,
      structuredParser: { mode: "none" },
      symbolExtraction: supported,
    });
    expect(capability.importResolution.status).toBe("supported");
    expect(capability.exportResolution.status).toBe("partial");
    expect(capability.callResolution.status).toBe("unsupported");
    expect(capability.inheritanceResolution.status).toBe("partial");
  });
});
