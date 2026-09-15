import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readdir,
  readFile,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import { sourceArtifactIdentity } from "../src/intelligence/contracts/artifacts.ts";
import {
  createIdentity,
  INTELLIGENCE_SCHEMA_VERSION,
} from "../src/intelligence/contracts/common.ts";
import {
  createStorageDomainId,
  type StorageDomain,
} from "../src/intelligence/contracts/storage.ts";
import {
  assertSupportedStoragePath,
  copyRelocationSnapshot,
  LanceIntelligenceStore,
  type StorageError,
  snapshotStorageDirectory,
  storagePathIdentity,
  validateRelocationCoordinates,
} from "../src/intelligence/storage/index.ts";

const OLD = "2020-01-01T00:00:00.000Z";

async function domain(): Promise<StorageDomain> {
  const storagePath = await mkdtemp(join(tmpdir(), "ast-mcp-recovery-"));
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

function graphBundle(
  name: string,
  sourceArtifactId: string,
  revisionId: string,
) {
  const generationId = createIdentity("generation", { name });
  const nodeId = createIdentity("graph-node", { name, side: "source" });
  const targetNodeId = createIdentity("graph-node", { name, side: "target" });
  const occurrenceId = createIdentity("graph-occurrence", { name });
  const edgeId = createIdentity("graph-edge", { name });
  const evidenceId = createIdentity("graph-evidence", { name });
  return {
    communities: {
      algorithm: "leiden",
      community_id: createIdentity("community", { name }),
      created_at: OLD,
      generation_id: generationId,
      member_ids_json: JSON.stringify([nodeId, targetNodeId]),
      payload_json: "{}",
      resolution: 1,
      revision_id: revisionId,
    },
    edge: {
      content_fingerprint: name,
      created_at: OLD,
      discriminator: "call",
      edge_id: edgeId,
      environment_fingerprint: null,
      kind: "calls",
      properties_json: "[]",
      resolution_status: "resolved",
      source_node_id: nodeId,
      target_node_id: targetNodeId,
    },
    evidence: {
      confidence: 1,
      created_at: OLD,
      edge_id: edgeId,
      evidence_id: evidenceId,
      extraction_method: "ast",
      extraction_version: "1",
      extractor_fingerprint: name,
      occurrence_id: occurrenceId,
      path: `src/${name}.ts`,
      range_json: JSON.stringify({ endByte: 1, startByte: 0 }),
      source_artifact_id: sourceArtifactId,
    },
    membership: {
      created_at: OLD,
      entity_id: nodeId,
      entity_kind: "node",
      generation_id: generationId,
      membership_id: createIdentity("revision-membership", { name }),
      revision_id: revisionId,
    },
    nodes: [
      {
        canonical_name: `${name}.source`,
        content_fingerprint: name,
        created_at: OLD,
        kind: "function",
        node_id: nodeId,
        properties_json: "[]",
      },
      {
        canonical_name: `${name}.target`,
        content_fingerprint: name,
        created_at: OLD,
        kind: "function",
        node_id: targetNodeId,
        properties_json: "[]",
      },
    ],
    occurrence: {
      created_at: OLD,
      node_id: nodeId,
      occurrence_id: occurrenceId,
      path: `src/${name}.ts`,
      range_json: JSON.stringify({ endByte: 1, startByte: 0 }),
      role: "declaration",
      source_artifact_id: sourceArtifactId,
    },
    summary: {
      content: `${name} summary`,
      content_digest: name,
      created_at: OLD,
      generation_id: generationId,
      model_id: null,
      payload_json: "{}",
      revision_id: revisionId,
      subject_id: targetNodeId,
      summary_id: createIdentity("summary", { name }),
      summary_kind: "deterministic",
    },
  };
}

function artifact(digit: string, createdAt = OLD) {
  const contentDigest = digit.repeat(64);
  return {
    artifact_id: sourceArtifactIdentity({ contentDigest }),
    byte_length: 1,
    content_bytes: new Uint8Array([Number.parseInt(digit, 16)]),
    content_digest: contentDigest,
    created_at: createdAt,
    kind: "source",
    payload_json: JSON.stringify({ contentDigest }),
  };
}

describe("LanceDB storage recovery and retention", () => {
  test("recovers an empty store and serializes migrations", async () => {
    const storage = await domain();
    const store = await LanceIntelligenceStore.open(storage);
    const migrationFailure = new Error("migration failed");
    await expect(
      store.serializeMigration("failed", async () => {
        throw migrationFailure;
      }),
    ).rejects.toBe(migrationFailure);
    await expect(
      store.putRows("artifacts", [{ artifact_id: "" }]),
    ).rejects.toMatchObject({
      code: "invalid_schema",
      retryable: false,
    });
    expect(await store.serializeMigration("noop", async () => "done")).toBe(
      "done",
    );
    expect(await store.recover()).toMatchObject({
      lastPublishedGenerationId: null,
      resumedJobIds: [],
    });
    await store.shutdownCoordinator();
  });

  test("ignores unpublished versions and resumes idempotent interrupted jobs", async () => {
    const storage = await domain();
    const store = await LanceIntelligenceStore.open(storage);
    const workspaceId = createIdentity("workspace", { name: "recovery" });
    const revisionId = createIdentity("revision", { name: "recovery" });
    const manifestArtifactId = createIdentity("revision-manifest", {
      name: "recovery",
    });

    await store.putRows("artifacts", [artifact("1")]);
    const published = await store.publish({
      manifestArtifactId,
      revisionId,
      workspaceId,
    });
    await store.putRows("artifacts", [artifact("2")]);
    const jobId = createIdentity("job", { name: "running" });
    await store.putRows(
      "jobs",
      [
        {
          attempt: 0,
          created_at: OLD,
          error_code: null,
          idempotency_key: createIdentity("job", { key: "running" }),
          job_id: jobId,
          payload_json: JSON.stringify({
            attempt: 0,
            errorCode: null,
            state: "running",
          }),
          revision_id: revisionId,
          state: "running",
          storage_domain_id: storage.domainId,
          type: "parse",
          updated_at: OLD,
          workspace_id: workspaceId,
        },
      ],
      { immutable: false },
    );

    const recovery = await store.recover();
    expect(recovery.lastPublishedGenerationId).toBe(published.generationId);
    expect(recovery.ignoredUnpublishedTableVersions).toBeGreaterThan(0);
    expect(recovery.resumedJobIds).toEqual([jobId]);
    const jobs = await store.rows("jobs", `job_id = '${jobId}'`);
    expect(jobs[0]).toMatchObject({
      attempt: 1,
      error_code: "recovered_interrupted",
      state: "pending",
    });
    const latest = await store.pinLatestGeneration(
      workspaceId,
      "recovery-reader",
    );
    expect(await latest.rows("artifacts")).toHaveLength(1);
    await latest.close();
    await store.shutdownCoordinator();
  });

  test("publishes structural generations when embedding jobs fail", async () => {
    const storage = await domain();
    const store = await LanceIntelligenceStore.open(storage);
    const workspaceId = createIdentity("workspace", { name: "embedding" });
    const revisionId = createIdentity("revision", { name: "embedding" });
    await store.putRows(
      "jobs",
      [
        {
          attempt: 3,
          created_at: OLD,
          error_code: "model_unavailable",
          idempotency_key: createIdentity("job", { key: "embedding" }),
          job_id: createIdentity("job", { name: "embedding" }),
          payload_json: JSON.stringify({ state: "failed" }),
          revision_id: revisionId,
          state: "failed",
          storage_domain_id: storage.domainId,
          type: "embed",
          updated_at: OLD,
          workspace_id: workspaceId,
        },
      ],
      { immutable: false },
    );
    const generation = await store.publish({
      manifestArtifactId: createIdentity("revision-manifest", {
        name: "embedding",
      }),
      revisionId,
      workspaceId,
    });
    expect(
      generation.tableVersions.find((pin) => pin.table === "embeddings"),
    ).toBeDefined();
    expect(await store.count("embeddings")).toBe(0);
    expect(
      await store.count("jobs", "state = 'failed' AND type = 'embed'"),
    ).toBe(1);
    await store.shutdownCoordinator();
  });

  test("collects unreachable artifacts after seven days and preserves jobs, workspaces, pins, and revisions", async () => {
    const storage = await domain();
    const store = await LanceIntelligenceStore.open(storage);
    const reachable = artifact("3");
    const orphan = artifact("4");
    const jobProtected = artifact("5");
    await store.putRows("artifacts", [reachable, orphan, jobProtected]);

    const repositoryId = createIdentity("repository", { name: "retention" });
    const revisionId = createIdentity("revision", { name: "retention" });
    const workspaceId = createIdentity("workspace", { name: "retention" });
    const manifestId = createIdentity("revision-manifest", {
      name: "retention",
    });
    const protectedGraph = graphBundle(
      "protected",
      reachable.artifact_id,
      revisionId,
    );
    const orphanRevisionId = createIdentity("revision", { name: "orphan" });
    const orphanGraph = graphBundle(
      "orphan",
      orphan.artifact_id,
      orphanRevisionId,
    );
    const syntaxId = createIdentity("syntax-facts", { name: "retention" });
    const relationshipId = createIdentity("resolved-relationships", {
      name: "retention",
    });
    await store.putRows("syntax_facts", [
      {
        artifact_id: syntaxId,
        byte_length: 1,
        created_at: OLD,
        language_id: "typescript",
        parser_fingerprint: "retention",
        payload_json: "{}",
        source_artifact_id: reachable.artifact_id,
      },
    ]);
    await store.putRows("relationships", [
      {
        artifact_id: relationshipId,
        byte_length: 1,
        created_at: OLD,
        environment_fingerprint: "retention",
        payload_json: JSON.stringify({ edgeId: protectedGraph.edge.edge_id }),
        resolver_fingerprint: "retention",
        syntax_facts_artifact_id: syntaxId,
      },
    ]);
    await store.putRows("graph_nodes", [
      ...protectedGraph.nodes,
      ...orphanGraph.nodes,
    ]);
    await store.putRows("graph_occurrences", [
      protectedGraph.occurrence,
      orphanGraph.occurrence,
    ]);
    await store.putRows("graph_edges", [protectedGraph.edge, orphanGraph.edge]);
    await store.putRows("graph_evidence", [
      protectedGraph.evidence,
      orphanGraph.evidence,
    ]);
    await store.putRows("revision_membership", [
      protectedGraph.membership,
      orphanGraph.membership,
    ]);
    await store.putRows("communities", [
      protectedGraph.communities,
      orphanGraph.communities,
    ]);
    await store.putRows("summaries", [
      protectedGraph.summary,
      orphanGraph.summary,
    ]);
    await store.putRows("revision_manifests", [
      {
        artifact_id: manifestId,
        created_at: OLD,
        dirty_overlay_id: null,
        entry_count: 1,
        logical_bytes: 1,
        payload_json: JSON.stringify({
          entries: [
            {
              path: "src/reachable.ts",
              resolvedRelationshipsArtifactId: relationshipId,
              sourceArtifactId: reachable.artifact_id,
              syntaxFactsArtifactId: syntaxId,
            },
          ],
        }),
        repository_id: repositoryId,
        revision_id: revisionId,
      },
    ]);
    await store.putRows(
      "workspaces",
      [
        {
          active: true,
          logical_bytes: 1,
          manifest_artifact_id: manifestId,
          payload_json: JSON.stringify({ manifestArtifactId: manifestId }),
          repository_id: repositoryId,
          revision_id: revisionId,
          storage_domain_id: storage.domainId,
          updated_at: OLD,
          workspace_id: workspaceId,
        },
      ],
      { immutable: false },
    );
    await store.putRows(
      "jobs",
      [
        {
          attempt: 0,
          created_at: OLD,
          error_code: null,
          idempotency_key: createIdentity("job", { key: "retention" }),
          job_id: createIdentity("job", { name: "retention" }),
          payload_json: JSON.stringify({
            artifactId: jobProtected.artifact_id,
          }),
          revision_id: createIdentity("revision", { name: "job" }),
          state: "running",
          storage_domain_id: storage.domainId,
          type: "parse",
          updated_at: OLD,
          workspace_id: createIdentity("workspace", { name: "job" }),
        },
      ],
      { immutable: false },
    );
    const generation = await store.publish({
      manifestArtifactId: manifestId,
      revisionId,
      workspaceId,
    });
    const reader = await store.pinGeneration(generation, "retention-reader");

    const result = await store.collect({
      now: new Date("2026-09-10T00:00:00.000Z"),
    });
    expect(result.deletedByTable.artifacts).toBe(1);
    expect(result.deletedByTable.graph_nodes).toBe(2);
    expect(result.deletedByTable.graph_occurrences).toBe(1);
    expect(result.deletedByTable.graph_edges).toBe(1);
    expect(result.deletedByTable.graph_evidence).toBe(1);
    expect(result.deletedByTable.revision_membership).toBe(1);
    expect(result.deletedByTable.communities).toBe(1);
    expect(result.deletedByTable.summaries).toBe(1);
    const remaining = await store.rows("artifacts");
    expect(remaining.map((row) => row.artifact_id).sort()).toEqual(
      [reachable.artifact_id, jobProtected.artifact_id].sort(),
    );
    expect(await store.count("jobs", "state = 'running'")).toBe(1);
    expect(await store.count("workspaces", "active = true")).toBe(1);
    expect(await store.count("reader_pins")).toBe(1);
    expect(await store.count("graph_nodes")).toBe(2);
    expect(await store.count("graph_occurrences")).toBe(1);
    expect(await store.count("graph_edges")).toBe(1);
    expect(await store.count("graph_evidence")).toBe(1);
    expect(await store.count("revision_membership")).toBe(1);
    expect(await store.count("communities")).toBe(1);
    expect(await store.count("summaries")).toBe(1);
    expect(await reader.rows("artifacts")).toHaveLength(3);
    await reader.close();
    await store.shutdownCoordinator();
  });

  test("applies stored pin, publication, and terminal-job retention", async () => {
    const storage = await domain();
    const store = await LanceIntelligenceStore.open(storage);
    const workspaceId = createIdentity("workspace", { name: "policy" });
    const revisionId = createIdentity("revision", { name: "policy" });
    const manifestArtifactId = createIdentity("revision-manifest", {
      name: "policy",
    });
    const generations = [];
    for (const digit of ["8", "9", "a"]) {
      await store.putRows("artifacts", [artifact(digit)]);
      generations.push(
        await store.publish({ manifestArtifactId, revisionId, workspaceId }),
      );
    }
    const oldestGeneration = generations[0];
    if (!oldestGeneration) throw new Error("Expected a published generation");
    const reader = await store.pinGeneration(
      oldestGeneration,
      "expiring-reader",
      1_000,
    );

    const connection = await lancedb.connect(storage.storagePath, {
      readConsistencyInterval: 0,
    });
    const publicationTable = await connection.openTable("publications");
    for (const [index, generation] of generations.entries()) {
      const publishedAt = `2020-01-0${index + 1}T00:00:00.000Z`;
      await publicationTable.update({
        values: {
          payload_json: JSON.stringify({ ...generation, publishedAt }),
          published_at: publishedAt,
        },
        where: `generation_id = '${generation.generationId}'`,
      });
    }
    publicationTable.close();
    connection.close();

    const retention = (await store.rows("retention"))[0];
    if (!retention) throw new Error("Expected the default retention policy");
    await store.putRows(
      "retention",
      [
        {
          ...retention,
          keep_failed_jobs_for_days: 7,
          keep_published_generations: 1,
          pin_grace_seconds: 10,
          updated_at: "2026-09-10T00:00:00.000Z",
        },
      ],
      { immutable: false },
    );
    const withinGrace = new Date(
      Date.parse(reader.pin.expiresAt) + 5_000,
    ).toISOString();
    const jobRow = (
      name: string,
      state: "running" | "succeeded" | "failed" | "cancelled",
      updatedAt: string,
    ) => ({
      attempt: 1,
      created_at: OLD,
      error_code: state === "failed" ? "fixture" : null,
      idempotency_key: createIdentity("job", { key: name }),
      job_id: createIdentity("job", { name }),
      payload_json: "{}",
      revision_id: revisionId,
      state,
      storage_domain_id: storage.domainId,
      type: "parse",
      updated_at: updatedAt,
      workspace_id: workspaceId,
    });
    await store.putRows(
      "jobs",
      [
        jobRow("active", "running", OLD),
        jobRow("recent-failure", "failed", withinGrace),
        jobRow("old-success", "succeeded", OLD),
        jobRow("old-failure", "failed", OLD),
        jobRow("old-cancelled", "cancelled", OLD),
      ],
      { immutable: false },
    );

    const first = await store.collect({ now: new Date(withinGrace) });
    expect(first.deletedByTable.reader_pins).toBeUndefined();
    expect(first.deletedByTable.publications).toBe(1);
    expect(first.deletedByTable.jobs).toBe(3);
    expect(await store.count("reader_pins")).toBe(1);
    expect(await store.count("publications")).toBe(2);
    expect(await store.count("jobs")).toBe(2);

    const afterGrace = new Date(Date.parse(reader.pin.expiresAt) + 11_000);
    const second = await store.collect({ now: afterGrace });
    expect(second.deletedByTable.reader_pins).toBe(1);
    expect(second.deletedByTable.publications).toBe(1);
    expect(await store.count("reader_pins")).toBe(0);
    expect(await store.count("publications")).toBe(1);
    expect(await store.count("jobs", "state = 'running'")).toBe(1);
    expect(await store.count("jobs", "state = 'failed'")).toBe(1);
    await reader.close();
    await store.shutdownCoordinator();
  });

  test("relocates with file checksums and row-count verification without deleting source", async () => {
    const storage = await domain();
    const store = await LanceIntelligenceStore.open(storage, {
      leaseDurationMs: 60_000,
    });
    await store.putRows("artifacts", [artifact("6")]);
    const destinationParent = await mkdtemp(
      join(tmpdir(), "ast-mcp-relocated-"),
    );
    const destinationPath = join(destinationParent, "store");
    const preview = await store.relocationPreview(destinationPath);
    expect(preview.files.length).toBeGreaterThan(0);
    expect(preview.tableCounts.artifacts).toBe(1);

    const result = await store.relocate(preview);
    expect(result.verified).toBe(true);
    expect(result.sourceDeleted).toBe(false);
    expect(result.destinationFiles).toEqual(preview.files);
    const relocatedDomain: StorageDomain = {
      ...storage,
      domainId: createStorageDomainId({
        engine: "lancedb",
        placement: { kind: "explicit", path: destinationPath },
        pool: "shared",
        storagePath: destinationPath,
      }),
      placement: { kind: "explicit", path: destinationPath },
      storagePath: destinationPath,
    };
    const relocated = await LanceIntelligenceStore.open(relocatedDomain, {
      access: "read-only",
    });
    expect(await relocated.count("artifacts")).toBe(1);
    await relocated.shutdownCoordinator();
    await store.shutdownCoordinator();
  });

  test("rejects invalid relocation coordinates and verification failures", async () => {
    const storage = await domain();
    const store = await LanceIntelligenceStore.open(storage, {
      leaseDurationMs: 60_000,
    });
    await store.putRows("artifacts", [artifact("7")]);

    await expect(
      assertSupportedStoragePath("relative/path"),
    ).rejects.toMatchObject({
      code: "storage_unavailable",
    });
    const missingPath = join(storage.storagePath, "missing", "nested");
    expect(await assertSupportedStoragePath(missingPath)).toBe(missingPath);
    const invalidParent = await mkdtemp(
      join(tmpdir(), "ast-mcp-relocation-invalid-parent-"),
    );
    const blockingFile = join(invalidParent, "file");
    await writeFile(blockingFile, "content");
    await expect(
      assertSupportedStoragePath(join(blockingFile, "child")),
    ).rejects.toMatchObject({
      code: "storage_unavailable",
    });

    if (process.platform !== "win32") {
      const symlinkRoot = await mkdtemp(
        join(tmpdir(), "ast-mcp-relocation-symlink-"),
      );
      const regularFile = join(symlinkRoot, "regular");
      await writeFile(regularFile, "content");
      const symlinkPath = join(symlinkRoot, "link");
      await symlink(regularFile, symlinkPath);
      expect(await snapshotStorageDirectory(symlinkRoot)).toHaveLength(1);
      const symlinkDestinationParent = await mkdtemp(
        join(tmpdir(), "ast-mcp-relocation-symlink-destination-"),
      );
      const symlinkPreview = await store.relocationPreview(
        join(symlinkDestinationParent, "unused"),
      );
      await expect(
        copyRelocationSnapshot({
          ...symlinkPreview,
          destinationPath: join(symlinkDestinationParent, "store"),
          files: [
            {
              path: "link",
              sha256: createHash("sha256").update("content").digest("hex"),
              size: 7,
            },
          ],
          sourcePath: symlinkRoot,
          totalBytes: 7,
        }),
      ).rejects.toMatchObject({ code: "relocation_verification_failed" });
      expect(await readdir(symlinkDestinationParent)).toEqual([]);
    }

    expect(() =>
      validateRelocationCoordinates(storage.storagePath, storage.storagePath),
    ).toThrow("must be disjoint");
    expect(() =>
      validateRelocationCoordinates(
        storage.storagePath,
        join(storage.storagePath, "nested"),
      ),
    ).toThrow("must be disjoint");

    const nonemptyDestination = await mkdtemp(
      join(tmpdir(), "ast-mcp-relocation-nonempty-"),
    );
    await writeFile(join(nonemptyDestination, "marker"), "occupied");
    const nonemptyPreview = await store.relocationPreview(nonemptyDestination);
    await expect(copyRelocationSnapshot(nonemptyPreview)).rejects.toMatchObject(
      {
        code: "storage_unavailable",
      },
    );

    const traversalParent = await mkdtemp(
      join(tmpdir(), "ast-mcp-relocation-traversal-"),
    );
    const traversalDestination = join(traversalParent, "store");
    const traversalPreview =
      await store.relocationPreview(traversalDestination);
    const traversalFile = traversalPreview.files[0];
    if (!traversalFile) throw new Error("Expected relocation files");
    await expect(
      copyRelocationSnapshot({
        ...traversalPreview,
        files: [
          {
            ...traversalFile,
            path: "../escape",
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "relocation_verification_failed" });
    expect(await readdir(traversalParent)).toEqual([]);

    const staleSource = await mkdtemp(
      join(tmpdir(), "ast-mcp-relocation-source-"),
    );
    const staleSourceFile = join(staleSource, "data.lance");
    const originalSource = Buffer.from("before");
    await writeFile(staleSourceFile, originalSource);
    const staleParent = await mkdtemp(
      join(tmpdir(), "ast-mcp-relocation-stale-"),
    );
    const staleDestination = join(staleParent, "store");
    await writeFile(staleSourceFile, "after!");
    await expect(
      copyRelocationSnapshot({
        ...traversalPreview,
        destinationPath: staleDestination,
        files: [
          {
            path: "data.lance",
            sha256: createHash("sha256").update(originalSource).digest("hex"),
            size: originalSource.byteLength,
          },
        ],
        sourcePath: staleSource,
        totalBytes: originalSource.byteLength,
      }),
    ).rejects.toMatchObject({ code: "relocation_verification_failed" });
    expect(await readdir(staleParent)).toEqual([]);

    const checksumParent = await mkdtemp(
      join(tmpdir(), "ast-mcp-relocation-checksum-"),
    );
    const checksumDestination = join(checksumParent, "store");
    const checksumPreview = await store.relocationPreview(checksumDestination);
    const invalidFiles = checksumPreview.files.map((file, index) =>
      index === 0 ? { ...file, sha256: "0".repeat(64) } : file,
    );
    await expect(
      copyRelocationSnapshot({ ...checksumPreview, files: invalidFiles }),
    ).rejects.toMatchObject({ code: "relocation_verification_failed" });
    await expect(stat(checksumDestination)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readdir(checksumParent)).toEqual([]);

    const copyParent = await mkdtemp(
      join(tmpdir(), "ast-mcp-relocation-copy-"),
    );
    const copyDestination = join(copyParent, "store");
    const copyPreview = await store.relocationPreview(copyDestination);
    await expect(
      copyRelocationSnapshot({
        ...copyPreview,
        files: [
          ...copyPreview.files,
          { path: "missing-file", sha256: "0".repeat(64), size: 1 },
        ],
      }),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(copyDestination)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readdir(copyParent)).toEqual([]);

    const raceParent = await mkdtemp(
      join(tmpdir(), "ast-mcp-relocation-race-"),
    );
    const raceDestination = join(raceParent, "store");
    const racePreview = await store.relocationPreview(raceDestination);
    await expect(
      copyRelocationSnapshot(racePreview, async () => {
        await writeFile(raceDestination, "appeared");
      }),
    ).rejects.toMatchObject({ code: "storage_unavailable" });
    expect(await readFile(raceDestination, "utf8")).toBe("appeared");
    expect(await readdir(raceParent)).toEqual(["store"]);

    const countParent = await mkdtemp(
      join(tmpdir(), "ast-mcp-relocation-count-"),
    );
    const countDestination = join(countParent, "store");
    const countPreview = await store.relocationPreview(countDestination);
    await expect(
      copyRelocationSnapshot({
        ...countPreview,
        tableCounts: {
          ...countPreview.tableCounts,
          artifacts: countPreview.tableCounts.artifacts + 1,
        },
      }),
    ).rejects.toMatchObject({ code: "relocation_verification_failed" });
    await expect(stat(countDestination)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readdir(countParent)).toEqual([]);
    await store.shutdownCoordinator();
  });

  test("classifies Windows network paths and canonicalizes path aliases", async () => {
    for (const networkPath of [
      String.raw`\\server\share\index`,
      String.raw`\\?\UNC\server\share\index`,
      "//server/share/index",
    ]) {
      await expect(
        assertSupportedStoragePath(networkPath),
      ).rejects.toMatchObject({
        code: "network_filesystem_unsupported",
      });
    }

    expect(storagePathIdentity(String.raw`C:\Data\INDEX`)).toBe(
      storagePathIdentity(String.raw`c:\data\index`),
    );
    expect(storagePathIdentity(String.raw`\\?\C:\Data\INDEX`)).toBe(
      storagePathIdentity(String.raw`c:\data\index`),
    );
    expect(storagePathIdentity(String.raw`\\?\UNC\server\share\index`)).toBe(
      storagePathIdentity(String.raw`\\SERVER\SHARE\INDEX`),
    );
    expect(() =>
      validateRelocationCoordinates(
        String.raw`C:\Data\Index`,
        String.raw`c:\data\index\nested`,
      ),
    ).toThrow("must be disjoint");
  });

  test("rejects unproven network storage modes", async () => {
    const storage = await domain();
    await expect(
      LanceIntelligenceStore.open(storage, { networkFileSystem: true }),
    ).rejects.toMatchObject({
      code: "network_filesystem_unsupported",
    } satisfies Partial<StorageError>);
  });
});
