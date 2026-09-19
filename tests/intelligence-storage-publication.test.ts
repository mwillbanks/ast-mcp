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
  PublicationReservationSchema,
  RequiredPublicationTablesSchema,
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
  test("rejects malformed publication reservation contracts", async () => {
    expect(
      RequiredPublicationTablesSchema.safeParse(["artifacts", "artifacts"])
        .success,
    ).toBeFalse();

    const domain = await storageDomain("contract-validation");
    const store = await LanceIntelligenceStore.open(domain);
    const base = analyticsFixture(["contract"], [], "contract-validation");
    const revisionId = base.scope.revisionId;
    const reservation = await store.reservePublication({
      manifestArtifactId: manifestId(revisionId),
      requiredTables: ["artifacts"],
      reservationKey: "contract-validation",
      revisionId,
      workspaceId: base.scope.workspaceId,
    });

    expect(
      PublicationReservationSchema.safeParse({
        ...reservation,
        attempt: undefined,
      }).success,
    ).toBeFalse();
    expect(
      PublicationReservationSchema.safeParse({
        ...reservation,
        generationId: "f".repeat(64),
      }).success,
    ).toBeFalse();
    expect(
      PublicationReservationSchema.safeParse({
        ...reservation,
        expiresAt: reservation.reservedAt,
      }).success,
    ).toBeFalse();
    expect(
      PublicationReservationSchema.safeParse({
        ...reservation,
        state: "abandoned",
      }).success,
    ).toBeFalse();
    await expect(
      store.recordGenerationArtifacts(reservation, "chunks", []),
    ).rejects.toMatchObject({ code: "publication_conflict" });
    expect(Number.isNaN(Date.parse(store.currentTimestamp()))).toBeFalse();
    await store.shutdownCoordinator();
  });

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
          row.publication_generation_id === null &&
          row.generation_id === reservation.generationId,
      ),
    ).toBe(true);

    const [generation, duplicateGeneration] = await Promise.all([
      store.finalizePublication(reservation),
      store.finalizePublication(reservation),
    ]);
    expect(generation.generationId).toBe(reservation.generationId);
    expect(generation.publicationProtocol).toBe("reservation-v2");
    expect(
      await store.count(
        "generation_artifacts",
        `generation_id = '${generation.generationId}'`,
      ),
    ).toBeGreaterThan(0);
    expect(generation.tableVersions).toHaveLength(15);
    expect(duplicateGeneration).toEqual(generation);
    expect(
      await store.reusablePublication({
        manifestArtifactId: reservation.manifestArtifactId,
        requiredTables: reservation.requiredTables,
        reservationKey: reservation.reservationKey,
        revisionId: reservation.revisionId,
        workspaceId: reservation.workspaceId,
      }),
    ).toEqual(generation);

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
    const inputFingerprint = reservation.inputFingerprint;
    if (!inputFingerprint) throw new Error("missing input fingerprint");
    const distinctReservations = await Promise.all([
      store.reservePublication({
        ...reservation,
        inputFingerprint,
        manifestArtifactId: manifestId(
          createIdentity("revision", { activeManifest: "different" }),
        ),
      }),
      store.reservePublication({
        ...reservation,
        inputFingerprint,
        requiredTables: ["chunks"],
      }),
      store.reservePublication({
        ...reservation,
        inputFingerprint,
        reservationKey: "different-active-key",
      }),
    ]);
    expect(
      distinctReservations.every(
        (candidate) => candidate.generationId !== reservation.generationId,
      ),
    ).toBeTrue();
    expect(distinctReservations.map(({ attempt }) => attempt)).toEqual([
      1, 1, 1,
    ]);
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

  test("skips malformed matching reuse candidates", async () => {
    const base = analyticsFixture(["malformed"], [], "malformed-candidates");
    const request = {
      manifestArtifactId: manifestId(base.scope.revisionId),
      requiredTables: ["artifacts"] as const,
      reservationKey: "malformed-candidates",
      revisionId: base.scope.revisionId,
      workspaceId: base.scope.workspaceId,
    };

    const activeStore = await LanceIntelligenceStore.open(
      await storageDomain("malformed-active"),
    );
    const active = await activeStore.reservePublication(request);
    const activeRow = (
      await activeStore.rows(
        "publications",
        `generation_id = '${active.generationId}'`,
      )
    )[0];
    if (!activeRow) throw new Error("missing active publication");
    const invalidActiveGenerationId = "c".repeat(64);
    const invalidActiveTableVersionId = "d".repeat(64);
    await activeStore.putRows("publications", [
      {
        ...activeRow,
        generation_id: invalidActiveGenerationId,
        payload_json: JSON.stringify({
          ...active,
          attempt: 100,
          generationId: "invalid",
        }),
      },
      {
        ...activeRow,
        generation_id: invalidActiveTableVersionId,
        payload_json: JSON.stringify({
          ...active,
          attempt: 101,
          generationId: invalidActiveTableVersionId,
          tableVersions: [{ table: "artifacts", version: "invalid" }],
        }),
        table_versions_json: JSON.stringify([
          { table: "artifacts", version: "invalid" },
        ]),
      },
    ]);
    expect(await activeStore.reservePublication(request)).toEqual(active);
    await activeStore.shutdownCoordinator();

    const publishedStore = await LanceIntelligenceStore.open(
      await storageDomain("malformed-published"),
    );
    const reservation = await publishedStore.reservePublication(request);
    await publishedStore.putReservedRows(reservation, "artifacts", [
      sourceRow(createIdentity("source", { malformedCandidate: true })),
    ]);
    const generation = await publishedStore.finalizePublication(reservation);
    const publishedRow = (
      await publishedStore.rows(
        "publications",
        `generation_id = '${generation.generationId}'`,
      )
    )[0];
    if (!publishedRow) throw new Error("missing published generation");
    const invalidPublishedGenerationId = "e".repeat(64);
    const invalidPublishedTableVersionId = "f".repeat(64);
    await publishedStore.putRows("publications", [
      {
        ...publishedRow,
        generation_id: invalidPublishedGenerationId,
        payload_json: JSON.stringify({
          ...generation,
          generationId: "invalid",
          publishedAt: "9999-12-31T23:59:59.999Z",
        }),
      },
      {
        ...publishedRow,
        generation_id: invalidPublishedTableVersionId,
        payload_json: JSON.stringify({
          ...generation,
          generationId: invalidPublishedTableVersionId,
          publishedAt: "9999-12-31T23:59:59.998Z",
          tableVersions: [{ table: "artifacts", version: "invalid" }],
        }),
        table_versions_json: JSON.stringify([
          { table: "artifacts", version: "invalid" },
        ]),
      },
    ]);
    expect(await publishedStore.reusablePublication(request)).toEqual(
      generation,
    );
    await publishedStore.shutdownCoordinator();
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

  test("retries terminal attempts without mutating shared artifacts", async () => {
    const domain = await storageDomain("retry-membership");
    let current = new Date("2026-09-10T00:00:00.000Z");
    const store = await LanceIntelligenceStore.open(domain, {
      now: () => current,
    });
    const revisionId = createIdentity("revision", { retry: true });
    const workspaceId = createIdentity("workspace", { retry: true });
    const artifactId = createIdentity("source", { shared: true });
    const request = {
      manifestArtifactId: manifestId(revisionId),
      requiredTables: ["artifacts"] as const,
      reservationKey: "retry-membership",
      revisionId,
      workspaceId,
    };

    const first = await store.reservePublication(request);
    await store.putReservedRows(first, "artifacts", [sourceRow(artifactId)]);
    await store.abandonPublication(first, "retry requested");

    current = new Date("2026-09-10T00:00:01.000Z");
    const second = await store.reservePublication(request);
    expect(second.attempt).toBe(2);
    expect(second.generationId).not.toBe(first.generationId);
    expect(second.inputFingerprint).toBe(first.inputFingerprint);
    await store.putReservedRows(second, "artifacts", [
      {
        ...sourceRow(artifactId),
        created_at: current.toISOString(),
      },
    ]);
    const generation = await store.finalizePublication(second);
    expect(await store.reusablePublication(request)).toEqual(generation);
    const inputFingerprint = generation.inputFingerprint;
    if (!inputFingerprint) throw new Error("missing input fingerprint");
    await Promise.all(
      [
        {
          ...request,
          inputFingerprint,
          workspaceId: createIdentity("workspace", { different: true }),
        },
        {
          ...request,
          inputFingerprint,
          revisionId: createIdentity("revision", { different: true }),
        },
        {
          ...request,
          inputFingerprint,
          manifestArtifactId: manifestId(
            createIdentity("revision", { manifest: "different" }),
          ),
        },
        {
          ...request,
          inputFingerprint,
          requiredTables: ["chunks"] as const,
        },
        {
          ...request,
          inputFingerprint,
          reservationKey: "different",
        },
      ].map(async (candidate) =>
        expect(await store.reusablePublication(candidate)).toBeNull(),
      ),
    );

    const artifacts = await store.rows(
      "artifacts",
      `artifact_id = '${artifactId}'`,
    );
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.created_at).toBe("2026-09-10T00:00:00.000Z");
    expect(artifacts[0]?.publication_generation_id).toBeNull();
    expect(
      await store.count(
        "generation_artifacts",
        `artifact_id = '${artifactId}'`,
      ),
    ).toBe(2);

    const reader = await store.pinGeneration(generation, "retry-reader");
    expect(await reader.rows("artifacts")).toHaveLength(1);
    await reader.close();

    await store.putRows("retention", [
      {
        keep_failed_jobs_for_days: 7,
        keep_published_generations: 2,
        payload_json: "{}",
        pin_grace_seconds: 30,
        policy_id: "newer-retention-policy",
        preserve_reader_pins: true,
        unreachable_artifact_days: 30,
        updated_at: "2026-09-11T00:00:00.000Z",
      },
    ]);
    const collected = await store.collect({
      keepPublishedGenerations: 1,
      now: current,
      unreachableArtifactDays: 0,
    });
    expect(collected.deletedByTable.generation_artifacts).toBe(1);
    expect(
      await store.count(
        "generation_artifacts",
        `artifact_id = '${artifactId}'`,
      ),
    ).toBe(1);
    expect(await store.count("artifacts")).toBe(1);
    await store.shutdownCoordinator();
  });

  test("rejects reusable publications from another storage domain", async () => {
    const local = await LanceIntelligenceStore.open(
      await storageDomain("reuse-local"),
    );
    const foreign = await LanceIntelligenceStore.open(
      await storageDomain("reuse-foreign"),
    );
    const base = analyticsFixture(["reuse"], [], "cross-domain-reuse");
    const inputFingerprint = "a".repeat(64);
    const request = {
      inputFingerprint,
      manifestArtifactId: manifestId(base.scope.revisionId),
      requiredTables: ["artifacts"] as const,
      reservationKey: "cross-domain-reuse",
      revisionId: base.scope.revisionId,
      workspaceId: base.scope.workspaceId,
    };
    const reservation = await foreign.reservePublication(request);
    await foreign.putReservedRows(reservation, "artifacts", [
      sourceRow(createIdentity("source", { foreign: true })),
    ]);
    const generation = await foreign.finalizePublication(reservation);
    const row = (
      await foreign.rows(
        "publications",
        `generation_id = '${generation.generationId}'`,
      )
    )[0];
    if (!row) throw new Error("missing foreign publication");
    await local.putRows("publications", [row]);

    expect(await local.reusablePublication(request)).toBeNull();
    await foreign.shutdownCoordinator();
    await local.shutdownCoordinator();
  });

  test("upgrades legacy tagged immutable content without removing its tag", async () => {
    const store = await LanceIntelligenceStore.open(
      await storageDomain("legacy-tag-upgrade"),
    );
    const base = analyticsFixture(["legacy"], [], "legacy-tag-upgrade");
    const legacyGenerationId = createIdentity("generation", {
      legacy: "tagged-content",
    });
    const artifactId = createIdentity("source", { legacy: "shared-content" });
    await store.putRows("artifacts", [
      {
        ...sourceRow(artifactId),
        publication_generation_id: legacyGenerationId,
      },
    ]);
    const reservation = await store.reservePublication({
      manifestArtifactId: manifestId(base.scope.revisionId),
      requiredTables: ["artifacts"],
      reservationKey: "legacy-tag-upgrade",
      revisionId: base.scope.revisionId,
      workspaceId: base.scope.workspaceId,
    });
    await store.putReservedRows(reservation, "artifacts", [
      {
        ...sourceRow(artifactId),
        created_at: "2026-09-11T00:00:00.000Z",
      },
    ]);
    const stored = await store.rows(
      "artifacts",
      `artifact_id = '${artifactId}'`,
    );
    expect(stored).toHaveLength(1);
    expect(stored[0]?.publication_generation_id).toBe(legacyGenerationId);

    const generation = await store.finalizePublication(reservation);
    const reader = await store.pinGeneration(
      generation,
      "legacy-upgrade-reader",
    );
    expect(await reader.rows("artifacts")).toHaveLength(1);
    await reader.close();
    await store.shutdownCoordinator();
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
    const ordering: string[] = [];
    const store = await LanceIntelligenceStore.open(domain, {
      now: () => {
        ordering.push("now");
        return new Date("2026-09-10T00:00:00.000Z");
      },
    });
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
    const fence = store.coordinator.fence.bind(store.coordinator);
    store.coordinator.fence = async (lease) => {
      ordering.push("fence:start");
      await fence(lease);
      ordering.push("fence:end");
    };
    ordering.length = 0;
    const generation = await store.finalizePublication(reservation);
    expect(generation.requiredTables).toEqual(["communities", "summaries"]);
    expect(ordering.at(-1)).toBe("now");
    expect(ordering.lastIndexOf("fence:end")).toBeLessThan(
      ordering.lastIndexOf("now"),
    );
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
      let generationLinkLoads = 0;
      const rows = store.rows.bind(store);
      const count = store.count.bind(store);
      store.rows = async (...args) => {
        if (args[0] === "generation_artifacts") {
          generationLinkLoads++;
          expect(args[2]?.timeoutMs).toBeGreaterThan(0);
          expect(args[2]?.timeoutMs).toBeLessThanOrEqual(5_000);
        }
        return rows(...args);
      };
      store.count = async (...args) => {
        if (args[0] === "generation_artifacts")
          throw new Error("generation membership must not use per-row counts");
        return count(...args);
      };
      await expect(
        store.verifyLatestGeneration(workspaceId, revisionId, {
          timeoutMs: 5_000,
        }),
      ).rejects.toMatchObject({ code: scenario.expectedCode });
      expect(generationLinkLoads).toBe(1);
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
    expect(migrations).toHaveLength(2);
    expect(
      migrations.map((row) => JSON.parse(String(row.payload_json))),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          migratedTables: ["artifacts"],
          migration: "publication-generation-tag-v1",
          state: "completed",
        }),
        expect.objectContaining({
          migration: "generation-artifacts-v2",
          state: "completed",
        }),
      ]),
    );
    await store.shutdownCoordinator();

    const reopened = await LanceIntelligenceStore.open(domain);
    expect(await reopened.count("migrations", "state = 'completed'")).toBe(2);
    expect(
      await reopened.count("artifacts", `artifact_id = '${artifactId}'`),
    ).toBe(1);
    await reopened.shutdownCoordinator();
  });
});
