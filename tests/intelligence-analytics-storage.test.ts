import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeGraph } from "../src/intelligence/analytics/analytics.ts";
import { LanceAnalyticsRepository } from "../src/intelligence/analytics/repository.ts";
import {
  createIdentity,
  INTELLIGENCE_SCHEMA_VERSION,
} from "../src/intelligence/contracts/common.ts";
import { revisionMembershipIdentity } from "../src/intelligence/contracts/graph.ts";
import {
  createStorageDomainId,
  type PublicationReservation,
  type StorageDomain,
} from "../src/intelligence/contracts/storage.ts";
import { GraphSnapshotSchema } from "../src/intelligence/graph/types.ts";
import {
  LanceIntelligenceStore,
  type PinnedGenerationReader,
} from "../src/intelligence/storage/store.ts";
import type { WorkspaceHandle } from "../src/intelligence/workspace/context.ts";
import { analyticsFixture } from "./fixtures/intelligence/analytics/fixture.ts";

async function domain(): Promise<StorageDomain> {
  const storagePath = await mkdtemp(join(tmpdir(), "ast-mcp-analytics-"));
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

function workspace(
  result: ReturnType<typeof analyzeGraph>,
  eligible = true,
): WorkspaceHandle {
  return {
    repositoryId: result.scope.repositoryId,
    selectedRevision: { revisionId: result.scope.revisionId },
    workspaceId: result.scope.workspaceId,
    writeEligibility: eligible ? { eligible: true } : { eligible: false },
  } as unknown as WorkspaceHandle;
}

function reader(
  store: LanceIntelligenceStore,
  result: ReturnType<typeof analyzeGraph>,
  overrides: Partial<{
    generationId: string;
    revisionId: string;
    workspaceId: string;
  }> = {},
): PinnedGenerationReader {
  return {
    pin: {
      generationId: overrides.generationId ?? result.scope.generationId,
      revisionId: overrides.revisionId ?? result.scope.revisionId,
      workspaceId: overrides.workspaceId ?? result.scope.workspaceId,
    },
    rows: (table: Parameters<LanceIntelligenceStore["rows"]>[0]) =>
      store.rows(table),
  } as unknown as PinnedGenerationReader;
}

async function prepare(
  store: LanceIntelligenceStore,
  snapshot: ReturnType<typeof analyticsFixture>,
  seed?: number,
): Promise<{
  reservation: PublicationReservation;
  result: ReturnType<typeof analyzeGraph>;
}> {
  const reservation = await store.reservePublication({
    manifestArtifactId: createIdentity("revision-manifest", {
      revisionId: snapshot.scope.revisionId,
    }),
    requiredTables: ["communities", "summaries"],
    reservationKey: `analytics:${snapshot.scope.revisionId}`,
    revisionId: snapshot.scope.revisionId,
    workspaceId: snapshot.scope.workspaceId,
  });
  const memberships = snapshot.memberships.map((membership) => {
    const identity = {
      entityId: membership.entityId,
      entityKind: membership.entityKind,
      generationId: reservation.generationId,
      revisionId: membership.revisionId,
    };
    return {
      ...membership,
      generationId: reservation.generationId,
      membershipId: revisionMembershipIdentity(identity),
    };
  });
  const rebound = GraphSnapshotSchema.parse({
    ...snapshot,
    memberships,
    scope: { ...snapshot.scope, generationId: reservation.generationId },
  });
  return {
    reservation,
    result: analyzeGraph({
      options: seed === undefined ? undefined : { seed },
      snapshot: rebound,
    }),
  };
}

describe("LanceDB analytics repository", () => {
  test("serializes reserved writes and reloads through finalized pins", async () => {
    const storage = await domain();
    const store = await LanceIntelligenceStore.open(storage);
    const repository = new LanceAnalyticsRepository(store);
    const { reservation, result } = await prepare(
      store,
      analyticsFixture(
        ["alphaOne", "alphaTwo", "betaOne", "betaTwo"],
        [
          { source: "alphaOne", target: "alphaTwo" },
          { source: "betaOne", target: "betaTwo" },
        ],
      ),
      3,
    );

    await expect(repository.persist(result, reservation)).rejects.toThrow(
      "workspace_context_required",
    );
    await expect(repository.load(reader(store, result))).rejects.toThrow(
      "workspace_context_required",
    );
    await Promise.all([
      repository.persist(result, reservation, workspace(result)),
      repository.persist(result, reservation, workspace(result)),
    ]);
    const generation = await store.finalizePublication(reservation);
    const pinned = await store.pinGeneration(generation, "analytics-test");
    expect(await repository.load(pinned, workspace(result))).toEqual(
      [...result.communities].sort((left, right) =>
        left.communityId.localeCompare(right.communityId),
      ),
    );
    await expect(
      repository.load(
        reader(store, result, {
          workspaceId: createIdentity("workspace", { wrong: true }),
        }),
        workspace(result),
      ),
    ).rejects.toThrow("analytics_reader_pin_unauthorized");
    await expect(
      repository.persist(result, reservation, workspace(result, false)),
    ).rejects.toThrow("workspace_read_only");
    await pinned.close();
    await store.shutdownCoordinator();

    const reopened = await LanceIntelligenceStore.open(storage);
    const restartedReader = await reopened.pinLatestGeneration(
      result.scope.workspaceId,
      "restart-reader",
    );
    expect(
      await new LanceAnalyticsRepository(reopened).load(
        restartedReader,
        workspace(result),
      ),
    ).toHaveLength(result.communities.length);
    await restartedReader.close();
    await reopened.shutdownCoordinator();
  });

  test("rejects mismatched legacy publication tags", async () => {
    const storage = await domain();
    const store = await LanceIntelligenceStore.open(storage);
    const repository = new LanceAnalyticsRepository(store);
    const result = analyzeGraph({
      snapshot: analyticsFixture(
        ["one", "two"],
        [{ source: "one", target: "two" }],
      ),
    });
    const mismatchedReader = {
      pin: {
        generationId: result.scope.generationId,
        publicationProtocol: "reservation-v1",
        revisionId: result.scope.revisionId,
        workspaceId: result.scope.workspaceId,
      },
      rows: async () => [
        {
          generation_id: result.scope.generationId,
          publication_generation_id: createIdentity("generation", {
            mismatched: true,
          }),
        },
      ],
    } as unknown as PinnedGenerationReader;

    await expect(
      repository.load(mismatchedReader, workspace(result)),
    ).rejects.toThrow("analytics_publication_tag_mismatch");
    await store.shutdownCoordinator();
  });

  test("rejects forged deterministic facts before persistence", async () => {
    const storage = await domain();
    const store = await LanceIntelligenceStore.open(storage);
    const repository = new LanceAnalyticsRepository(store);
    const { reservation, result } = await prepare(
      store,
      analyticsFixture(["one", "two"], [{ source: "one", target: "two" }]),
    );
    const community = result.communities[0];
    if (!community) throw new Error("missing community fixture");
    await expect(
      repository.persist(
        {
          ...result,
          communities: [
            {
              ...community,
              summary: { ...community.summary, content: "forged model output" },
            },
          ],
        },
        reservation,
        workspace(result),
      ),
    ).rejects.toThrow("analytics_community_identity_invalid");
    expect(await store.count("communities")).toBe(0);
    await store.shutdownCoordinator();
  });

  test("rejects malformed pinned summary rows instead of trusting payloads", async () => {
    const storage = await domain();
    const store = await LanceIntelligenceStore.open(storage);
    const repository = new LanceAnalyticsRepository(store);
    const { reservation, result } = await prepare(
      store,
      analyticsFixture(["one", "two"], [{ source: "one", target: "two" }]),
    );
    await repository.persist(result, reservation, workspace(result));
    const malformedId = createIdentity("stored-summary", { malformed: true });
    await store.putRows("summaries", [
      {
        content: "forged",
        content_digest: "f".repeat(64),
        created_at: "2026-09-10T00:00:00.000Z",
        generation_id: result.scope.generationId,
        model_id: null,
        payload_json: JSON.stringify({
          communityId: result.communities[0]?.communityId,
          summary: { content: "forged" },
        }),
        revision_id: result.scope.revisionId,
        subject_id: result.communities[0]?.communityId,
        summary_id: malformedId,
        summary_kind: "deterministic-community",
      },
    ]);
    await expect(
      repository.load(reader(store, result), workspace(result)),
    ).rejects.toThrow("analytics_summary_payload_invalid");
    await store.shutdownCoordinator();
  });

  test("isolates equal logical communities across finalized generations", async () => {
    const storage = await domain();
    const store = await LanceIntelligenceStore.open(storage);
    const repository = new LanceAnalyticsRepository(store);
    const first = await prepare(
      store,
      analyticsFixture(
        ["one", "two"],
        [{ source: "one", target: "two" }],
        "first",
      ),
    );
    const second = await prepare(
      store,
      analyticsFixture(
        ["one", "two"],
        [{ source: "one", target: "two" }],
        "second",
      ),
    );
    expect(first.result.communities[0]?.membershipFingerprint).toBe(
      second.result.communities[0]?.membershipFingerprint,
    );
    await repository.persist(
      first.result,
      first.reservation,
      workspace(first.result),
    );
    await repository.persist(
      second.result,
      second.reservation,
      workspace(second.result),
    );
    const firstGeneration = await store.finalizePublication(first.reservation);
    const secondGeneration = await store.finalizePublication(
      second.reservation,
    );
    const firstReader = await store.pinGeneration(firstGeneration, "first");
    const secondReader = await store.pinGeneration(secondGeneration, "second");
    expect(
      await repository.load(firstReader, workspace(first.result)),
    ).toHaveLength(1);
    expect(
      await repository.load(secondReader, workspace(second.result)),
    ).toHaveLength(1);
    await firstReader.close();
    await secondReader.close();
    await store.shutdownCoordinator();
  });
});
