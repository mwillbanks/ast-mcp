import { createHash } from "node:crypto";

import { z } from "zod";

import {
  createIdentity,
  namespacedIdentitySchema,
  Sha256Schema,
} from "../contracts/common.ts";
import { GraphNodeIdSchema } from "../contracts/graph.ts";
import type { PublicationReservation } from "../contracts/storage.ts";
import type {
  LanceIntelligenceStore,
  PinnedGenerationReader,
} from "../storage/store.ts";
import type { WorkspaceHandle } from "../workspace/context.ts";
import {
  assertWorkspaceWritable,
  currentWorkspace,
} from "../workspace/context.ts";
import type {
  AnalyticsCommunity,
  GraphAnalyticsResult,
  PersistedAnalytics,
} from "./types.ts";
import { ANALYTICS_ALGORITHM, ANALYTICS_VERSION } from "./types.ts";

type Row = Readonly<Record<string, unknown>>;

const DeterministicSummarySchema = z
  .object({
    cacheKey: Sha256Schema,
    content: z.string().min(1),
    contentDigest: Sha256Schema,
    evidenceFingerprint: Sha256Schema,
    label: z.string().min(1),
    membershipFingerprint: Sha256Schema,
    summaryId: namespacedIdentitySchema("summary"),
  })
  .strict();

const AnalyticsCommunitySchema = z
  .object({
    communityId: namespacedIdentitySchema("community"),
    connected: z.boolean(),
    label: z.string().min(1),
    level: z.number().int().nonnegative(),
    memberIds: z.array(GraphNodeIdSchema),
    membershipFingerprint: Sha256Schema,
    summary: DeterministicSummarySchema,
  })
  .strict();

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function validateCommunity(
  communityInput: unknown,
  coordinates: {
    evidenceFingerprint: string;
    projectionFingerprint: string;
    resolution: number;
    seed: number;
  },
): AnalyticsCommunity {
  const community = AnalyticsCommunitySchema.parse(communityInput);
  const sortedMembers = [...community.memberIds].sort();
  if (
    sortedMembers.length === 0 ||
    new Set(sortedMembers).size !== sortedMembers.length ||
    JSON.stringify(sortedMembers) !== JSON.stringify(community.memberIds)
  ) {
    throw new Error("analytics_community_members_invalid");
  }
  const membershipFingerprint = digest(JSON.stringify(sortedMembers));
  const expectedCommunityId = createIdentity("community", {
    algorithm: ANALYTICS_ALGORITHM,
    algorithmVersion: ANALYTICS_VERSION,
    membershipFingerprint,
    projectionFingerprint: coordinates.projectionFingerprint,
    resolution: coordinates.resolution,
    seed: coordinates.seed,
  });
  const expectedCacheKey = digest(
    JSON.stringify({
      evidenceFingerprint: community.summary.evidenceFingerprint,
      membershipFingerprint,
      summaryVersion: 1,
    }),
  );
  const contentDigest = digest(community.summary.content);
  const expectedSummaryId = createIdentity("summary", {
    cacheKey: expectedCacheKey,
    communityId: expectedCommunityId,
    contentDigest,
    kind: "deterministic-community",
  });
  if (
    community.summary.evidenceFingerprint !== coordinates.evidenceFingerprint ||
    community.membershipFingerprint !== membershipFingerprint ||
    community.communityId !== expectedCommunityId ||
    community.label !== community.summary.label ||
    community.summary.membershipFingerprint !== membershipFingerprint ||
    community.summary.cacheKey !== expectedCacheKey ||
    community.summary.contentDigest !== contentDigest ||
    community.summary.summaryId !== expectedSummaryId
  ) {
    throw new Error("analytics_community_identity_invalid");
  }
  return community;
}

function parsedRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") throw new Error("analytics_payload_invalid");
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("analytics_payload_invalid");
  }
  return parsed as Record<string, unknown>;
}

function assertAuthorized(
  result: GraphAnalyticsResult,
  workspace: WorkspaceHandle,
): void {
  if (
    result.scope.workspaceId !== workspace.workspaceId ||
    result.scope.repositoryId !== workspace.repositoryId ||
    result.scope.revisionId !== workspace.selectedRevision.revisionId
  ) {
    throw new Error("analytics_scope_unauthorized");
  }
  if (result.scope.generationId.length === 0) {
    throw new Error("analytics_generation_required");
  }
}

