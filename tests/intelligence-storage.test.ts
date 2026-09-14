import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import { Field, Schema, Utf8 } from "apache-arrow";
import {
  chunkArtifactIdentity,
  resolvedRelationshipsArtifactIdentity,
  revisionManifestArtifactIdentity,
  sourceArtifactIdentity,
  syntaxFactsArtifactIdentity,
} from "../src/intelligence/contracts/artifacts.ts";
import {
  createIdentity,
  INTELLIGENCE_SCHEMA_VERSION,
} from "../src/intelligence/contracts/common.ts";
import {
  createStorageDomainId,
  type LanceTableName,
  type StorageDomain,
} from "../src/intelligence/contracts/storage.ts";
import {
  createRepositoryId,
  createRevisionId,
  createWorkspaceId,
} from "../src/intelligence/contracts/workspace.ts";
import {
  ALL_TABLES,
  assertCompatibleSchema,
  LanceIntelligenceStore,
  TABLE_SCHEMAS,
} from "../src/intelligence/storage/index.ts";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const NOW = "2026-09-10T00:00:00.000Z";

async function storageDomain(): Promise<StorageDomain> {
  const storagePath = await mkdtemp(join(tmpdir(), "ast-mcp-storage-"));
  return {
    domainId: createStorageDomainId({
      engine: "lancedb",
      placement: { kind: "explicit", path: storagePath },
      pool: "shared",
      storagePath,
    }),
    engine: "lancedb",
    placement: { kind: "explicit", path: storagePath },
    pool: "shared",
    schemaVersion: INTELLIGENCE_SCHEMA_VERSION,
    storagePath,
  };
}

function workspaceCoordinates(domain: StorageDomain, suffix = "0") {
  const repositoryId = createRepositoryId({
    canonicalGitCommonDirectory: `/repos/${suffix}/.git`,
  });
  const revisionId = createRevisionId({
    repositoryId,
    resolvedCommitOid: null,
    selector: { kind: "working" },
  });
  const workspaceId = createWorkspaceId({
    canonicalCheckoutRoot: `/repos/${suffix}`,
    configurationGeneration: 1,
    dirtyOverlayId: null,
    repositoryId,
    revisionId,
    storageDomainId: domain.domainId,
  });
  return { repositoryId, revisionId, workspaceId };
}

