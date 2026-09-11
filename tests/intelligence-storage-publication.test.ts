import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import { Schema } from "apache-arrow";
import { analyzeGraph } from "../src/intelligence/analytics/analytics.ts";
import { LanceAnalyticsRepository } from "../src/intelligence/analytics/repository.ts";
import { revisionManifestArtifactIdentity } from "../src/intelligence/contracts/artifacts.ts";
import {
  createIdentity,
  INTELLIGENCE_SCHEMA_VERSION,
} from "../src/intelligence/contracts/common.ts";
import { revisionMembershipIdentity } from "../src/intelligence/contracts/graph.ts";
import {
  createStorageDomainId,
  PublicationGenerationSchema,
  type PublicationReservation,
  type StorageDomain,
} from "../src/intelligence/contracts/storage.ts";
import { GraphSnapshotSchema } from "../src/intelligence/graph/types.ts";
import {
  LanceIntelligenceStore,
  type StorageRow,
} from "../src/intelligence/storage/index.ts";
import { TABLE_SCHEMAS } from "../src/intelligence/storage/schemas.ts";
import type { WorkspaceHandle } from "../src/intelligence/workspace/context.ts";
import { analyticsFixture } from "./fixtures/intelligence/analytics/fixture.ts";

async function storageDomain(suffix = "primary"): Promise<StorageDomain> {
  const storagePath = await mkdtemp(
    join(tmpdir(), `ast-mcp-publication-${suffix}-`),
  );
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

function manifestId(revisionId: string): string {
  return createIdentity("revision-manifest", { revisionId });
}

function rebindGeneration(
  snapshot: ReturnType<typeof analyticsFixture>,
  generationId: string,
) {
  const memberships = snapshot.memberships.map((membership) => {
    const identity = {
      entityId: membership.entityId,
      entityKind: membership.entityKind,
      generationId,
      revisionId: membership.revisionId,
    };
    return {
      ...membership,
      generationId,
      membershipId: revisionMembershipIdentity(identity),
    };
  });
  return GraphSnapshotSchema.parse({
    ...snapshot,
    memberships,
    scope: { ...snapshot.scope, generationId },
  });
}

function workspace(
  snapshot: ReturnType<typeof analyticsFixture>,
): WorkspaceHandle {
  return {
    repositoryId: snapshot.scope.repositoryId,
    selectedRevision: { revisionId: snapshot.scope.revisionId },
    workspaceId: snapshot.scope.workspaceId,
    writeEligibility: { eligible: true },
  } as unknown as WorkspaceHandle;
}

function sourceRow(id: string): StorageRow {
  return {
    artifact_id: id,
    byte_length: 3,
    content_bytes: new TextEncoder().encode("one"),
    content_digest: "a".repeat(64),
    created_at: "2026-09-10T00:00:00.000Z",
    kind: "source",
    payload_json: "{}",
  };
}

describe("publication reservation protocol", () => {
  test("reserves, writes analytics, finalizes, pins, and reloads after restart", async () => {
    const domain = await storageDomain();
    const base = analyticsFixture(
      ["guide", "api"],
      [{ source: "guide", target: "api" }],
      "reserved-analytics",
    );
    const store = await LanceIntelligenceStore.open(domain);
    const reservation = await store.reservePublication({
      manifestArtifactId: manifestId(base.scope.revisionId),
      requiredTables: ["communities", "summaries"],
      reservationKey: "analytics-index-v1",
      revisionId: base.scope.revisionId,
      workspaceId: base.scope.workspaceId,
    });
    const snapshot = rebindGeneration(base, reservation.generationId);
    const result = analyzeGraph({ snapshot });
    const repository = new LanceAnalyticsRepository(store);

    await Promise.all([
      repository.persist(result, reservation, workspace(snapshot)),
      repository.persist(result, reservation, workspace(snapshot)),
    ]);
    const taggedRows = await store.rows("communities");
    expect(taggedRows).toHaveLength(result.communities.length);
    expect(
      taggedRows.every(
        (row) =>
          row.publication_generation_id === reservation.generationId &&
          row.generation_id === reservation.generationId,
      ),
    ).toBe(true);

    const [generation, duplicateGeneration] = await Promise.all([
      store.finalizePublication(reservation),
      store.finalizePublication(reservation),
    ]);
    expect(generation.generationId).toBe(reservation.generationId);
    expect(generation.publicationProtocol).toBe("reservation-v1");
    expect(generation.tableVersions).toHaveLength(15);
    expect(duplicateGeneration).toEqual(generation);

    const reader = await store.pinGeneration(generation, "analytics-reader");
    expect(await repository.load(reader, workspace(snapshot))).toEqual(
      result.communities,
    );
    const visibleBefore = await reader.rows("communities");
    const original = taggedRows[0];
    if (!original) throw new Error("missing persisted community");
    await store.putRows("communities", [
      {
        ...original,
        community_id: createIdentity("stored-community", { late: true }),
      },
    ]);
    expect(await reader.rows("communities")).toEqual(visibleBefore);
    await reader.close();
    await store.shutdownCoordinator();

    const reopened = await LanceIntelligenceStore.open(domain);
    const restartedReader = await reopened.pinLatestGeneration(
      base.scope.workspaceId,
      "restart-reader",
    );
    expect(restartedReader.pin.generationId).toBe(reservation.generationId);
    expect(
      await new LanceAnalyticsRepository(reopened).load(
        restartedReader,
        workspace(snapshot),
      ),
    ).toEqual(result.communities);
    await restartedReader.close();
    await reopened.shutdownCoordinator();
  });

  test("rejects mismatched, abandoned, finalized, and cross-domain writes", async () => {
    const domain = await storageDomain("guards");
    const secondDomain = await storageDomain("other");
    const base = analyticsFixture(["one"], [], "guards");
    const store = await LanceIntelligenceStore.open(domain);
    const reservation = await store.reservePublication({
      manifestArtifactId: manifestId(base.scope.revisionId),
      requiredTables: ["artifacts"],
      reservationKey: "guarded",
      revisionId: base.scope.revisionId,
      workspaceId: base.scope.workspaceId,
    });
    const [duplicate, concurrentDuplicate] = await Promise.all([
      store.reservePublication({
        manifestArtifactId: reservation.manifestArtifactId,
        requiredTables: ["artifacts"],
        reservationKey: reservation.reservationKey,
        revisionId: reservation.revisionId,
        workspaceId: reservation.workspaceId,
      }),
      store.reservePublication({
        manifestArtifactId: reservation.manifestArtifactId,
        requiredTables: ["artifacts"],
        reservationKey: reservation.reservationKey,
        revisionId: reservation.revisionId,
        workspaceId: reservation.workspaceId,
      }),
    ]);
    expect(duplicate).toEqual(reservation);
    expect(concurrentDuplicate).toEqual(reservation);
    await expect(store.finalizePublication(reservation)).rejects.toMatchObject({
      code: "publication_conflict",
    });
    await expect(
      store.putReservedRows(reservation, "artifacts", [
        {
          ...sourceRow(createIdentity("source", { bad: true })),
          publication_generation_id: createIdentity("generation", {
            wrong: true,
          }),
        },
      ]),
    ).rejects.toMatchObject({ code: "publication_conflict" });

    await store.putReservedRows(reservation, "artifacts", [
      sourceRow(createIdentity("source", { good: true })),
    ]);
    await store.recordReservedTableVersion(reservation, "artifacts");
    const generation = await store.finalizePublication(reservation);
    expect(
      PublicationGenerationSchema.safeParse({
        ...generation,
        publicationProtocol: "legacy-v1",
      }).success,
    ).toBe(false);
    await expect(
      store.putReservedRows(reservation, "artifacts", [
        sourceRow(createIdentity("source", { late: true })),
      ]),
    ).rejects.toMatchObject({ code: "publication_finalized" });

    await expect(
      store.pinGeneration(reservation as unknown as typeof generation, "bad"),
    ).rejects.toThrow();
    const otherStore = await LanceIntelligenceStore.open(secondDomain);
    await expect(
      otherStore.putReservedRows(reservation, "artifacts", [
        sourceRow(createIdentity("source", { cross: true })),
      ]),
    ).rejects.toMatchObject({ code: "publication_conflict" });

    const abandoned = await store.reservePublication({
      manifestArtifactId: manifestId(
        createIdentity("revision", { abandoned: true }),
      ),
      requiredTables: ["artifacts"],
      reservationKey: "abandoned",
      revisionId: createIdentity("revision", { abandoned: true }),
      workspaceId: createIdentity("workspace", { abandoned: true }),
    });
    const abandonedRecord = await store.abandonPublication(
      abandoned,
      "refresh failed",
    );
    expect(abandonedRecord.state).toBe("abandoned");
    await expect(store.finalizePublication(abandoned)).rejects.toMatchObject({
      code: "publication_abandoned",
    });
    await expect(
      store.putReservedRows(
        { ...reservation, workspaceId: abandoned.workspaceId },
        "artifacts",
        [],
      ),
    ).rejects.toThrow();

    await otherStore.shutdownCoordinator();
    await store.shutdownCoordinator();
  });

  test("recovers stale reservations and retention removes abandoned records", async () => {
    const domain = await storageDomain("recovery");
    let current = new Date("2026-09-10T00:00:00.000Z");
    const store = await LanceIntelligenceStore.open(domain, {
      now: () => current,
    });
    const revisionId = createIdentity("revision", { stale: true });
    const reservation = await store.reservePublication({
      manifestArtifactId: manifestId(revisionId),
      requiredTables: ["artifacts"],
      reservationKey: "stale",
      revisionId,
      ttlMs: 10,
      workspaceId: createIdentity("workspace", { stale: true }),
    });
    await store.putReservedRows(reservation, "artifacts", [
      sourceRow(createIdentity("source", { stale: true })),
    ]);
    await store.shutdownCoordinator();
    current = new Date("2026-09-10T00:00:01.000Z");
    const reopened = await LanceIntelligenceStore.open(domain, {
      now: () => current,
    });
    const recovery = await reopened.recover();
    expect(recovery.abandonedReservationIds).toEqual([
      reservation.generationId,
    ]);
    expect(await reopened.latestGeneration(reservation.workspaceId)).toBeNull();
    await expect(
      reopened.finalizePublication(reservation),
    ).rejects.toMatchObject({
      code: "publication_abandoned",
    });

    const collection = await reopened.collect({
      keepPublishedGenerations: 1,
      maxDeletesPerTable: 100,
      now: current,
      unreachableArtifactDays: 0,
    });
    expect(collection.deletedByTable.publications).toBe(1);
    expect(
      await reopened.count(
        "publications",
        `generation_id = '${reservation.generationId}'`,
      ),
    ).toBe(0);
    await reopened.shutdownCoordinator();
  });

  test("rejects invalid reservation identities and stale tokens before writes", async () => {
    const domain = await storageDomain("stale");
    let current = new Date("2026-09-10T00:00:00.000Z");
    const store = await LanceIntelligenceStore.open(domain, {
      now: () => current,
    });
    const revisionId = createIdentity("revision", { staleToken: true });
    const reservation = await store.reservePublication({
      manifestArtifactId: manifestId(revisionId),
      requiredTables: ["artifacts"],
      reservationKey: "stale-token",
      revisionId,
      ttlMs: 1,
      workspaceId: createIdentity("workspace", { staleToken: true }),
    });
    current = new Date("2026-09-10T00:00:00.010Z");
    await expect(
      store.putReservedRows(reservation, "artifacts", []),
    ).rejects.toMatchObject({ code: "publication_stale" });
    await expect(
      store.putReservedRows(
        {
          ...reservation,
          revisionId: createIdentity("revision", { forged: true }),
        } as PublicationReservation,
        "artifacts",
        [],
      ),
    ).rejects.toThrow();
    await store.shutdownCoordinator();
  });
  test("blocks finalization until delayed required producers are ready", async () => {
    const domain = await storageDomain("producer-readiness");
    const store = await LanceIntelligenceStore.open(domain);
    const revisionId = createIdentity("revision", { readiness: true });
    const reservation = await store.reservePublication({
      manifestArtifactId: manifestId(revisionId),
      requiredTables: ["communities", "summaries"],
      reservationKey: "producer-readiness",
      revisionId,
      workspaceId: createIdentity("workspace", { readiness: true }),
    });
    const communityId = createIdentity("stored-community", { readiness: true });
    await store.putReservedRows(reservation, "communities", [
      {
        algorithm: "test@1",
        community_id: communityId,
        created_at: "2026-09-10T00:00:00.000Z",
        generation_id: reservation.generationId,
        member_ids_json: "[]",
        payload_json: "{}",
        resolution: 1,
        revision_id: revisionId,
      },
    ]);

    let releaseSummary!: () => void;
    const summaryGate = new Promise<void>((resolve) => {
      releaseSummary = resolve;
    });
    const delayedSummary = (async () => {
      await summaryGate;
      await store.putReservedRows(reservation, "summaries", [
        {
          content: "ready",
          content_digest: "b".repeat(64),
          created_at: "2026-09-10T00:00:00.000Z",
          generation_id: reservation.generationId,
          model_id: null,
          payload_json: "{}",
          revision_id: revisionId,
          subject_id: communityId,
          summary_id: createIdentity("stored-summary", { readiness: true }),
          summary_kind: "deterministic-community",
        },
      ]);
    })();

    await expect(store.finalizePublication(reservation)).rejects.toMatchObject({
      code: "publication_conflict",
      details: { missingTables: ["summaries"] },
    });
    expect(await store.latestGeneration(reservation.workspaceId)).toBeNull();
    releaseSummary();
    await delayedSummary;
    const generation = await store.finalizePublication(reservation);
    expect(generation.requiredTables).toEqual(["communities", "summaries"]);
    await store.shutdownCoordinator();
  });

  test("rejects malformed and inconsistent published manifest payloads", async () => {
    const cases = [
      {
        expectedCode: "mixed_generation",
        mutate: () => ({ omitManifestArtifact: true }),
        name: "missing manifest artifact",
      },
      {
        expectedCode: "invalid_schema",
        mutate: () => ({ manifestArtifactKind: "source" as const }),
        name: "wrong manifest artifact kind",
      },
      {
        expectedCode: "invalid_schema",
        mutate: () => ({ payloadJson: "{" }),
        name: "malformed JSON",
      },
      {
        expectedCode: "mixed_generation",
        mutate: () => ({
          repositoryId: createIdentity("repository", { wrong: true }),
        }),
        name: "repository coordinate",
      },
      {
        expectedCode: "mixed_generation",
        mutate: () => ({
          dirtyOverlayId: createIdentity("dirty-overlay", { wrong: true }),
        }),
        name: "dirty overlay coordinate",
      },
      {
        expectedCode: "mixed_generation",
        mutate: () => ({ entryCount: 1 }),
        name: "entry count",
      },
      {
        expectedCode: "mixed_generation",
        mutate: () => ({
          payloadRepositoryId: createIdentity("repository", { payload: true }),
        }),
        name: "recomputed identity",
      },
    ] as const;

    for (const scenario of cases) {
      const domain = await storageDomain(
        `manifest-${scenario.name.replaceAll(" ", "-")}`,
      );
      const store = await LanceIntelligenceStore.open(domain);
      const repositoryId = createIdentity("repository", {
        scenario: scenario.name,
      });
      const revisionId = createIdentity("revision", {
        scenario: scenario.name,
      });
      const workspaceId = createIdentity("workspace", {
        scenario: scenario.name,
      });
      const basePayload = {
        dirtyOverlayId: null,
        entries: [],
        repositoryId,
        revisionId,
      };
      const artifactId = revisionManifestArtifactIdentity(basePayload);
      const mutation = scenario.mutate() as {
        dirtyOverlayId?: string;
        entryCount?: number;
        manifestArtifactKind?: "source";
        omitManifestArtifact?: boolean;
        payloadJson?: string;
        payloadRepositoryId?: string;
        repositoryId?: string;
      };
      const payload = {
        ...basePayload,
        repositoryId: mutation.payloadRepositoryId ?? repositoryId,
      };
      const persistedPayload = JSON.stringify(basePayload);
      const manifestArtifactRows = mutation.omitManifestArtifact
        ? []
        : [
            {
              artifact_id: artifactId,
              byte_length: Buffer.byteLength(persistedPayload),
              content_bytes: null,
              content_digest: createHash("sha256")
                .update(persistedPayload)
                .digest("hex"),
              created_at: "2026-09-10T00:00:00.000Z",
              kind: mutation.manifestArtifactKind ?? "revision-manifest",
              payload_json: persistedPayload,
            },
          ];
      const reservation = await store.reservePublication({
        manifestArtifactId: artifactId,
        requiredTables: ["artifacts", "revision_manifests"],
        reservationKey: `manifest-${scenario.name}`,
        revisionId,
        workspaceId,
      });
      await store.putReservedRowsBatch(reservation, [
        { rows: manifestArtifactRows, tableName: "artifacts" },
        {
          rows: [
            {
              artifact_id: artifactId,
              created_at: "2026-09-10T00:00:00.000Z",
              dirty_overlay_id: mutation.dirtyOverlayId ?? null,
              entry_count: mutation.entryCount ?? 0,
              logical_bytes: 0,
              payload_json: mutation.payloadJson ?? JSON.stringify(payload),
              repository_id: mutation.repositoryId ?? repositoryId,
              revision_id: revisionId,
            },
          ],
          tableName: "revision_manifests",
        },
      ]);
      await store.finalizePublication(reservation);
      await expect(
        store.verifyLatestGeneration(workspaceId, revisionId),
      ).rejects.toMatchObject({ code: scenario.expectedCode });
      await store.shutdownCoordinator();
    }
  });

  test("migrates populated pre-publication schemas once and preserves rows", async () => {
    const domain = await storageDomain("legacy-schema");
    const connection = await lancedb.connect(domain.storagePath);
    const legacySchema = new Schema(
      TABLE_SCHEMAS.artifacts.fields.filter(
        (field) => field.name !== "publication_generation_id",
      ),
    );
    const legacyTable = await connection.createEmptyTable(
      "artifacts",
      legacySchema,
    );
    const artifactId = createIdentity("source", { legacy: true });
    await legacyTable.add([sourceRow(artifactId)]);
    legacyTable.close();
    connection.close();

    const store = await LanceIntelligenceStore.open(domain);
    const migrated = await store.rows(
      "artifacts",
      `artifact_id = '${artifactId}'`,
    );
    expect(migrated).toHaveLength(1);
    expect(migrated[0]?.publication_generation_id).toBeNull();
    const migrations = await store.rows("migrations", "state = 'completed'");
    expect(migrations).toHaveLength(1);
    expect(JSON.parse(String(migrations[0]?.payload_json))).toMatchObject({
      migratedTables: ["artifacts"],
      migration: "publication-generation-tag-v1",
      state: "completed",
    });
    await store.shutdownCoordinator();

    const reopened = await LanceIntelligenceStore.open(domain);
    expect(await reopened.count("migrations", "state = 'completed'")).toBe(1);
    expect(
      await reopened.count("artifacts", `artifact_id = '${artifactId}'`),
    ).toBe(1);
    await reopened.shutdownCoordinator();
  });
});