function communityPayload(
  row: Row,
  expectedGenerationId: string,
  expectedRepositoryId: string,
  expectedRevisionId: string,
): AnalyticsCommunity | null {
  if (
    row.generation_id !== expectedGenerationId ||
    row.revision_id !== expectedRevisionId
  ) {
    return null;
  }
  const payload = parsedRecord(row.payload_json);
  const evidenceFingerprint = Sha256Schema.safeParse(
    payload.evidenceFingerprint,
  );
  const projectionFingerprint = Sha256Schema.safeParse(
    payload.projectionFingerprint,
  );
  const seed = z.number().int().nonnegative().safeParse(payload.seed);
  const resolution = z.number().positive().safeParse(row.resolution);
  if (
    !evidenceFingerprint.success ||
    !projectionFingerprint.success ||
    !seed.success ||
    !resolution.success ||
    payload.repositoryId !== expectedRepositoryId ||
    row.algorithm !== `${ANALYTICS_ALGORITHM}@${ANALYTICS_VERSION}`
  ) {
    throw new Error("analytics_community_payload_invalid");
  }
  const community = validateCommunity(payload.community, {
    evidenceFingerprint: evidenceFingerprint.data,
    projectionFingerprint: projectionFingerprint.data,
    resolution: resolution.data,
    seed: seed.data,
  });
  const expectedStorageId = createIdentity("stored-community", {
    communityId: community.communityId,
    generationId: expectedGenerationId,
  });
  if (
    row.community_id !== expectedStorageId ||
    row.member_ids_json !== JSON.stringify(community.memberIds)
  ) {
    throw new Error("analytics_community_payload_invalid");
  }
  return community;
}

export class LanceAnalyticsRepository {
  constructor(private readonly store: LanceIntelligenceStore) {}

  async persist(
    result: GraphAnalyticsResult,
    reservation: PublicationReservation,
    workspaceInput?: WorkspaceHandle,
  ): Promise<PersistedAnalytics> {
    const workspace = workspaceInput ?? currentWorkspace();
    if (!workspace) throw new Error("workspace_context_required");
    assertAuthorized(result, workspace);
    if (
      result.algorithm !== ANALYTICS_ALGORITHM ||
      result.algorithmVersion !== ANALYTICS_VERSION
    ) {
      throw new Error("analytics_algorithm_unsupported");
    }
    const projectionFingerprint = Sha256Schema.parse(
      result.projection.fingerprint,
    );
    const evidenceFingerprint = Sha256Schema.parse(
      result.projection.evidenceFingerprint,
    );
    const persistedCommunities = result.communities.map((community) =>
      validateCommunity(community, {
        evidenceFingerprint,
        projectionFingerprint,
        resolution: result.resolution,
        seed: result.seed,
      }),
    );
    assertWorkspaceWritable();
    if (!workspace.writeEligibility.eligible)
      throw new Error("workspace_read_only");

    if (
      (reservation.publicationProtocol !== "reservation-v1" &&
        reservation.publicationProtocol !== "reservation-v2") ||
      reservation.generationId !== result.scope.generationId ||
      reservation.workspaceId !== result.scope.workspaceId ||
      reservation.revisionId !== result.scope.revisionId ||
      reservation.storageDomainId !== this.store.domain.domainId ||
      !reservation.requiredTables.includes("communities") ||
      !reservation.requiredTables.includes("summaries")
    ) {
      throw new Error("analytics_reservation_scope_mismatch");
    }
    const communityRows = persistedCommunities.map((community) => {
      const storageId = createIdentity("stored-community", {
        communityId: community.communityId,
        generationId: result.scope.generationId,
      });
      return {
        algorithm: `${result.algorithm}@${result.algorithmVersion}`,
        community_id: storageId,
        created_at: this.store.currentTimestamp(),
        generation_id: result.scope.generationId,
        member_ids_json: JSON.stringify(community.memberIds),
        payload_json: JSON.stringify({
          community,
          evidenceFingerprint: result.projection.evidenceFingerprint,
          projectionFingerprint: result.projection.fingerprint,
          repositoryId: result.scope.repositoryId,
          seed: result.seed,
        }),
        resolution: result.resolution,
        revision_id: result.scope.revisionId,
      };
    });
    const summaryRows = persistedCommunities.map(({ communityId, summary }) => {
      const storageId = createIdentity("stored-summary", {
        generationId: result.scope.generationId,
        summaryId: summary.summaryId,
      });
      return {
        content: summary.content,
        content_digest: summary.contentDigest,
        created_at: this.store.currentTimestamp(),
        generation_id: result.scope.generationId,
        model_id: null,
        payload_json: JSON.stringify({
          communityId,
          label: summary.label,
          summary,
        }),
        revision_id: result.scope.revisionId,
        subject_id: communityId,
        summary_id: storageId,
        summary_kind: "deterministic-community",
      };
    });
    await this.store.putReservedRowsBatch(reservation, [
      { rows: communityRows, tableName: "communities" },
      { rows: summaryRows, tableName: "summaries" },
    ]);
    return {
      algorithm: ANALYTICS_ALGORITHM,
      algorithmVersion: ANALYTICS_VERSION,
      communities: persistedCommunities,
      projectionFingerprint: result.projection.fingerprint,
      resolution: result.resolution,
      scope: result.scope,
      seed: result.seed,
    };
  }

