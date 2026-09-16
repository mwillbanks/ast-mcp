import { z } from "zod";
import {
  AbsolutePathSchema,
  createIdentity,
  GenerationIdSchema,
  INTELLIGENCE_SCHEMA_VERSION,
  JobIdSchema,
  NonEmptyStringSchema,
  ReaderPinIdSchema,
  RevisionIdSchema,
  RevisionManifestArtifactIdSchema,
  Sha256Schema,
  StorageDomainIdSchema,
  TimestampSchema,
  WorkspaceIdSchema,
} from "./common.ts";

export const StoragePlacementSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("global") }).strict(),
  z.object({ kind: z.literal("local") }).strict(),
  z
    .object({
      kind: z.literal("parent"),
      levels: z.number().int().min(1).max(32),
    })
    .strict(),
  z
    .object({
      kind: z.literal("explicit"),
      path: AbsolutePathSchema,
    })
    .strict(),
]);
export type StoragePlacement = z.infer<typeof StoragePlacementSchema>;

export function canonicalStoragePlacement(placement: StoragePlacement): string {
  const parsed = StoragePlacementSchema.parse(placement);
  if (parsed.kind === "parent") return `parent:${parsed.levels}`;
  if (parsed.kind === "explicit") return `explicit:${parsed.path}`;
  return parsed.kind;
}

export const StorageDomainIdentityInputSchema = z
  .object({
    engine: z.literal("lancedb"),
    placement: StoragePlacementSchema,
    pool: z.literal("shared"),
    storagePath: AbsolutePathSchema,
  })
  .strict();

export function createStorageDomainId(
  input: z.input<typeof StorageDomainIdentityInputSchema>,
): string {
  return createIdentity(
    "storage-domain",
    StorageDomainIdentityInputSchema.parse(input),
  );
}

export const StorageDomainSchema = z
  .object({
    domainId: StorageDomainIdSchema,
    engine: z.literal("lancedb"),
    placement: StoragePlacementSchema,
    pool: z.literal("shared"),
    schemaVersion: z.literal(INTELLIGENCE_SCHEMA_VERSION),
    storagePath: AbsolutePathSchema,
  })
  .strict()
  .superRefine((domain, context) => {
    const expected = createStorageDomainId({
      engine: domain.engine,
      placement: domain.placement,
      pool: domain.pool,
      storagePath: domain.storagePath,
    });
    if (domain.domainId !== expected) {
      context.addIssue({
        code: "custom",
        message: "Storage domain identity does not match its coordinates",
        path: ["domainId"],
      });
    }
  });
export type StorageDomain = z.infer<typeof StorageDomainSchema>;

export const LanceTableNameSchema = z.enum([
  "artifacts",
  "syntax_facts",
  "chunks",
  "embeddings",
  "relationships",
  "revision_manifests",
  "dirty_overlays",
  "graph_nodes",
  "graph_occurrences",
  "graph_edges",
  "graph_evidence",
  "generation_artifacts",
  "revision_membership",
  "workspaces",
  "jobs",
  "publications",
  "reader_pins",
  "retention",
  "migrations",
  "coordinator_recovery",
  "communities",
  "summaries",
]);
export type LanceTableName = z.infer<typeof LanceTableNameSchema>;

export const TableVersionPinSchema = z
  .object({
    table: LanceTableNameSchema,
    version: z.number().int().nonnegative(),
  })
  .strict();

export const COMPLETE_GENERATION_TABLES = [
  "artifacts",
  "syntax_facts",
  "chunks",
  "embeddings",
  "relationships",
  "revision_manifests",
  "dirty_overlays",
  "graph_nodes",
  "graph_occurrences",
  "graph_edges",
  "graph_evidence",
  "revision_membership",
  "workspaces",
  "communities",
  "summaries",
] as const satisfies readonly LanceTableName[];

export const PublicationGenerationTableSchema = z.enum(
  COMPLETE_GENERATION_TABLES,
);
export type PublicationGenerationTable = z.infer<
  typeof PublicationGenerationTableSchema
>;

export const RequiredPublicationTablesSchema = z
  .array(PublicationGenerationTableSchema)
  .min(1)
  .superRefine((tables, context) => {
    if (new Set(tables).size !== tables.length) {
      context.addIssue({
        code: "custom",
        message: "Required publication tables must be unique",
      });
    }
  });

function sortedRequiredTables(
  tables: readonly PublicationGenerationTable[],
): PublicationGenerationTable[] {
  return [...tables].sort();
}