describe("LanceDB intelligence storage", () => {
  test("creates and reopens all explicit Arrow schemas", async () => {
    const domain = await storageDomain();
    const store = await LanceIntelligenceStore.open(domain);
    expect(Object.keys(TABLE_SCHEMAS).sort()).toEqual([...ALL_TABLES].sort());
    expect(() =>
      assertCompatibleSchema(
        "artifacts",
        new Schema([new Field("wrong", new Utf8(), false)]),
      ),
    ).toThrow("does not match ast-mcp intelligence schema");
    const expectedCounts = Object.fromEntries(
      ALL_TABLES.map((table) => [
        table,
        table === "coordinator_recovery" ||
        table === "migrations" ||
        table === "retention"
          ? 1
          : 0,
      ]),
    ) as Record<LanceTableName, number>;
    expect(await store.tableCounts()).toEqual(expectedCounts);

    const reopened = await LanceIntelligenceStore.open(domain);
    expect(await reopened.tableCounts()).toEqual(await store.tableCounts());
    await store.shutdownCoordinator();
    expect(
      await reopened.serializeMigration("shared handle", async () => "open"),
    ).toBe("open");
    await reopened.shutdownCoordinator();

    const afterShutdown = await LanceIntelligenceStore.open(domain);
    expect(
      await afterShutdown.serializeMigration("reopened", async () => "open"),
    ).toBe("open");
    await afterShutdown.shutdownCoordinator();
  });

  test("roundtrips every persistent record family", async () => {
    const domain = await storageDomain();
    const store = await LanceIntelligenceStore.open(domain);
    const { repositoryId, revisionId, workspaceId } =
      workspaceCoordinates(domain);
    const sourceId = sourceArtifactIdentity({ contentDigest: A });
    const syntaxId = syntaxFactsArtifactIdentity({
      languageId: "typescript",
      parserFingerprint: B,
      sourceArtifactId: sourceId,
    });
    const chunkId = chunkArtifactIdentity({
      chunkerFingerprint: A,
      documentKind: "code",
      extractedContentDigest: B,
      semanticContextDigest: C,
      syntaxFactsArtifactId: syntaxId,
    });
    const relationshipId = resolvedRelationshipsArtifactIdentity({
      environmentFingerprint: A,
      resolverFingerprint: B,
      syntaxFactsArtifactId: syntaxId,
    });
    const manifestPayload = {
      dirtyOverlayId: null,
      entries: [
        {
          path: "src/example.ts",
          resolvedRelationshipsArtifactId: relationshipId,
          sourceArtifactId: sourceId,
          syntaxFactsArtifactId: syntaxId,
        },
      ],
      repositoryId,
      revisionId,
    };
    const manifestId = revisionManifestArtifactIdentity(manifestPayload);
    const generationPlaceholder = createIdentity("generation", { revisionId });
    const nodeId = createIdentity("graph-node", {
      canonicalName: "example",
      kind: "function",
    });
    const occurrenceId = createIdentity("graph-occurrence", { nodeId });
    const edgeId = createIdentity("graph-edge", { nodeId });
    const evidenceId = createIdentity("graph-evidence", { edgeId });
    const membershipId = createIdentity("revision-membership", { nodeId });
    const overlayId = createIdentity("dirty-overlay", { revisionId });
    const embeddingId = createIdentity("embedding", { chunkId });
    const rows: Partial<Record<LanceTableName, Record<string, unknown>>> = {
      artifacts: {
        artifact_id: sourceId,
        byte_length: 18,
        content_bytes: new TextEncoder().encode("export const x = 1"),
        content_digest: A,
        created_at: NOW,
        kind: "source",
        payload_json: JSON.stringify({ contentDigest: A }),
      },
      chunks: {
        artifact_id: chunkId,
        byte_length: 18,
        created_at: NOW,
        document_kind: "code",
        extracted_content_digest: B,
        payload_json: JSON.stringify({ text: "export const x = 1" }),
        semantic_context_digest: C,
        source_artifact_id: null,
        syntax_facts_artifact_id: syntaxId,
        text: "export const x = 1",
      },
      communities: {
        algorithm: "leiden",
        community_id: createIdentity("community", { nodeId }),
        created_at: NOW,
        generation_id: generationPlaceholder,
        member_ids_json: JSON.stringify([nodeId]),
        payload_json: "{}",
        resolution: 1,
        revision_id: revisionId,
      },
      dirty_overlays: {
        artifact_id: overlayId,
        base_revision_id: revisionId,
        checkout_root: "/repos/0",
        created_at: NOW,
        entry_count: 0,
        logical_bytes: 0,
        payload_json: JSON.stringify({ entries: [] }),
        repository_id: repositoryId,
      },
      embeddings: {
        artifact_id: embeddingId,
        byte_length: 12,
        chunk_artifact_id: chunkId,
        created_at: NOW,
        dimensions: 3,
        dtype: "float32",
        exact_input_digest: A,
        model_id: "test",
        model_revision: "1",
        normalized: true,
        payload_json: "{}",
        pooling: "mean",
        vector: [0.1, 0.2, 0.3],
      },
      graph_edges: {
        content_fingerprint: A,
        created_at: NOW,
        discriminator: "call",
        edge_id: edgeId,
        environment_fingerprint: null,
        kind: "calls",
        properties_json: "[]",
        resolution_status: "resolved",
        source_node_id: nodeId,
        target_node_id: nodeId,
      },
      graph_evidence: {
        confidence: 1,
        created_at: NOW,
        edge_id: edgeId,
        evidence_id: evidenceId,
        extraction_method: "ast",
        extraction_version: "1",
        extractor_fingerprint: B,
        occurrence_id: occurrenceId,
        path: "src/example.ts",
        range_json: JSON.stringify({ endByte: 1, startByte: 0 }),
        source_artifact_id: sourceId,
      },
      graph_nodes: {
        canonical_name: "example",
        content_fingerprint: A,
        created_at: NOW,
        kind: "function",
        node_id: nodeId,
        properties_json: "[]",
      },
      graph_occurrences: {
        created_at: NOW,
        node_id: nodeId,
        occurrence_id: occurrenceId,
        path: "src/example.ts",
        range_json: JSON.stringify({ endByte: 1, startByte: 0 }),
        role: "declaration",
        source_artifact_id: sourceId,
      },
      jobs: {
        attempt: 0,
        created_at: NOW,
        error_code: null,
        idempotency_key: createIdentity("job", { kind: "parse" }),
        job_id: createIdentity("job", { job: "parse" }),
        payload_json: "{}",
        revision_id: revisionId,
        state: "pending",
        storage_domain_id: domain.domainId,
        type: "parse",
        updated_at: NOW,
        workspace_id: workspaceId,
      },
      migrations: {
        completed_at: NOW,
        from_schema_version: "ast-mcp.intelligence.v0",
        migration_id: createIdentity("migration", { version: 1 }),
        payload_json: "{}",
        started_at: NOW,
        state: "succeeded",
        to_schema_version: INTELLIGENCE_SCHEMA_VERSION,
      },
      reader_pins: {
        created_at: NOW,
        expires_at: "2026-09-10T00:01:00.000Z",
        generation_id: generationPlaceholder,
        manifest_artifact_id: manifestId,
        payload_json: "{}",
        pin_id: createIdentity("reader-pin", { reader: "fixture" }),
        reader_id: "fixture",
        revision_id: revisionId,
        storage_domain_id: domain.domainId,
        table_versions_json: "[]",
        workspace_id: workspaceId,
      },
      relationships: {
        artifact_id: relationshipId,
        byte_length: 8,
        created_at: NOW,
        environment_fingerprint: A,
        payload_json: "{}",
        resolver_fingerprint: B,
        syntax_facts_artifact_id: syntaxId,
      },
      revision_manifests: {
        artifact_id: manifestId,
        created_at: NOW,
        dirty_overlay_id: null,
        entry_count: 1,
        logical_bytes: 18,
        payload_json: JSON.stringify(manifestPayload),
        repository_id: repositoryId,
        revision_id: revisionId,
      },
      revision_membership: {
        created_at: NOW,
        entity_id: nodeId,
        entity_kind: "node",
        generation_id: generationPlaceholder,
        membership_id: membershipId,
        revision_id: revisionId,
      },
      summaries: {
        content: "Example summary",
        content_digest: C,
        created_at: NOW,
        generation_id: generationPlaceholder,
        model_id: null,
        payload_json: "{}",
        revision_id: revisionId,
        subject_id: nodeId,
        summary_id: createIdentity("summary", { nodeId }),
        summary_kind: "deterministic",
      },
      syntax_facts: {
        artifact_id: syntaxId,
        byte_length: 12,
        created_at: NOW,
        language_id: "typescript",
        parser_fingerprint: B,
        payload_json: JSON.stringify({ declarations: ["x"] }),
        source_artifact_id: sourceId,
      },
      workspaces: {
        active: true,
        logical_bytes: 18,
        manifest_artifact_id: manifestId,
        payload_json: JSON.stringify({ workspaceId }),
        repository_id: repositoryId,
        revision_id: revisionId,
        storage_domain_id: domain.domainId,
        updated_at: NOW,
        workspace_id: workspaceId,
      },
    };

    for (const [tableName, row] of Object.entries(rows)) {
      await store.putRows(tableName as LanceTableName, [row]);
      const primaryValue = Object.values(row)[0];
      expect(await store.count(tableName as LanceTableName)).toBeGreaterThan(0);
      expect(primaryValue).toBeDefined();
    }
    await store.putJob({
      attempt: 0,
      createdAt: NOW,
      errorCode: null,
      idempotencyKey: createIdentity("job", { key: "put-job" }),
      jobId: createIdentity("job", { name: "put-job" }),
      revisionId,
      state: "pending",
      storageDomainId: domain.domainId,
      type: "parse",
      updatedAt: NOW,
      workspaceId,
    });
    const generation = await store.publish({
      manifestArtifactId: manifestId,
      revisionId,
      workspaceId,
    });
    expect((await store.latestGeneration(workspaceId))?.generationId).toBe(
      generation.generationId,
    );
    expect(await store.count("publications")).toBe(1);
    expect(await store.count("coordinator_recovery")).toBe(1);
    expect(await store.count("retention")).toBe(1);
    await store.shutdownCoordinator();
  });

  test("bounds table counts by row and deadline", async () => {
    const domain = await storageDomain();
    const store = await LanceIntelligenceStore.open(domain);
    await store.putRows(
      "artifacts",
      ["bounded-a", "bounded-b", "bounded-c"].map((name, index) => ({
        artifact_id: createIdentity("source", { name }),
        byte_length: index + 1,
        content_bytes: new TextEncoder().encode(name),
        content_digest: String(index + 1).repeat(64),
        created_at: NOW,
        kind: "source",
        payload_json: "{}",
      })),
    );

    const capped = await store.boundedTableCounts({
      maxRowsPerTable: 2,
      timeoutMs: 5_000,
    });
    expect(capped.counts.artifacts).toBe(2);
    expect(capped.truncated).toBeTrue();
    expect(capped.exhaustive).toBeFalse();
    expect(capped.returnedTables).toBe(ALL_TABLES.length);

    const expired = await store.boundedTableCounts({
      maxRowsPerTable: 10,
      timeoutMs: 0,
    });
    expect(expired.counts).toEqual({});
    expect(expired.returnedTables).toBe(0);
    expect(expired.truncated).toBeTrue();
    expect(expired.exhaustive).toBeFalse();
    await store.shutdownCoordinator();
  });

  test("deduplicates physical artifacts across revisions, workspaces, renames, and repositories", async () => {
    const domain = await storageDomain();
    const store = await LanceIntelligenceStore.open(domain);
    const sourceId = sourceArtifactIdentity({ contentDigest: A });
    const sourceRow = {
      artifact_id: sourceId,
      byte_length: 10,
      content_bytes: new TextEncoder().encode("0123456789"),
      content_digest: A,
      created_at: NOW,
      kind: "source",
      payload_json: JSON.stringify({ contentDigest: A }),
    };
    const first = await store.putRows("artifacts", [sourceRow]);
    const second = await store.putRows("artifacts", [
      { ...sourceRow, created_at: "2026-09-10T00:00:01.000Z" },
    ]);
    expect(first).toMatchObject({ insertedRows: 1, reusedRows: 0 });
    expect(second).toMatchObject({
      insertedRows: 0,
      reusedBytes: 10,
      reusedRows: 1,
    });

    for (let index = 0; index < 100; index += 1) {
      const coordinates = workspaceCoordinates(domain, `revision-${index}`);
      const payload = {
        dirtyOverlayId: null,
        entries: [
          {
            path: index % 2 === 0 ? "src/old.ts" : "src/new.ts",
            resolvedRelationshipsArtifactId: null,
            sourceArtifactId: sourceId,
            syntaxFactsArtifactId: null,
          },
        ],
        repositoryId: coordinates.repositoryId,
        revisionId: coordinates.revisionId,
      };
      await store.putRows("revision_manifests", [
        {
          artifact_id: revisionManifestArtifactIdentity(payload),
          created_at: NOW,
          dirty_overlay_id: null,
          entry_count: 1,
          logical_bytes: 10,
          payload_json: JSON.stringify(payload),
          repository_id: coordinates.repositoryId,
          revision_id: coordinates.revisionId,
        },
      ]);
    }
    expect(await store.count("artifacts")).toBe(1);
    expect(await store.count("revision_manifests")).toBe(100);

    const shared = workspaceCoordinates(domain, "shared");
    for (let index = 0; index < 20; index += 1) {
      await store.putRows(
        "workspaces",
        [
          {
            active: true,
            logical_bytes: 10,
            manifest_artifact_id: null,
            payload_json: "{}",
            repository_id: shared.repositoryId,
            revision_id: shared.revisionId,
            storage_domain_id: domain.domainId,
            updated_at: NOW,
            workspace_id: createIdentity("workspace", { index, shared }),
          },
        ],
        { immutable: false },
      );
    }
    expect(await store.metrics()).toEqual({
      logicalBytes: 200,
      logicalReferences: 120,
      physicalArtifacts: 1,
      physicalBytes: 10,
      reusedBytes: 190,
      storageGrowthBytes: 10,
    });
    await store.shutdownCoordinator();
  });

  test("adds only changed content-derived artifacts for a changed function", async () => {
    const domain = await storageDomain();
    const store = await LanceIntelligenceStore.open(domain);
    const firstSourceId = sourceArtifactIdentity({ contentDigest: A });
    const secondSourceId = sourceArtifactIdentity({ contentDigest: B });
    const firstSyntaxId = syntaxFactsArtifactIdentity({
      languageId: "typescript",
      parserFingerprint: C,
      sourceArtifactId: firstSourceId,
    });
    const secondSyntaxId = syntaxFactsArtifactIdentity({
      languageId: "typescript",
      parserFingerprint: C,
      sourceArtifactId: secondSourceId,
    });

    await store.putRows("artifacts", [
      {
        artifact_id: firstSourceId,
        byte_length: 19,
        content_bytes: new TextEncoder().encode("export const x = 1;"),
        content_digest: A,
        created_at: NOW,
        kind: "source",
        payload_json: "{}",
      },
    ]);
    await store.putRows("syntax_facts", [
      {
        artifact_id: firstSyntaxId,
        byte_length: 8,
        created_at: NOW,
        language_id: "typescript",
        parser_fingerprint: C,
        payload_json: JSON.stringify({ declarations: ["x"] }),
        source_artifact_id: firstSourceId,
      },
    ]);
    expect(await store.count("artifacts")).toBe(1);
    expect(await store.count("syntax_facts")).toBe(1);

    await store.putRows("artifacts", [
      {
        artifact_id: secondSourceId,
        byte_length: 19,
        content_bytes: new TextEncoder().encode("export const x = 2;"),
        content_digest: B,
        created_at: NOW,
        kind: "source",
        payload_json: "{}",
      },
    ]);
    await store.putRows("syntax_facts", [
      {
        artifact_id: secondSyntaxId,
        byte_length: 8,
        created_at: NOW,
        language_id: "typescript",
        parser_fingerprint: C,
        payload_json: JSON.stringify({ declarations: ["x"] }),
        source_artifact_id: secondSourceId,
      },
    ]);
    expect(await store.count("artifacts")).toBe(2);
    expect(await store.count("syntax_facts")).toBe(2);
    expect(await store.count("relationships")).toBe(0);
    await store.shutdownCoordinator();
  });

  test("read-only verification rejects missing and corrupt Lance tables", async () => {
    for (const failure of ["missing", "schema"] as const) {
      const domain = await storageDomain();
      const store = await LanceIntelligenceStore.open(domain);
      await store.shutdownCoordinator();
      const connection = await lancedb.connect(domain.storagePath);
      await connection.dropTable("graph_nodes");
      if (failure === "schema")
        await connection.createEmptyTable(
          "graph_nodes",
          new Schema([new Field("wrong", new Utf8(), false)]),
        );
      connection.close();
      await expect(
        LanceIntelligenceStore.open(domain, { access: "read-only" }),
      ).rejects.toMatchObject({
        code: failure === "missing" ? "storage_unavailable" : "invalid_schema",
      });
    }
  });

  test("keeps cross-repository syntax shared and resolution environment-specific", async () => {
    const domain = await storageDomain();
    const store = await LanceIntelligenceStore.open(domain);
    const sourceId = sourceArtifactIdentity({ contentDigest: A });
    const syntaxId = syntaxFactsArtifactIdentity({
      languageId: "typescript",
      parserFingerprint: B,
      sourceArtifactId: sourceId,
    });
    const source = {
      artifact_id: sourceId,
      byte_length: 1,
      content_bytes: new Uint8Array([1]),
      content_digest: A,
      created_at: NOW,
      kind: "source",
      payload_json: "{}",
    };
    const syntax = {
      artifact_id: syntaxId,
      byte_length: 1,
      created_at: NOW,
      language_id: "typescript",
      parser_fingerprint: B,
      payload_json: "{}",
      source_artifact_id: sourceId,
    };
    await Promise.all([
      store.putRows("artifacts", [source]),
      store.putRows("syntax_facts", [syntax]),
    ]);
    await store.putRows("artifacts", [source]);
    await store.putRows("syntax_facts", [syntax]);

    for (const environmentFingerprint of [A, C]) {
      const artifactId = resolvedRelationshipsArtifactIdentity({
        environmentFingerprint,
        resolverFingerprint: B,
        syntaxFactsArtifactId: syntaxId,
      });
      await store.putRows("relationships", [
        {
          artifact_id: artifactId,
          byte_length: 1,
          created_at: NOW,
          environment_fingerprint: environmentFingerprint,
          payload_json: "{}",
          resolver_fingerprint: B,
          syntax_facts_artifact_id: syntaxId,
        },
      ]);
    }
    expect(await store.count("artifacts")).toBe(1);
    expect(await store.count("syntax_facts")).toBe(1);
    expect(await store.count("relationships")).toBe(2);
    await store.shutdownCoordinator();
  });
});