  async load(
    reader: PinnedGenerationReader,
    workspaceInput?: WorkspaceHandle,
  ): Promise<readonly AnalyticsCommunity[]> {
    const workspace = workspaceInput ?? currentWorkspace();
    if (!workspace) throw new Error("workspace_context_required");
    if (
      reader.pin.workspaceId !== workspace.workspaceId ||
      reader.pin.revisionId !== workspace.selectedRevision.revisionId
    ) {
      throw new Error("analytics_reader_pin_unauthorized");
    }
    const [communityRows, summaryRows] = await Promise.all([
      reader.rows("communities"),
      reader.rows("summaries"),
    ]);
    if (reader.pin.publicationProtocol === "reservation-v1") {
      const mismatched = [...communityRows, ...summaryRows].some(
        (row) =>
          row.generation_id === reader.pin.generationId &&
          row.publication_generation_id !== reader.pin.generationId,
      );
      if (mismatched) {
        throw new Error("analytics_publication_tag_mismatch");
      }
    }
    const summaries = new Map<
      string,
      z.infer<typeof DeterministicSummarySchema>
    >();
    for (const row of summaryRows) {
      if (
        row.generation_id !== reader.pin.generationId ||
        row.revision_id !== reader.pin.revisionId
      ) {
        continue;
      }
      const payload = parsedRecord(row.payload_json);
      const summary = DeterministicSummarySchema.safeParse(payload.summary);
      if (
        !summary.success ||
        row.subject_id !== payload.communityId ||
        row.content !== summary.data.content ||
        row.content_digest !== summary.data.contentDigest ||
        row.model_id !== null ||
        row.summary_kind !== "deterministic-community"
      ) {
        throw new Error("analytics_summary_payload_invalid");
      }
      const communityId = String(payload.communityId);
      const expectedStorageId = createIdentity("stored-summary", {
        generationId: reader.pin.generationId,
        summaryId: summary.data.summaryId,
      });
      if (row.summary_id !== expectedStorageId || summaries.has(communityId)) {
        throw new Error("analytics_summary_payload_invalid");
      }
      summaries.set(communityId, summary.data);
    }
    return communityRows
      .map((row) =>
        communityPayload(
          row,
          reader.pin.generationId,
          workspace.repositoryId,
          reader.pin.revisionId,
        ),
      )
      .filter(
        (community): community is AnalyticsCommunity => community !== null,
      )
      .map((community) => {
        const summary = summaries.get(community.communityId);
        if (
          !summary ||
          JSON.stringify(summary) !== JSON.stringify(community.summary)
        ) {
          throw new Error("analytics_summary_missing_or_mismatched");
        }
        return community;
      })
      .sort((left, right) => left.communityId.localeCompare(right.communityId));
  }
}