function addCompleteGenerationIssue(
  pins: readonly z.infer<typeof TableVersionPinSchema>[],
  context: z.RefinementCtx,
): boolean {
  const tables = new Set(pins.map((pin) => pin.table));
  const complete =
    pins.length === COMPLETE_GENERATION_TABLES.length &&
    COMPLETE_GENERATION_TABLES.every((table) => tables.has(table));
  if (!complete) {
    context.addIssue({
      code: "custom",
      message: "Generation pins must contain every required table exactly once",
      path: ["tableVersions"],
    });
  }
  return complete;
}

function sortedTableVersions(
  pins: readonly z.infer<typeof TableVersionPinSchema>[],
) {
  return [...pins].sort((left, right) =>
    left.table < right.table ? -1 : left.table > right.table ? 1 : 0,
  );
}

export const PublicationProtocolSchema = z.enum([
  "legacy-v1",
  "reservation-v1",
  "reservation-v2",
]);

export const PublicationReservationIdentityInputSchema = z
  .object({
    attempt: z.number().int().positive().optional(),
    inputFingerprint: Sha256Schema.optional(),
    manifestArtifactId: RevisionManifestArtifactIdSchema,
    requiredTables: RequiredPublicationTablesSchema,
    reservationKey: NonEmptyStringSchema,
    revisionId: RevisionIdSchema,
    storageDomainId: StorageDomainIdSchema,
    workspaceId: WorkspaceIdSchema,
  })
  .strict();

export function createPublicationReservationId(
  input: z.input<typeof PublicationReservationIdentityInputSchema>,
): string {
  const parsed = PublicationReservationIdentityInputSchema.parse(input);
  const { attempt, inputFingerprint, ...coordinates } = parsed;
  return createIdentity("generation", {
    ...(attempt === undefined ? {} : { attempt }),
    ...(inputFingerprint === undefined ? {} : { inputFingerprint }),
    manifestArtifactId: coordinates.manifestArtifactId,
    requiredTables: sortedRequiredTables(coordinates.requiredTables),
    reservationKey: coordinates.reservationKey,
    revisionId: coordinates.revisionId,
    storageDomainId: coordinates.storageDomainId,
    workspaceId: coordinates.workspaceId,
  });
}

function addUniqueTableVersionIssue(
  pins: readonly z.infer<typeof TableVersionPinSchema>[],
  context: z.RefinementCtx,
): void {
  if (new Set(pins.map((pin) => pin.table)).size !== pins.length) {
    context.addIssue({
      code: "custom",
      message: "Table version pins must be unique",
      path: ["tableVersions"],
    });
  }
}

export const PublicationReservationSchema = z
  .object({
    abandonedAt: TimestampSchema.nullable(),
    abandonReason: NonEmptyStringSchema.nullable(),
    attempt: z.number().int().positive().optional(),
    expiresAt: TimestampSchema,
    generationId: GenerationIdSchema,
    immutable: z.literal(false),
    inputFingerprint: Sha256Schema.optional(),
    manifestArtifactId: RevisionManifestArtifactIdSchema,
    publicationProtocol: z.enum(["reservation-v1", "reservation-v2"]),
    requiredTables: RequiredPublicationTablesSchema,
    reservationKey: NonEmptyStringSchema,
    reservedAt: TimestampSchema,
    revisionId: RevisionIdSchema,
    schemaVersion: z.literal(INTELLIGENCE_SCHEMA_VERSION),
    state: z.enum(["reserved", "abandoned"]),
    storageDomainId: StorageDomainIdSchema,
    tableVersions: z.array(TableVersionPinSchema),
    workspaceId: WorkspaceIdSchema,
  })
  .strict()
  .superRefine((reservation, context) => {
    addUniqueTableVersionIssue(reservation.tableVersions, context);
    const expected = createPublicationReservationId({
      attempt: reservation.attempt,
      inputFingerprint: reservation.inputFingerprint,
      manifestArtifactId: reservation.manifestArtifactId,
      requiredTables: reservation.requiredTables,
      reservationKey: reservation.reservationKey,
      revisionId: reservation.revisionId,
      storageDomainId: reservation.storageDomainId,
      workspaceId: reservation.workspaceId,
    });
    const isV2 = reservation.publicationProtocol === "reservation-v2";
    if (
      isV2 !==
      (reservation.attempt !== undefined &&
        reservation.inputFingerprint !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "Reservation v2 requires attempt and input fingerprint",
        path: ["publicationProtocol"],
      });
    }
    if (reservation.generationId !== expected) {
      context.addIssue({
        code: "custom",
        message: "Reservation identity does not match its coordinates",
        path: ["generationId"],
      });
    }
    if (
      Date.parse(reservation.expiresAt) <= Date.parse(reservation.reservedAt)
    ) {
      context.addIssue({
        code: "custom",
        message: "Reservation expiration must follow creation",
        path: ["expiresAt"],
      });
    }
    const abandoned = reservation.state === "abandoned";
    if (
      abandoned !==
      (reservation.abandonedAt !== null && reservation.abandonReason !== null)
    ) {
      context.addIssue({
        code: "custom",
        message: "Abandoned reservations require timestamp and reason",
        path: ["state"],
      });
    }
  });
export type PublicationReservation = z.infer<
  typeof PublicationReservationSchema
>;

export const PublicationGenerationIdentityInputSchema = z
  .object({
    manifestArtifactId: RevisionManifestArtifactIdSchema,
    revisionId: RevisionIdSchema,
    storageDomainId: StorageDomainIdSchema,
    tableVersions: z.array(TableVersionPinSchema),
    workspaceId: WorkspaceIdSchema,
  })
  .strict()
  .superRefine((input, context) => {
    addCompleteGenerationIssue(input.tableVersions, context);
  });

export function createPublicationGenerationId(
  input: z.input<typeof PublicationGenerationIdentityInputSchema>,
): string {
  const parsed = PublicationGenerationIdentityInputSchema.parse(input);
  return createIdentity("generation", {
    ...parsed,
    tableVersions: sortedTableVersions(parsed.tableVersions),
  });
}

export const PublicationGenerationSchema = z
  .object({
    attempt: z.number().int().positive().optional(),
    generationId: GenerationIdSchema,
    immutable: z.literal(true),
    inputFingerprint: Sha256Schema.optional(),
    manifestArtifactId: RevisionManifestArtifactIdSchema,
    publicationProtocol: PublicationProtocolSchema.optional(),
    publishedAt: TimestampSchema,
    requiredTables: RequiredPublicationTablesSchema.optional(),
    reservationKey: NonEmptyStringSchema.nullable().optional(),
    revisionId: RevisionIdSchema,
    schemaVersion: z.literal(INTELLIGENCE_SCHEMA_VERSION),
    state: z.literal("published"),
    storageDomainId: StorageDomainIdSchema,
    tableVersions: z.array(TableVersionPinSchema),
    workspaceId: WorkspaceIdSchema,
  })
  .strict()
  .superRefine((generation, context) => {
    const complete = addCompleteGenerationIssue(
      generation.tableVersions,
      context,
    );
    if (!complete) return;
    const protocol = generation.publicationProtocol ?? "legacy-v1";
    const expected =
      (protocol === "reservation-v1" || protocol === "reservation-v2") &&
      generation.reservationKey
        ? createPublicationReservationId({
            attempt: generation.attempt,
            inputFingerprint: generation.inputFingerprint,
            manifestArtifactId: generation.manifestArtifactId,
            requiredTables: generation.requiredTables ?? [],
            reservationKey: generation.reservationKey,
            revisionId: generation.revisionId,
            storageDomainId: generation.storageDomainId,
            workspaceId: generation.workspaceId,
          })
        : createPublicationGenerationId({
            manifestArtifactId: generation.manifestArtifactId,
            revisionId: generation.revisionId,
            storageDomainId: generation.storageDomainId,
            tableVersions: generation.tableVersions,
            workspaceId: generation.workspaceId,
          });
    if (
      ((protocol === "reservation-v1" || protocol === "reservation-v2") &&
        (!generation.reservationKey || !generation.requiredTables)) ||
      (protocol === "reservation-v2" &&
        (generation.attempt === undefined ||
          generation.inputFingerprint === undefined)) ||
      (protocol !== "reservation-v2" &&
        (generation.attempt !== undefined ||
          generation.inputFingerprint !== undefined)) ||
      (protocol === "legacy-v1" &&
        (generation.reservationKey != null ||
          generation.requiredTables !== undefined)) ||
      generation.generationId !== expected
    ) {
      context.addIssue({
        code: "custom",
        message: "Generation identity does not match its publication protocol",
        path: ["generationId"],
      });
    }
  });
export type PublicationGeneration = z.infer<typeof PublicationGenerationSchema>;

export const ReaderPinSchema = z
  .object({
    attempt: z.number().int().positive().optional(),
    createdAt: TimestampSchema,
    expiresAt: TimestampSchema,
    generationId: GenerationIdSchema,
    inputFingerprint: Sha256Schema.optional(),
    manifestArtifactId: RevisionManifestArtifactIdSchema,
    pinId: ReaderPinIdSchema,
    publicationProtocol: PublicationProtocolSchema.optional(),
    readerId: NonEmptyStringSchema,
    requiredTables: RequiredPublicationTablesSchema.optional(),
    reservationKey: NonEmptyStringSchema.nullable().optional(),
    revisionId: RevisionIdSchema,
    storageDomainId: StorageDomainIdSchema,
    tableVersions: z.array(TableVersionPinSchema),
    workspaceId: WorkspaceIdSchema,
  })
  .strict()
  .superRefine((pin, context) => {
    const complete = addCompleteGenerationIssue(pin.tableVersions, context);
    if (complete) {
      const protocol = pin.publicationProtocol ?? "legacy-v1";
      const expected =
        (protocol === "reservation-v1" || protocol === "reservation-v2") &&
        pin.reservationKey
          ? createPublicationReservationId({
              attempt: pin.attempt,
              inputFingerprint: pin.inputFingerprint,
              manifestArtifactId: pin.manifestArtifactId,
              requiredTables: pin.requiredTables ?? [],
              reservationKey: pin.reservationKey,
              revisionId: pin.revisionId,
              storageDomainId: pin.storageDomainId,
              workspaceId: pin.workspaceId,
            })
          : createPublicationGenerationId({
              manifestArtifactId: pin.manifestArtifactId,
              revisionId: pin.revisionId,
              storageDomainId: pin.storageDomainId,
              tableVersions: pin.tableVersions,
              workspaceId: pin.workspaceId,
            });
      if (
        ((protocol === "reservation-v1" || protocol === "reservation-v2") &&
          (!pin.reservationKey || !pin.requiredTables)) ||
        (protocol === "reservation-v2" &&
          (pin.attempt === undefined || pin.inputFingerprint === undefined)) ||
        (protocol !== "reservation-v2" &&
          (pin.attempt !== undefined || pin.inputFingerprint !== undefined)) ||
        (protocol === "legacy-v1" &&
          (pin.reservationKey != null || pin.requiredTables !== undefined)) ||
        pin.generationId !== expected
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Reader pin identity does not match its publication protocol",
          path: ["generationId"],
        });
      }
    }
    if (Date.parse(pin.expiresAt) <= Date.parse(pin.createdAt)) {
      context.addIssue({
        code: "custom",
        message: "Reader pin expiration must follow creation",
        path: ["expiresAt"],
      });
    }
  });
export type ReaderPin = z.infer<typeof ReaderPinSchema>;

export function assertReaderPinsGeneration(
  generationInput: PublicationGeneration,
  pinInput: ReaderPin,
): void {
  const generation = PublicationGenerationSchema.parse(generationInput);
  const pin = ReaderPinSchema.parse(pinInput);
  if (
    pin.generationId !== generation.generationId ||
    pin.storageDomainId !== generation.storageDomainId ||
    pin.workspaceId !== generation.workspaceId ||
    pin.revisionId !== generation.revisionId ||
    pin.manifestArtifactId !== generation.manifestArtifactId ||
    pin.attempt !== generation.attempt ||
    pin.inputFingerprint !== generation.inputFingerprint ||
    (pin.publicationProtocol ?? "legacy-v1") !==
      (generation.publicationProtocol ?? "legacy-v1") ||
    (pin.reservationKey ?? null) !== (generation.reservationKey ?? null) ||
    JSON.stringify(pin.requiredTables ?? []) !==
      JSON.stringify(generation.requiredTables ?? [])
  ) {
    throw new Error("mixed_generation");
  }
  const expected = new Map(
    generation.tableVersions.map((item) => [item.table, item.version]),
  );
  for (const item of pin.tableVersions) {
    if (expected.get(item.table) !== item.version) {
      throw new Error("mixed_generation");
    }
  }
}

export const IntelligenceJobTypeSchema = z.enum([
  "index-source",
  "parse",
  "chunk",
  "embed",
  "resolve",
  "publish",
  "compact",
  "migrate",
]);
export const IntelligenceJobStateSchema = z.enum([
  "pending",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);

export const IntelligenceJobSchema = z
  .object({
    attempt: z.number().int().nonnegative(),
    createdAt: TimestampSchema,
    errorCode: NonEmptyStringSchema.nullable(),
    idempotencyKey: JobIdSchema,
    jobId: JobIdSchema,
    revisionId: RevisionIdSchema,
    state: IntelligenceJobStateSchema,
    storageDomainId: StorageDomainIdSchema,
    type: IntelligenceJobTypeSchema,
    updatedAt: TimestampSchema,
    workspaceId: WorkspaceIdSchema,
  })
  .strict();
export type IntelligenceJob = z.infer<typeof IntelligenceJobSchema>;

export const JobIdempotencyInputSchema = z
  .object({
    inputFingerprint: Sha256Schema,
    revisionId: RevisionIdSchema,
    storageDomainId: StorageDomainIdSchema,
    type: IntelligenceJobTypeSchema,
    workspaceId: WorkspaceIdSchema,
  })
  .strict();

export function createJobIdempotencyKey(
  input: z.input<typeof JobIdempotencyInputSchema>,
): string {
  return createIdentity("job", JobIdempotencyInputSchema.parse(input));
}
