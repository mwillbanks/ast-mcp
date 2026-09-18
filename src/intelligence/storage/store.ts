import { createHash, randomUUID } from "node:crypto";

import type { Connection, Table } from "@lancedb/lancedb";
import * as lancedb from "@lancedb/lancedb";
import { Schema } from "apache-arrow";

import * as artifactContracts from "../contracts/artifacts.ts";
import {
  createIdentity,
  INTELLIGENCE_SCHEMA_VERSION,
} from "../contracts/common.ts";
import {
  assertReaderPinsGeneration,
  COMPLETE_GENERATION_TABLES,
  createPublicationGenerationId,
  createPublicationReservationId,
  type IntelligenceJob,
  type LanceTableName,
  type PublicationGeneration,
  PublicationGenerationSchema,
  type PublicationGenerationTable,
  type PublicationReservation,
  PublicationReservationSchema,
  type ReaderPin,
  ReaderPinSchema,
  type StorageDomain,
  StorageDomainSchema,
} from "../contracts/storage.ts";
import {
  type CoordinatorLease,
  type CoordinatorOptions,
  StorageCoordinator,
} from "./coordinator.ts";
import { StorageError } from "./errors.ts";
import {
  assertSupportedStoragePath,
  copyRelocationSnapshot,
  type NetworkFileSystemProof,
  type RelocationPreview,
  type RelocationResult,
  snapshotStorageDirectory,
  storagePathIdentity,
  validateRelocationCoordinates,
} from "./relocation.ts";
import {
  ALL_TABLES,
  assertCompatibleSchema,
  IMMUTABLE_TABLES,
  type StorageRow,
  TABLE_PRIMARY_KEYS,
  TABLE_SCHEMAS,
} from "./schemas.ts";

export interface StoreOpenOptions extends CoordinatorOptions {
  access?: "read-only" | "read-write";
  networkFileSystem?: boolean;
  networkProof?: NetworkFileSystemProof;
}

export interface WriteMetrics {
  insertedBytes: number;
  insertedRows: number;
  logicalBytes: number;
  reusedBytes: number;
  reusedRows: number;
}

export interface StorageMetrics {
  logicalBytes: number;
  logicalReferences: number;
  physicalArtifacts: number;
  physicalBytes: number;
  reusedBytes: number;
  storageGrowthBytes: number;
}

export interface RecoveryResult {
  abandonedReservationIds: readonly string[];
  ignoredUnpublishedTableVersions: number;
  lastPublishedGenerationId: string | null;
  resumedJobIds: readonly string[];
}

export interface CollectionOptions {
  keepFailedJobsForDays?: number;
  keepPublishedGenerations?: number;
  maxDeletesPerTable?: number;
  now?: Date;
  pinGraceSeconds?: number;
  pinnedRevisionIds?: readonly string[];
  unreachableArtifactDays?: number;
}

export interface CollectionResult {
  deletedByTable: Readonly<Partial<Record<LanceTableName, number>>>;
  protectedArtifactIds: number;
  protectedGenerationIds: number;
  protectedRevisionIds: number;
}

export interface PublishInput {
  manifestArtifactId: string;
  revisionId: string;
  workspaceId: string;
}

export interface ReservePublicationInput extends PublishInput {
  inputFingerprint?: string;
  requiredTables: readonly PublicationGenerationTable[];
  reservationKey: string;
  ttlMs?: number;
}

export interface ReservedWriteOptions {
  immutable?: boolean;
}

export interface ReservedTableWrite {
  options?: ReservedWriteOptions;
  rows: readonly StorageRow[];
  tableName: PublicationGenerationTable;
}

const CONTENT_TABLES = [
  "artifacts",
  "syntax_facts",
  "chunks",
  "embeddings",
  "relationships",
  "revision_manifests",
  "dirty_overlays",
] as const satisfies readonly LanceTableName[];

const PHYSICAL_ARTIFACT_TABLES = [
  "artifacts",
  "syntax_facts",
  "chunks",
  "embeddings",
  "relationships",
] as const satisfies readonly LanceTableName[];

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function rowBytes(row: StorageRow): number {
  const value = row.byte_length ?? row.logical_bytes ?? 0;
  return typeof value === "number" ? value : Number(value);
}

function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const candidate = Number(value ?? fallback);
  return Number.isFinite(candidate)
    ? Math.min(maximum, Math.max(minimum, Math.floor(candidate)))
    : fallback;
}

function toComparable(value: unknown): unknown {
  if (typeof value === "bigint") return Number(value);
  if (value instanceof Uint8Array) {
    return { binary: Buffer.from(value).toString("base64") };
  }
  if (ArrayBuffer.isView(value)) {
    const view = value as unknown as {
      [index: number]: number;
      length: number;
    };
    return Array.from({ length: view.length }, (_, index) => view[index]);
  }
  if (Array.isArray(value)) return value.map(toComparable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => key !== "created_at")
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, toComparable(item)]),
    );
  }
  return value;
}

function equivalentRows(left: StorageRow, right: StorageRow): boolean {
  return (
    JSON.stringify(toComparable(left)) === JSON.stringify(toComparable(right))
  );
}

function parseJsonRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function collectIdentityStrings(value: unknown, identities: Set<string>): void {
  if (typeof value === "string") {
    if (/^[a-z][a-z0-9-]*:v1:[a-f0-9]{64}$/.test(value)) {
      identities.add(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectIdentityStrings(item, identities);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const item of Object.values(value as Record<string, unknown>)) {
    collectIdentityStrings(item, identities);
  }
}

function prepareRow(tableName: LanceTableName, row: StorageRow): StorageRow {
  const schema = TABLE_SCHEMAS[tableName];
  const allowed = new Set(schema.fields.map((field) => field.name));
  const unknown = Object.keys(row).filter((column) => !allowed.has(column));
  if (unknown.length > 0) {
    throw new StorageError(
      "invalid_schema",
      `Row for ${tableName} contains columns outside its Arrow schema`,
      false,
      { tableName, unknown },
    );
  }
  const prepared: StorageRow = {};
  for (const field of schema.fields) {
    const value = row[field.name];
    if (value === undefined) {
      if (!field.nullable) {
        throw new StorageError(
          "invalid_schema",
          `Row for ${tableName} omits required column ${field.name}`,
          false,
          { column: field.name, tableName },
        );
      }
      prepared[field.name] = null;
      continue;
    }
    if (value === null && !field.nullable) {
      throw new StorageError(
        "invalid_schema",
        `Row for ${tableName} has null required column ${field.name}`,
        false,
        { column: field.name, tableName },
      );
    }
    prepared[field.name] = value;
  }
  return prepared;
}

async function latestTable(connection: Connection, name: LanceTableName) {
  const table = await connection.openTable(name);
  try {
    await table.checkoutLatest();
    return table;
  } catch (error) {
    table.close();
    throw error;
  }
}

async function withLatestTable<T>(
  connection: Connection,
  name: LanceTableName,
  action: (table: Table) => Promise<T>,
): Promise<T> {
  const table = await latestTable(connection, name);
  try {
    return await action(table);
  } finally {
    table.close();
  }
}

function arrowSchemaSignature(schema: Schema): readonly string[] {
  return schema.fields.map(
    (field) =>
      `${field.name}:${field.type.toString()}:${field.nullable ? "nullable" : "required"}`,
  );
}

function isLegacyPublicationTagSchema(
  tableName: LanceTableName,
  actual: Schema,
): boolean {
  if (
    !COMPLETE_GENERATION_TABLES.includes(
      tableName as PublicationGenerationTable,
    )
  ) {
    return false;
  }
  const expected = TABLE_SCHEMAS[tableName];
  const legacy = new Schema(
    expected.fields.filter(
      (field) => field.name !== "publication_generation_id",
    ),
  );
  return (
    JSON.stringify(arrowSchemaSignature(actual)) ===
    JSON.stringify(arrowSchemaSignature(legacy))
  );
}

export class ReaderPinExpiredError extends StorageError {
  constructor(
    readonly pinId: string,
    readonly expiresAt: string,
  ) {
    super("mixed_generation", "Reader pin has expired", false, {
      expiresAt,
      pinId,
    });
    this.name = "ReaderPinExpiredError";
  }
}

export class PinnedGenerationReader {
  private closed = false;
  private expired = false;

  constructor(
    private readonly store: LanceIntelligenceStore,
    readonly pin: ReaderPin,
    private readonly tables: ReadonlyMap<LanceTableName, Table>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async assertReadable(): Promise<void> {
    if (this.expired) {
      throw new ReaderPinExpiredError(this.pin.pinId, this.pin.expiresAt);
    }
    if (this.now().getTime() >= Date.parse(this.pin.expiresAt)) {
      this.expired = true;
      await this.closeResources();
      throw new ReaderPinExpiredError(this.pin.pinId, this.pin.expiresAt);
    }
    if (this.closed) {
      throw new StorageError(
        "mixed_generation",
        "Reader pin is already closed",
        false,
      );
    }
  }

  private async closeResources(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const table of this.tables.values()) table.close();
    await this.store.releaseReaderPin(this.pin.pinId);
  }

  async rows(
    tableName: (typeof COMPLETE_GENERATION_TABLES)[number],
    predicate?: string,
    options: { limit?: number; timeoutMs?: number } = {},
  ): Promise<readonly StorageRow[]> {
    await this.assertReadable();
    const table = this.tables.get(tableName);
    const expected = this.pin.tableVersions.find(
      (item) => item.table === tableName,
    );
    if (!table || !expected || (await table.version()) !== expected.version) {
      throw new StorageError(
        "mixed_generation",
        "Pinned table version does not match the generation manifest",
        false,
        { tableName },
      );
    }
    let effectivePredicate = predicate;
    if (this.pin.publicationProtocol === "reservation-v2") {
      const links = this.tables.get("generation_artifacts");
      if (!links) {
        throw new StorageError(
          "mixed_generation",
          "Generation artifact manifest is unavailable",
          false,
          { generationId: this.pin.generationId },
        );
      }
      const linkedRows = await links
        .query()
        .where(
          `generation_id = ${sqlString(this.pin.generationId)} AND table_name = ${sqlString(tableName)}`,
        )
        .toArray({ timeoutMs: options.timeoutMs });
      const primaryKey = TABLE_PRIMARY_KEYS[tableName];
      const membership = linkedRows
        .map((row) => `${primaryKey} = ${sqlString(String(row.artifact_id))}`)
        .join(" OR ");
      if (!membership) return [];
      effectivePredicate = predicate
        ? `(${predicate}) AND (${membership})`
        : membership;
    }
    let query = table.query();
    if (effectivePredicate) query = query.where(effectivePredicate);
    if (options.limit !== undefined) query = query.limit(options.limit);
    return (await query.toArray({
      timeoutMs: options.timeoutMs,
    })) as StorageRow[];
  }

  async close(): Promise<void> {
    await this.closeResources();
  }
}

export class LanceIntelligenceStore {
  readonly coordinator: StorageCoordinator;
  readonly domain: StorageDomain;
  readonly storagePath: string;

  private constructor(
    private readonly connection: Connection,
    domain: StorageDomain,
    private readonly access: "read-only" | "read-write",
    coordinator: StorageCoordinator,
    private readonly now: () => Date,
  ) {
    this.domain = domain;
    this.storagePath = domain.storagePath;
    this.coordinator = coordinator;
  }

  static async open(
    domainInput: StorageDomain,
    options: StoreOpenOptions = {},
  ): Promise<LanceIntelligenceStore> {
    const domain = StorageDomainSchema.parse(domainInput);
    const storagePath = await assertSupportedStoragePath(domain.storagePath, {
      networkFileSystem: options.networkFileSystem,
      networkProof: options.networkProof,
    });
    if (
      storagePathIdentity(storagePath) !==
      storagePathIdentity(domain.storagePath)
    ) {
      throw new StorageError(
        "storage_unavailable",
        "Storage domain path is not canonical",
        false,
        {
          actual: storagePath,
          configured: domain.storagePath,
        },
      );
    }
    const connection = await lancedb.connect(storagePath, {
      readConsistencyInterval: 0,
    });
    const access = options.access ?? "read-write";
    let store: LanceIntelligenceStore | undefined;
    try {
      if (access === "read-write") {
        const table = await connection.createEmptyTable(
          "coordinator_recovery",
          TABLE_SCHEMAS.coordinator_recovery,
          { existOk: true, mode: "create" },
        );
        table.close();
      } else {
        const names = await connection.tableNames();
        if (!names.includes("coordinator_recovery")) {
          throw new StorageError(
            "storage_unavailable",
            "Read-only storage requires an initialized LanceDB directory",
            false,
          );
        }
      }

      const coordinator = StorageCoordinator.forStorageDirectory(
        connection,
        domain.domainId,
        storagePath,
        options,
      );
      store = new LanceIntelligenceStore(
        connection,
        domain,
        access,
        coordinator,
        options.now ?? (() => new Date()),
      );
      await store.initialize();
      return store;
    } catch (error) {
      if (store) await store.shutdownCoordinator();
      else connection.close();
      throw error;
    }
  }

  private async initialize(): Promise<void> {
    if (this.access === "read-only") {
      const names = new Set(await this.connection.tableNames());
      for (const tableName of ALL_TABLES) {
        if (!names.has(tableName)) {
          throw new StorageError(
            "storage_unavailable",
            `Read-only LanceDB is missing table ${tableName}`,
            false,
          );
        }
        const table = await latestTable(this.connection, tableName);
        try {
          assertCompatibleSchema(tableName, await table.schema());
        } finally {
          table.close();
        }
      }
      return;
    }

    await this.coordinator.exclusive(
      "initialize storage schemas",
      async (lease) => {
        const existingTables = new Set(await this.connection.tableNames());
        for (const tableName of ALL_TABLES) {
          if (existingTables.has(tableName)) continue;
          await this.coordinator.fence(lease);
          const table = await this.connection.createEmptyTable(
            tableName,
            TABLE_SCHEMAS[tableName],
            { mode: "create" },
          );
          table.close();
        }

        const legacyTables: PublicationGenerationTable[] = [];
        for (const tableName of ALL_TABLES) {
          const table = await latestTable(this.connection, tableName);
          try {
            const actual = await table.schema();
            if (isLegacyPublicationTagSchema(tableName, actual)) {
              legacyTables.push(tableName as PublicationGenerationTable);
            } else {
              assertCompatibleSchema(tableName, actual);
            }
          } finally {
            table.close();
          }
        }
        const migrationId = createIdentity("migration", {
          migration: "publication-generation-tag-v1",
          storageDomainId: this.domain.domainId,
        });
        const migrationTable = await latestTable(this.connection, "migrations");
        let existingMigration: Record<string, unknown> | undefined;
        try {
          existingMigration = (
            await migrationTable
              .query()
              .where(`migration_id = ${sqlString(migrationId)}`)
              .limit(1)
              .toArray()
          )[0];
        } finally {
          migrationTable.close();
        }
        if (legacyTables.length > 0 || existingMigration?.state === "running") {
          const startedAt =
            String(existingMigration?.started_at ?? "") ||
            this.now().toISOString();
          const previousPayload = parseJsonRecord(
            existingMigration?.payload_json,
          );
          const previousTargets = Array.isArray(previousPayload?.targetTables)
            ? previousPayload.targetTables.filter(
                (table): table is PublicationGenerationTable =>
                  typeof table === "string" &&
                  COMPLETE_GENERATION_TABLES.includes(
                    table as PublicationGenerationTable,
                  ),
              )
            : [];
          const targetTables = [
            ...new Set([...previousTargets, ...legacyTables]),
          ].sort();
          const migratedTables = targetTables.filter(
            (table) => !legacyTables.includes(table),
          );
          const writeMigration = async (
            state: "completed" | "running",
          ): Promise<void> => {
            const completedAt =
              state === "completed" ? this.now().toISOString() : null;
            await this.writeRowsUnlocked(
              lease,
              "migrations",
              [
                {
                  completed_at: completedAt,
                  from_schema_version:
                    "ast-mcp.intelligence.v1-without-publication-tags",
                  migration_id: migrationId,
                  payload_json: JSON.stringify({
                    migratedTables: [...migratedTables].sort(),
                    migration: "publication-generation-tag-v1",
                    state,
                    targetTables,
                  }),
                  started_at: startedAt,
                  state,
                  to_schema_version: INTELLIGENCE_SCHEMA_VERSION,
                },
              ],
              false,
            );
          };
          await writeMigration("running");
          for (const tableName of legacyTables) {
            await this.coordinator.fence(lease);
            const table = await latestTable(this.connection, tableName);
            try {
              await table.addColumns([
                {
                  name: "publication_generation_id",
                  valueSql: "CAST(NULL AS STRING)",
                },
              ]);
              assertCompatibleSchema(tableName, await table.schema());
            } finally {
              table.close();
            }
            migratedTables.push(tableName);
            await writeMigration("running");
          }
          await writeMigration("completed");
        }
        const membershipMigrationId = createIdentity("migration", {
          migration: "generation-artifacts-v2",
          storageDomainId: this.domain.domainId,
        });
        const completedMembershipMigration = await this.count(
          "migrations",
          `migration_id = ${sqlString(membershipMigrationId)} AND state = 'completed'`,
        );
        if (completedMembershipMigration === 0) {
          const startedAt = this.now().toISOString();
          const writeMembershipMigration = async (
            state: "completed" | "running",
            migratedLinks: number,
          ): Promise<void> => {
            await this.writeRowsUnlocked(
              lease,
              "migrations",
              [
                {
                  completed_at:
                    state === "completed" ? this.now().toISOString() : null,
                  from_schema_version:
                    "ast-mcp.intelligence.v1-publication-tags",
                  migration_id: membershipMigrationId,
                  payload_json: JSON.stringify({
                    migratedLinks,
                    migration: "generation-artifacts-v2",
                    state,
                  }),
                  started_at: startedAt,
                  state,
                  to_schema_version: INTELLIGENCE_SCHEMA_VERSION,
                },
              ],
              false,
            );
          };
          let migratedLinks = 0;
          await writeMembershipMigration("running", migratedLinks);
          for (const tableName of COMPLETE_GENERATION_TABLES) {
            const rows = await withLatestTable(
              this.connection,
              tableName,
              (table) =>
                table
                  .query()
                  .where("publication_generation_id IS NOT NULL")
                  .toArray(),
            );
            const primaryKey = TABLE_PRIMARY_KEYS[tableName];
            const links = rows.map((row) => {
              const artifactId = String(row[primaryKey]);
              const generationId = String(row.publication_generation_id);
              return {
                artifact_id: artifactId,
                created_at: this.now().toISOString(),
                generation_id: generationId,
                link_id: createIdentity("generation-artifact", {
                  artifactId,
                  generationId,
                  tableName,
                }),
                table_name: tableName,
              };
            });
            await this.writeRowsUnlocked(
              lease,
              "generation_artifacts",
              links,
              true,
            );
            migratedLinks += links.length;
            await writeMembershipMigration("running", migratedLinks);
          }
          await writeMembershipMigration("completed", migratedLinks);
        }
        if ((await this.count("retention")) === 0) {
          const now = new Date().toISOString();
          const policyId = createIdentity("retention-policy", {
            storageDomainId: this.domain.domainId,
          });
          await this.writeRowsUnlocked(
            lease,
            "retention",
            [
              {
                keep_failed_jobs_for_days: 7,
                keep_published_generations: 5,
                payload_json: JSON.stringify({
                  keepFailedJobsForDays: 7,
                  keepPublishedGenerations: 5,
                  pinGraceSeconds: 60,
                  policyId,
                  preserveReaderPins: true,
                  unreachableArtifactDays: 7,
                }),
                pin_grace_seconds: 60,
                policy_id: policyId,
                preserve_reader_pins: true,
                unreachable_artifact_days: 7,
                updated_at: now,
              },
            ],
            false,
          );
        }
      },
    );
  }

  async putRows(
    tableName: LanceTableName,
    rows: readonly StorageRow[],
    options: { immutable?: boolean } = {},
  ): Promise<WriteMetrics> {
    this.assertWritable();
    return this.coordinator.exclusive(`write ${tableName}`, (lease) =>
      this.writeRowsUnlocked(
        lease,
        tableName,
        rows,
        options.immutable ?? IMMUTABLE_TABLES.has(tableName),
      ),
    );
  }

  async rows(
    tableName: LanceTableName,
    predicate?: string,
    options: { limit?: number; timeoutMs?: number } = {},
  ): Promise<readonly StorageRow[]> {
    return withLatestTable(this.connection, tableName, async (table) => {
      assertCompatibleSchema(tableName, await table.schema());
      let query = table.query();
      if (predicate) query = query.where(predicate);
      if (options.limit !== undefined) query = query.limit(options.limit);
      return (await query.toArray({
        timeoutMs: options.timeoutMs,
      })) as StorageRow[];
    });
  }

  async count(tableName: LanceTableName, predicate?: string): Promise<number> {
    return withLatestTable(this.connection, tableName, (table) =>
      table.countRows(predicate),
    );
  }

  async countRows(
    tableName: LanceTableName,
    predicate?: string,
  ): Promise<number> {
    return this.count(tableName, predicate);
  }

  currentTimestamp(): string {
    return this.now().toISOString();
  }

  async tableCounts(): Promise<Readonly<Record<LanceTableName, number>>> {
    return Object.fromEntries(
      await Promise.all(
        ALL_TABLES.map(async (tableName) => [
          tableName,
          await this.count(tableName),
        ]),
      ),
    ) as Record<LanceTableName, number>;
  }

  async boundedTableCounts(options: {
    maxRowsPerTable: number;
    timeoutMs: number;
  }): Promise<{
    counts: Readonly<Partial<Record<LanceTableName, number>>>;
    exhaustive: boolean;
    returnedTables: number;
    truncated: boolean;
  }> {
    const deadline = Date.now() + Math.max(0, options.timeoutMs);
    const maxRowsPerTable = Math.max(1, Math.floor(options.maxRowsPerTable));
    const counts: Partial<Record<LanceTableName, number>> = {};
    let truncated = false;
    for (const tableName of ALL_TABLES) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        truncated = true;
        break;
      }
      const table = await latestTable(this.connection, tableName);
      try {
        const rows = await table
          .query()
          .limit(maxRowsPerTable + 1)
          .toArray({ timeoutMs: remainingMs });
        counts[tableName] = Math.min(rows.length, maxRowsPerTable);
        if (rows.length > maxRowsPerTable) truncated = true;
      } catch (error) {
        if (
          Date.now() >= deadline ||
          (error instanceof Error && /tim(?:e|ed)[ -]?out/i.test(error.message))
        ) {
          truncated = true;
          break;
        }
        throw error;
      } finally {
        table.close();
      }
    }
    return {
      counts,
      exhaustive:
        !truncated && Object.keys(counts).length === ALL_TABLES.length,
      returnedTables: Object.keys(counts).length,
      truncated,
    };
  }

  async putJob(jobInput: IntelligenceJob): Promise<WriteMetrics> {
    const job = jobInput;
    return this.putRows(
      "jobs",
      [
        {
          attempt: job.attempt,
          created_at: job.createdAt,
          error_code: job.errorCode,
          idempotency_key: job.idempotencyKey,
          job_id: job.jobId,
          payload_json: JSON.stringify(job),
          revision_id: job.revisionId,
          state: job.state,
          storage_domain_id: job.storageDomainId,
          type: job.type,
          updated_at: job.updatedAt,
          workspace_id: job.workspaceId,
        },
      ],
      { immutable: false },
    );
  }

  private publicationRow(
    publication: PublicationGeneration | PublicationReservation,
  ): StorageRow {
    const published = publication.state === "published";
    const timestamp = published
      ? publication.publishedAt
      : publication.reservedAt;
    return {
      generation_id: publication.generationId,
      immutable: publication.immutable,
      manifest_artifact_id: publication.manifestArtifactId,
      payload_json: JSON.stringify(publication),
      published_at: timestamp,
      revision_id: publication.revisionId,
      schema_version: publication.schemaVersion,
      state: publication.state,
      storage_domain_id: publication.storageDomainId,
      table_versions_json: JSON.stringify(publication.tableVersions),
      workspace_id: publication.workspaceId,
    };
  }

  private async publicationRecord(
    generationId: string,
  ): Promise<PublicationGeneration | PublicationReservation | null> {
    const rows = await withLatestTable(
      this.connection,
      "publications",
      (table) =>
        table
          .query()
          .where(`generation_id = ${sqlString(generationId)}`)
          .limit(1)
          .toArray(),
    );
    const payload = parseJsonRecord(rows[0]?.payload_json);
    if (!payload) return null;
    return payload.state === "published"
      ? PublicationGenerationSchema.parse(payload)
      : PublicationReservationSchema.parse(payload);
  }

  private async activeReservation(
    reservationInput: PublicationReservation,
  ): Promise<PublicationReservation> {
    const token = PublicationReservationSchema.parse(reservationInput);
    if (
      token.storageDomainId !== this.domain.domainId ||
      token.state !== "reserved"
    ) {
      throw new StorageError(
        "publication_conflict",
        "Publication reservation does not belong to this writable domain",
        false,
        { generationId: token.generationId },
      );
    }
    const stored = await this.publicationRecord(token.generationId);
    if (!stored) {
      throw new StorageError(
        "publication_not_found",
        "Publication reservation does not exist",
        false,
        { generationId: token.generationId },
      );
    }
    if (stored.state === "published") {
      throw new StorageError(
        "publication_finalized",
        "Publication reservation is already finalized",
        false,
        { generationId: token.generationId },
      );
    }
    if (stored.state === "abandoned") {
      throw new StorageError(
        "publication_abandoned",
        "Publication reservation was abandoned",
        false,
        { generationId: token.generationId },
      );
    }
    if (
      stored.workspaceId !== token.workspaceId ||
      stored.revisionId !== token.revisionId ||
      stored.manifestArtifactId !== token.manifestArtifactId ||
      stored.attempt !== token.attempt ||
      stored.inputFingerprint !== token.inputFingerprint ||
      stored.publicationProtocol !== token.publicationProtocol ||
      stored.reservationKey !== token.reservationKey ||
      stored.storageDomainId !== token.storageDomainId ||
      JSON.stringify(stored.requiredTables) !==
        JSON.stringify(token.requiredTables)
    ) {
      throw new StorageError(
        "publication_conflict",
        "Publication reservation coordinates do not match",
        false,
        { generationId: token.generationId },
      );
    }
    if (this.now().getTime() >= Date.parse(stored.expiresAt)) {
      throw new StorageError(
        "publication_stale",
        "Publication reservation expired before finalization",
        false,
        { expiresAt: stored.expiresAt, generationId: stored.generationId },
      );
    }
    return stored;
  }

  private async linkGenerationArtifactIdsUnlocked(
    lease: CoordinatorLease,
    reservation: PublicationReservation,
    tableName: PublicationGenerationTable,
    artifactIds: readonly string[],
  ): Promise<void> {
    const links = [...new Set(artifactIds)].map((artifactId) => ({
      artifact_id: artifactId,
      created_at: this.now().toISOString(),
      generation_id: reservation.generationId,
      link_id: createIdentity("generation-artifact", {
        artifactId,
        generationId: reservation.generationId,
        tableName,
      }),
      table_name: tableName,
    }));
    await this.writeRowsUnlocked(lease, "generation_artifacts", links, true);
  }

  private async linkGenerationArtifactsUnlocked(
    lease: CoordinatorLease,
    reservation: PublicationReservation,
    tableName: PublicationGenerationTable,
    rows: readonly StorageRow[],
  ): Promise<void> {
    const primaryKey = TABLE_PRIMARY_KEYS[tableName];
    await this.linkGenerationArtifactIdsUnlocked(
      lease,
      reservation,
      tableName,
      rows.map((row) => String(row[primaryKey])),
    );
  }

  async recordGenerationArtifacts(
    reservationInput: PublicationReservation,
    tableName: PublicationGenerationTable,
    artifactIds: readonly string[],
  ): Promise<void> {
    this.assertWritable();
    await this.coordinator.exclusive(
      `record generation artifacts for ${tableName}`,
      async (lease) => {
        const reservation = await this.activeReservation(reservationInput);
        if (!reservation.requiredTables.includes(tableName)) {
          throw new StorageError(
            "publication_conflict",
            "Generation artifact table was not declared by the reservation",
            false,
            { generationId: reservation.generationId, tableName },
          );
        }
        await this.linkGenerationArtifactIdsUnlocked(
          lease,
          reservation,
          tableName,
          artifactIds,
        );
      },
    );
  }

  private async updateReservedTableVersion(
    lease: CoordinatorLease,
    reservation: PublicationReservation,
    tableName: (typeof COMPLETE_GENERATION_TABLES)[number],
  ): Promise<PublicationReservation> {
    const version = await withLatestTable(this.connection, tableName, (table) =>
      table.version(),
    );
    const versions = new Map(
      reservation.tableVersions.map((pin) => [pin.table, pin.version]),
    );
    versions.set(tableName, version);
    const updated = PublicationReservationSchema.parse({
      ...reservation,
      tableVersions: [...versions]
        .map(([table, tableVersion]) => ({ table, version: tableVersion }))
        .sort((left, right) => left.table.localeCompare(right.table)),
    });
    await this.writeRowsUnlocked(
      lease,
      "publications",
      [this.publicationRow(updated)],
      false,
    );
    return updated;
  }

  private publicationInputFingerprint(input: ReservePublicationInput): string {
    return (
      input.inputFingerprint ??
      createHash("sha256")
        .update(
          JSON.stringify({
            manifestArtifactId: input.manifestArtifactId,
            requiredTables: [...input.requiredTables].sort(),
            reservationKey: input.reservationKey,
            revisionId: input.revisionId,
            storageDomainId: this.domain.domainId,
            workspaceId: input.workspaceId,
          }),
        )
        .digest("hex")
    );
  }

  private publicationCoordinatesMatch(
    record: Record<string, unknown> | null,
    input: ReservePublicationInput,
    inputFingerprint: string,
    requiredTables: readonly string[],
  ): boolean {
    return (
      record?.publicationProtocol === "reservation-v2" &&
      record.storageDomainId === this.domain.domainId &&
      record.workspaceId === input.workspaceId &&
      record.revisionId === input.revisionId &&
      record.manifestArtifactId === input.manifestArtifactId &&
      record.reservationKey === input.reservationKey &&
      record.inputFingerprint === inputFingerprint &&
      JSON.stringify(record.requiredTables) === JSON.stringify(requiredTables)
    );
  }

  private async activeReservedTable(
    reservationInput: PublicationReservation,
    tableName: PublicationGenerationTable,
    conflictMessage: string,
  ): Promise<PublicationReservation> {
    const reservation = await this.activeReservation(reservationInput);
    if (!reservation.requiredTables.includes(tableName)) {
      throw new StorageError("publication_conflict", conflictMessage, false, {
        generationId: reservation.generationId,
        tableName,
      });
    }
    return reservation;
  }

  private async updateRecoveryPublication(
    lease: CoordinatorLease,
    generationId: string,
  ): Promise<void> {
    await withLatestTable(
      this.connection,
      "coordinator_recovery",
      async (recovery) => {
        await this.coordinator.fence(lease);
        const observedAt = this.now().toISOString();
        await recovery.update({
          values: { last_published_generation_id: generationId },
          where:
            `lease_key = 'writer' AND owner_id = ${sqlString(lease.ownerId)} ` +
            `AND epoch = ${lease.epoch} AND lease_expires_at > ${sqlString(observedAt)}`,
        });
      },
    );
  }

  async reusablePublication(
    input: ReservePublicationInput,
  ): Promise<PublicationGeneration | null> {
    const inputFingerprint = this.publicationInputFingerprint(input);
    const requiredTables = [...input.requiredTables].sort();
    const compatible = (await this.rows("publications"))
      .map((row) => parseJsonRecord(row.payload_json))
      .filter(
        (record) =>
          record?.state === "published" &&
          this.publicationCoordinatesMatch(
            record,
            input,
            inputFingerprint,
            requiredTables,
          ),
      )
      .map((record) => PublicationGenerationSchema.safeParse(record))
      .filter((result) => result.success)
      .map((result) => result.data)
      .sort((left, right) => right.publishedAt.localeCompare(left.publishedAt));
    return compatible[0] ?? null;
  }

  async reservePublication(
    input: ReservePublicationInput,
  ): Promise<PublicationReservation> {
    this.assertWritable();
    const ttlMs = boundedInteger(input.ttlMs, 300_000, 1, 86_400_000);
    return this.coordinator.exclusive("reserve publication", async (lease) => {
      const reservedAt = this.now();
      const requiredTables = [...input.requiredTables].sort();
      const inputFingerprint = this.publicationInputFingerprint(input);
      const attempts = (await this.rows("publications"))
        .map((row) => parseJsonRecord(row.payload_json))
        .filter((record) =>
          this.publicationCoordinatesMatch(
            record,
            input,
            inputFingerprint,
            requiredTables,
          ),
        )
        .map((record) => PublicationReservationSchema.safeParse(record))
        .filter((result) => result.success)
        .map((result) => result.data);
      const active = attempts
        .filter(
          (record) =>
            record?.state === "reserved" &&
            Date.parse(String(record.expiresAt)) > reservedAt.getTime(),
        )
        .sort(
          (left, right) => Number(right?.attempt) - Number(left?.attempt),
        )[0];
      if (active) return active;
      const attempt =
        attempts.reduce(
          (maximum, record) => Math.max(maximum, Number(record?.attempt ?? 0)),
          0,
        ) + 1;
      const generationId = createPublicationReservationId({
        attempt,
        inputFingerprint,
        manifestArtifactId: input.manifestArtifactId,
        requiredTables,
        reservationKey: input.reservationKey,
        revisionId: input.revisionId,
        storageDomainId: this.domain.domainId,
        workspaceId: input.workspaceId,
      });
      const reservation = PublicationReservationSchema.parse({
        abandonedAt: null,
        abandonReason: null,
        attempt,
        expiresAt: new Date(reservedAt.getTime() + ttlMs).toISOString(),
        generationId,
        immutable: false,
        inputFingerprint,
        manifestArtifactId: input.manifestArtifactId,
        publicationProtocol: "reservation-v2",
        requiredTables,
        reservationKey: input.reservationKey,
        reservedAt: reservedAt.toISOString(),
        revisionId: input.revisionId,
        schemaVersion: INTELLIGENCE_SCHEMA_VERSION,
        state: "reserved",
        storageDomainId: this.domain.domainId,
        tableVersions: [],
        workspaceId: input.workspaceId,
      });
      await this.writeRowsUnlocked(
        lease,
        "publications",
        [this.publicationRow(reservation)],
        false,
      );
      return reservation;
    });
  }

  async putReservedRows(
    reservationInput: PublicationReservation,
    tableName: (typeof COMPLETE_GENERATION_TABLES)[number],
    rows: readonly StorageRow[],
    options: ReservedWriteOptions = {},
  ): Promise<WriteMetrics> {
    this.assertWritable();
    if (!COMPLETE_GENERATION_TABLES.includes(tableName)) {
      throw new StorageError(
        "publication_conflict",
        "Reserved writes require a publication generation table",
        false,
        { tableName },
      );
    }
    return this.coordinator.exclusive(
      `write reserved ${tableName}`,
      async (lease) => {
        const reservation = await this.activeReservedTable(
          reservationInput,
          tableName,
          "Reserved write table was not declared by the reservation",
        );
        const tagged = rows.map((row) => {
          if (
            row.publication_generation_id !== undefined &&
            row.publication_generation_id !== reservation.generationId
          ) {
            throw new StorageError(
              "publication_conflict",
              "Row publication identity does not match the reservation",
              false,
              { generationId: reservation.generationId, tableName },
            );
          }
          if (
            row.generation_id !== undefined &&
            row.generation_id !== reservation.generationId
          ) {
            throw new StorageError(
              "publication_conflict",
              "Row generation identity does not match the reservation",
              false,
              { generationId: reservation.generationId, tableName },
            );
          }
          return {
            ...row,
            publication_generation_id: null,
          };
        });
        const metrics = await this.writeRowsUnlocked(
          lease,
          tableName,
          tagged,
          options.immutable ?? IMMUTABLE_TABLES.has(tableName),
        );
        await this.linkGenerationArtifactsUnlocked(
          lease,
          reservation,
          tableName,
          tagged,
        );
        await this.updateReservedTableVersion(lease, reservation, tableName);
        return metrics;
      },
    );
  }

  async putReservedRowsBatch(
    reservationInput: PublicationReservation,
    writes: readonly ReservedTableWrite[],
  ): Promise<readonly WriteMetrics[]> {
    this.assertWritable();
    if (
      writes.length === 0 ||
      new Set(writes.map((write) => write.tableName)).size !== writes.length
    ) {
      throw new StorageError(
        "publication_conflict",
        "Reserved batch writes require unique declared tables",
        false,
      );
    }
    return this.coordinator.exclusive(
      "write reserved table batch",
      async (lease) => {
        let reservation = await this.activeReservation(reservationInput);
        const metrics: WriteMetrics[] = [];
        for (const write of writes) {
          if (!reservation.requiredTables.includes(write.tableName)) {
            throw new StorageError(
              "publication_conflict",
              "Reserved batch table was not declared by the reservation",
              false,
              {
                generationId: reservation.generationId,
                tableName: write.tableName,
              },
            );
          }
          const tagged = write.rows.map((row) => {
            if (
              (row.publication_generation_id !== undefined &&
                row.publication_generation_id !== reservation.generationId) ||
              (row.generation_id !== undefined &&
                row.generation_id !== reservation.generationId)
            ) {
              throw new StorageError(
                "publication_conflict",
                "Reserved batch row identity does not match the reservation",
                false,
                {
                  generationId: reservation.generationId,
                  tableName: write.tableName,
                },
              );
            }
            return {
              ...row,
              publication_generation_id: null,
            };
          });
          metrics.push(
            await this.writeRowsUnlocked(
              lease,
              write.tableName,
              tagged,
              write.options?.immutable ?? IMMUTABLE_TABLES.has(write.tableName),
            ),
          );
          await this.linkGenerationArtifactsUnlocked(
            lease,
            reservation,
            write.tableName,
            tagged,
          );
          reservation = await this.updateReservedTableVersion(
            lease,
            reservation,
            write.tableName,
          );
        }
        return metrics;
      },
    );
  }

  async recordReservedTableVersion(
    reservationInput: PublicationReservation,
    tableName: (typeof COMPLETE_GENERATION_TABLES)[number],
    artifactIds: readonly string[] = [],
  ): Promise<PublicationReservation> {
    this.assertWritable();
    if (!COMPLETE_GENERATION_TABLES.includes(tableName)) {
      throw new StorageError(
        "publication_conflict",
        "Reserved version tracking requires a publication generation table",
        false,
        { tableName },
      );
    }
    return this.coordinator.exclusive(
      `record reserved ${tableName}`,
      async (lease) => {
        const reservation = await this.activeReservedTable(
          reservationInput,
          tableName,
          "Reserved version table was not declared by the reservation",
        );
        await this.linkGenerationArtifactIdsUnlocked(
          lease,
          reservation,
          tableName,
          artifactIds,
        );
        return this.updateReservedTableVersion(lease, reservation, tableName);
      },
    );
  }

  async finalizePublication(
    reservationInput: PublicationReservation,
  ): Promise<PublicationGeneration> {
    this.assertWritable();
    return this.coordinator.exclusive("finalize publication", async (lease) => {
      const token = PublicationReservationSchema.parse(reservationInput);
      const existing = await this.publicationRecord(token.generationId);
      if (existing?.state === "published") {
        if (
          existing.publicationProtocol === token.publicationProtocol &&
          existing.attempt === token.attempt &&
          existing.inputFingerprint === token.inputFingerprint &&
          existing.reservationKey === token.reservationKey &&
          existing.workspaceId === token.workspaceId &&
          existing.revisionId === token.revisionId &&
          existing.manifestArtifactId === token.manifestArtifactId &&
          existing.storageDomainId === token.storageDomainId &&
          JSON.stringify(existing.requiredTables) ===
            JSON.stringify(token.requiredTables)
        ) {
          return existing;
        }
        throw new StorageError(
          "publication_conflict",
          "Finalized publication coordinates do not match the reservation",
          false,
          { generationId: token.generationId },
        );
      }
      const reservation = await this.activeReservation(token);
      const completedTables = new Set(
        reservation.tableVersions.map((pin) => pin.table),
      );
      const missingTables = reservation.requiredTables.filter(
        (tableName) => !completedTables.has(tableName),
      );
      if (missingTables.length > 0) {
        throw new StorageError(
          "publication_conflict",
          "Publication reservation has incomplete required producers",
          false,
          { generationId: reservation.generationId, missingTables },
        );
      }
      const producerVersions = new Map(
        reservation.tableVersions.map((pin) => [pin.table, pin.version]),
      );
      const tableVersions = await Promise.all(
        COMPLETE_GENERATION_TABLES.map(async (tableName) => {
          const producerVersion = producerVersions.get(tableName);
          if (producerVersion !== undefined) {
            return { table: tableName, version: producerVersion };
          }
          const version = await withLatestTable(
            this.connection,
            tableName,
            (table) => table.version(),
          );
          return { table: tableName, version };
        }),
      );
      const generation = PublicationGenerationSchema.parse({
        attempt: reservation.attempt,
        generationId: reservation.generationId,
        immutable: true,
        inputFingerprint: reservation.inputFingerprint,
        manifestArtifactId: reservation.manifestArtifactId,
        publicationProtocol: reservation.publicationProtocol,
        publishedAt: this.now().toISOString(),
        requiredTables: reservation.requiredTables,
        reservationKey: reservation.reservationKey,
        revisionId: reservation.revisionId,
        schemaVersion: INTELLIGENCE_SCHEMA_VERSION,
        state: "published",
        storageDomainId: reservation.storageDomainId,
        tableVersions,
        workspaceId: reservation.workspaceId,
      });
      await this.writeRowsUnlocked(
        lease,
        "publications",
        [this.publicationRow(generation)],
        false,
      );
      await this.updateRecoveryPublication(lease, generation.generationId);
      return generation;
    });
  }

  async abandonPublication(
    reservationInput: PublicationReservation,
    reason: string,
  ): Promise<PublicationReservation> {
    this.assertWritable();
    if (!reason.trim()) {
      throw new StorageError(
        "publication_conflict",
        "Publication abandonment requires a reason",
        false,
      );
    }
    return this.coordinator.exclusive("abandon publication", async (lease) => {
      const reservation = await this.activeReservation(reservationInput);
      const abandoned = PublicationReservationSchema.parse({
        ...reservation,
        abandonedAt: this.now().toISOString(),
        abandonReason: reason,
        state: "abandoned",
      });
      await this.writeRowsUnlocked(
        lease,
        "publications",
        [this.publicationRow(abandoned)],
        false,
      );
      return abandoned;
    });
  }

  async publish(input: PublishInput): Promise<PublicationGeneration> {
    this.assertWritable();
    return this.coordinator.exclusive("publish generation", async (lease) => {
      const tableVersions = await Promise.all(
        COMPLETE_GENERATION_TABLES.map(async (tableName) => {
          const version = await withLatestTable(
            this.connection,
            tableName,
            (table) => table.version(),
          );
          return { table: tableName, version };
        }),
      );
      const generationId = createPublicationGenerationId({
        manifestArtifactId: input.manifestArtifactId,
        revisionId: input.revisionId,
        storageDomainId: this.domain.domainId,
        tableVersions,
        workspaceId: input.workspaceId,
      });
      const existing = await withLatestTable(
        this.connection,
        "publications",
        (publicationTable) =>
          publicationTable
            .query()
            .where(`generation_id = ${sqlString(generationId)}`)
            .limit(1)
            .toArray(),
      );
      if (existing[0]) {
        return PublicationGenerationSchema.parse(
          parseJsonRecord(existing[0].payload_json),
        );
      }
      const generation = PublicationGenerationSchema.parse({
        generationId,
        immutable: true,
        manifestArtifactId: input.manifestArtifactId,
        publicationProtocol: "legacy-v1",
        publishedAt: this.now().toISOString(),
        reservationKey: null,
        revisionId: input.revisionId,
        schemaVersion: INTELLIGENCE_SCHEMA_VERSION,
        state: "published",
        storageDomainId: this.domain.domainId,
        tableVersions,
        workspaceId: input.workspaceId,
      });
      await this.writeRowsUnlocked(
        lease,
        "publications",
        [
          {
            generation_id: generation.generationId,
            immutable: true,
            manifest_artifact_id: generation.manifestArtifactId,
            payload_json: JSON.stringify(generation),
            published_at: generation.publishedAt,
            revision_id: generation.revisionId,
            schema_version: generation.schemaVersion,
            state: "published",
            storage_domain_id: generation.storageDomainId,
            table_versions_json: JSON.stringify(generation.tableVersions),
            workspace_id: generation.workspaceId,
          },
        ],
        true,
      );
      await this.updateRecoveryPublication(lease, generation.generationId);
      return generation;
    });
  }

  async latestGeneration(
    workspaceId: string,
    options: { timeoutMs?: number } = {},
  ): Promise<PublicationGeneration | null> {
    const rows = await this.rows(
      "publications",
      `workspace_id = ${sqlString(workspaceId)} AND state = 'published'`,
      { limit: 1_000, timeoutMs: options.timeoutMs ?? 5_000 },
    );
    const generations = rows
      .map((row) => parseJsonRecord(row.payload_json))
      .filter((row): row is Record<string, unknown> => row !== null)
      .map((row) => PublicationGenerationSchema.parse(row))
      .sort((left, right) => right.publishedAt.localeCompare(left.publishedAt));
    return generations[0] ?? null;
  }

  private generationContainsArtifact(
    generation: PublicationGeneration,
    generationLinks: ReadonlySet<string>,
    tableName: PublicationGenerationTable,
    artifactId: string,
    legacyGenerationId?: unknown,
  ): boolean {
    if (generation.publicationProtocol !== "reservation-v2") {
      return (
        tableName === "relationships" ||
        String(legacyGenerationId) === generation.generationId
      );
    }
    return generationLinks.has(`${tableName}\0${artifactId}`);
  }

  async verifyLatestGeneration(
    workspaceId: string,
    revisionId: string,
    options: { maxArtifacts?: number; timeoutMs?: number } = {},
  ): Promise<{
    artifactReferences: number;
    checkedTables: number;
    exhaustive: boolean;
    generation: PublicationGeneration;
  }> {
    const timeoutMs = options.timeoutMs ?? 5_000;
    const deadline = performance.now() + timeoutMs;
    const remainingTimeout = (): number => {
      const remaining = Math.ceil(deadline - performance.now());
      if (remaining > 0) return remaining;
      throw new StorageError(
        "storage_unavailable",
        "Generation verification exceeded its configured timeout",
        true,
        { timeoutMs },
      );
    };
    const maxArtifacts = options.maxArtifacts ?? 100_000;
    const generation = await this.latestGeneration(workspaceId, {
      timeoutMs: remainingTimeout(),
    });
    if (
      !generation ||
      generation.workspaceId !== workspaceId ||
      generation.revisionId !== revisionId ||
      generation.storageDomainId !== this.domain.domainId
    ) {
      throw new StorageError(
        "mixed_generation",
        "Latest publication does not match the selected workspace revision",
        false,
        {
          actualGenerationId: generation?.generationId ?? null,
          revisionId,
          workspaceId,
        },
      );
    }
    const generationLinks = new Set<string>();
    if (generation.publicationProtocol === "reservation-v2") {
      const trackedTables = [
        "artifacts",
        "relationships",
        "revision_manifests",
        "syntax_facts",
      ] as const satisfies readonly PublicationGenerationTable[];
      const linkLimit = maxArtifacts + 3;
      const links = await this.rows(
        "generation_artifacts",
        `generation_id = ${sqlString(generation.generationId)} AND (` +
          trackedTables
            .map((tableName) => `table_name = ${sqlString(tableName)}`)
            .join(" OR ") +
          ")",
        { limit: linkLimit, timeoutMs: remainingTimeout() },
      );
      if (links.length === linkLimit)
        throw new StorageError(
          "storage_unavailable",
          "Generation membership verification exceeded its configured bound",
          true,
          { maxArtifacts },
        );
      for (const link of links) {
        generationLinks.add(
          `${String(link.table_name)}\0${String(link.artifact_id)}`,
        );
      }
    }
    const required = generation.requiredTables ?? COMPLETE_GENERATION_TABLES;
    const pins = new Map(
      generation.tableVersions.map((pin) => [pin.table, pin]),
    );
    for (const tableName of required) {
      const pin = pins.get(tableName);
      if (!pin)
        throw new StorageError(
          "mixed_generation",
          `Publication is missing required table ${tableName}`,
          false,
          { generationId: generation.generationId, tableName },
        );
      const table = await this.connection.openTable(tableName);
      try {
        await table.checkout(pin.version);
        if ((await table.version()) !== pin.version)
          throw new StorageError(
            "mixed_generation",
            `Pinned version is unavailable for ${tableName}`,
            false,
            { tableName, version: pin.version },
          );
        assertCompatibleSchema(tableName, await table.schema());
      } finally {
        table.close();
      }
    }

    const manifestPin = pins.get("revision_manifests");
    const artifactPin = pins.get("artifacts");
    if (!manifestPin || !artifactPin)
      throw new StorageError(
        "mixed_generation",
        "Publication does not pin manifest and artifact tables",
        false,
      );
    const manifestTable = await this.connection.openTable("revision_manifests");
    let artifactTable: Table | undefined;
    try {
      const openedArtifactTable = await this.connection.openTable("artifacts");
      artifactTable = openedArtifactTable;
      await manifestTable.checkout(manifestPin.version);
      await openedArtifactTable.checkout(artifactPin.version);
      const manifest = (
        await manifestTable
          .query()
          .where(
            `artifact_id = ${sqlString(generation.manifestArtifactId)} AND revision_id = ${sqlString(revisionId)}`,
          )
          .limit(1)
          .toArray({ timeoutMs: remainingTimeout() })
      )[0];
      if (!manifest)
        throw new StorageError(
          "mixed_generation",
          "Published revision manifest is unavailable",
          false,
          { manifestArtifactId: generation.manifestArtifactId },
        );
      if (
        String(manifest.artifact_id) !== generation.manifestArtifactId ||
        !this.generationContainsArtifact(
          generation,
          generationLinks,
          "revision_manifests",
          generation.manifestArtifactId,
          manifest.publication_generation_id,
        )
      )
        throw new StorageError(
          "mixed_generation",
          "Published revision manifest is outside the selected generation",
          false,
          { manifestArtifactId: generation.manifestArtifactId },
        );
      let manifestArtifact: artifactContracts.RevisionManifestArtifactInput;
      try {
        manifestArtifact =
          artifactContracts.RevisionManifestArtifactInputSchema.parse(
            JSON.parse(String(manifest.payload_json)),
          );
      } catch (error) {
        throw new StorageError(
          "invalid_schema",
          "Published revision manifest payload is malformed",
          false,
          { cause: error instanceof Error ? error.message : String(error) },
        );
      }
      if (
        manifestArtifact.repositoryId !== String(manifest.repository_id) ||
        manifestArtifact.revisionId !== revisionId ||
        manifestArtifact.revisionId !== String(manifest.revision_id) ||
        manifestArtifact.dirtyOverlayId !==
          (manifest.dirty_overlay_id === null
            ? null
            : String(manifest.dirty_overlay_id)) ||
        manifestArtifact.entries.length !== Number(manifest.entry_count) ||
        artifactContracts.revisionManifestArtifactIdentity(manifestArtifact) !==
          generation.manifestArtifactId
      )
        throw new StorageError(
          "mixed_generation",
          "Published revision manifest identity or coordinates do not match",
          false,
          { manifestArtifactId: generation.manifestArtifactId },
        );
      const persistedManifestRow = (
        await openedArtifactTable
          .query()
          .where(`artifact_id = ${sqlString(generation.manifestArtifactId)}`)
          .limit(1)
          .toArray({ timeoutMs: remainingTimeout() })
      )[0];
      if (!persistedManifestRow)
        throw new StorageError(
          "mixed_generation",
          "Published revision manifest artifact is unavailable",
          false,
          { manifestArtifactId: generation.manifestArtifactId },
        );
      if (
        !this.generationContainsArtifact(
          generation,
          generationLinks,
          "artifacts",
          generation.manifestArtifactId,
          persistedManifestRow.publication_generation_id,
        )
      )
        throw new StorageError(
          "mixed_generation",
          "Published revision manifest artifact is outside the selected generation",
          false,
          {
            generationId: generation.generationId,
            manifestArtifactId: generation.manifestArtifactId,
          },
        );
      if (String(persistedManifestRow.kind) !== "revision-manifest")
        throw new StorageError(
          "invalid_schema",
          "Published revision manifest artifact has the wrong kind",
          false,
          {
            kind: persistedManifestRow.kind,
            manifestArtifactId: generation.manifestArtifactId,
          },
        );
      const persistedPayloadJson = String(persistedManifestRow.payload_json);
      let persistedManifestArtifact: artifactContracts.RevisionManifestArtifactInput;
      try {
        persistedManifestArtifact =
          artifactContracts.RevisionManifestArtifactInputSchema.parse(
            JSON.parse(persistedPayloadJson),
          );
      } catch (error) {
        throw new StorageError(
          "invalid_schema",
          "Published revision manifest artifact payload is malformed",
          false,
          { cause: error instanceof Error ? error.message : String(error) },
        );
      }
      const persistedContentDigest = createHash("sha256")
        .update(persistedPayloadJson)
        .digest("hex");
      if (
        artifactContracts.revisionManifestArtifactIdentity(
          persistedManifestArtifact,
        ) !== generation.manifestArtifactId ||
        JSON.stringify(toComparable(persistedManifestArtifact)) !==
          JSON.stringify(toComparable(manifestArtifact)) ||
        String(persistedManifestRow.content_digest) !==
          persistedContentDigest ||
        Number(persistedManifestRow.byte_length) !==
          Buffer.byteLength(persistedPayloadJson) ||
        Number(manifest.logical_bytes) !==
          Number(persistedManifestRow.byte_length) ||
        persistedManifestRow.content_bytes !== null
      )
        throw new StorageError(
          "invalid_schema",
          "Published revision manifest artifact and manifest table disagree",
          false,
          { manifestArtifactId: generation.manifestArtifactId },
        );

      const entries = manifestArtifact.entries;
      const referenced = {
        artifacts: new Set<string>(),
        relationships: new Set<string>(),
        syntax_facts: new Set<string>(),
      };
      for (const entry of entries) {
        if (!entry || typeof entry !== "object") continue;
        const record = entry as Record<string, unknown>;
        if (typeof record.sourceArtifactId === "string")
          referenced.artifacts.add(record.sourceArtifactId);
        if (typeof record.syntaxFactsArtifactId === "string")
          referenced.syntax_facts.add(record.syntaxFactsArtifactId);
        if (typeof record.resolvedRelationshipsArtifactId === "string")
          referenced.relationships.add(record.resolvedRelationshipsArtifactId);
      }
      const referenceCount = Object.values(referenced).reduce(
        (sum, values) => sum + values.size,
        0,
      );
      if (referenceCount > maxArtifacts)
        throw new StorageError(
          "storage_unavailable",
          "Manifest artifact verification exceeded its configured bound",
          true,
          { maxArtifacts, referenced: referenceCount },
        );
      for (const [tableName, values] of Object.entries(referenced) as Array<
        ["artifacts" | "relationships" | "syntax_facts", Set<string>]
      >) {
        if (!values.size) continue;
        const pin = pins.get(tableName);
        if (!pin)
          throw new StorageError(
            "mixed_generation",
            `Publication does not pin referenced table ${tableName}`,
            false,
          );
        const table =
          tableName === "artifacts"
            ? openedArtifactTable
            : await this.connection.openTable(tableName);
        try {
          await table.checkout(pin.version);
          const predicate = [...values]
            .map((id) => `artifact_id = ${sqlString(id)}`)
            .join(" OR ");
          const rows = await table
            .query()
            .where(predicate)
            .limit(values.size)
            .toArray({ timeoutMs: remainingTimeout() });
          const found = new Set<string>();
          for (const row of rows) {
            const artifactId = String(row.artifact_id);
            if (
              !this.generationContainsArtifact(
                generation,
                generationLinks,
                tableName,
                artifactId,
                row.publication_generation_id,
              )
            )
              throw new StorageError(
                "mixed_generation",
                `Published ${tableName} artifact is outside the selected generation`,
                false,
                { artifactId, generationId: generation.generationId },
              );
            let expectedArtifactId: string;
            if (tableName === "artifacts") {
              if (String(row.kind) !== "source")
                throw new StorageError(
                  "invalid_schema",
                  "Manifest source reference resolves to a non-source artifact",
                  false,
                  { artifactId, kind: row.kind },
                );
              const payload = artifactContracts.SourceArtifactInputSchema.parse(
                JSON.parse(String(row.payload_json)),
              );
              if (payload.contentDigest !== String(row.content_digest))
                throw new StorageError(
                  "invalid_schema",
                  "Source artifact payload and columns disagree",
                  false,
                  { artifactId },
                );
              expectedArtifactId =
                artifactContracts.sourceArtifactIdentity(payload);
            } else if (tableName === "syntax_facts") {
              expectedArtifactId =
                artifactContracts.syntaxFactsArtifactIdentity({
                  languageId: String(row.language_id),
                  parserFingerprint: String(row.parser_fingerprint),
                  sourceArtifactId: String(row.source_artifact_id),
                });
            } else {
              expectedArtifactId =
                artifactContracts.resolvedRelationshipsArtifactIdentity({
                  environmentFingerprint: String(row.environment_fingerprint),
                  resolverFingerprint: String(row.resolver_fingerprint),
                  syntaxFactsArtifactId: String(row.syntax_facts_artifact_id),
                });
            }
            if (expectedArtifactId !== artifactId)
              throw new StorageError(
                "invalid_schema",
                `Published ${tableName} artifact identity is invalid`,
                false,
                { artifactId, expectedArtifactId },
              );
            found.add(artifactId);
          }
          const missing = [...values].filter((id) => !found.has(id));
          if (missing.length)
            throw new StorageError(
              "mixed_generation",
              `Published manifest references unavailable ${tableName} rows`,
              false,
              { missingArtifactIds: missing.slice(0, 100) },
            );
        } finally {
          if (table !== openedArtifactTable) table.close();
        }
      }
      return {
        artifactReferences: referenceCount,
        checkedTables: required.length,
        exhaustive: true,
        generation,
      };
    } finally {
      manifestTable.close();
      artifactTable?.close();
    }
  }

  async pinGeneration(
    generationInput: PublicationGeneration,
    readerId: string,
    ttlMs = 60_000,
  ): Promise<PinnedGenerationReader> {
    this.assertWritable();
    const generation = PublicationGenerationSchema.parse(generationInput);
    const stored = await this.publicationRecord(generation.generationId);
    if (
      stored?.state !== "published" ||
      JSON.stringify(stored) !== JSON.stringify(generation)
    ) {
      throw new StorageError(
        "mixed_generation",
        "Only the exact finalized publication can be pinned",
        false,
        { generationId: generation.generationId },
      );
    }
    const createdAt = this.now();
    const pin = ReaderPinSchema.parse({
      attempt: generation.attempt,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + ttlMs).toISOString(),
      generationId: generation.generationId,
      inputFingerprint: generation.inputFingerprint,
      manifestArtifactId: generation.manifestArtifactId,
      pinId: createIdentity("reader-pin", {
        generationId: generation.generationId,
        nonce: randomUUID(),
        readerId,
      }),
      publicationProtocol: generation.publicationProtocol,
      readerId,
      requiredTables: generation.requiredTables,
      reservationKey: generation.reservationKey,
      revisionId: generation.revisionId,
      storageDomainId: generation.storageDomainId,
      tableVersions: generation.tableVersions,
      workspaceId: generation.workspaceId,
    });
    assertReaderPinsGeneration(generation, pin);
    await this.putRows(
      "reader_pins",
      [
        {
          created_at: pin.createdAt,
          expires_at: pin.expiresAt,
          generation_id: pin.generationId,
          manifest_artifact_id: pin.manifestArtifactId,
          payload_json: JSON.stringify(pin),
          pin_id: pin.pinId,
          reader_id: pin.readerId,
          revision_id: pin.revisionId,
          storage_domain_id: pin.storageDomainId,
          table_versions_json: JSON.stringify(pin.tableVersions),
          workspace_id: pin.workspaceId,
        },
      ],
      { immutable: false },
    );

    const tables = new Map<LanceTableName, Table>();
    try {
      for (const versionPin of pin.tableVersions) {
        const table = await this.connection.openTable(versionPin.table);
        try {
          await table.checkout(versionPin.version);
          if ((await table.version()) !== versionPin.version) {
            throw new StorageError(
              "mixed_generation",
              "LanceDB did not checkout the requested generation version",
              false,
              { table: versionPin.table, version: versionPin.version },
            );
          }
          tables.set(versionPin.table, table);
        } catch (error) {
          table.close();
          throw error;
        }
      }
      if (pin.publicationProtocol === "reservation-v2") {
        const links = await latestTable(
          this.connection,
          "generation_artifacts",
        );
        tables.set("generation_artifacts", links);
      }
    } catch (error) {
      for (const table of tables.values()) table.close();
      await this.releaseReaderPin(pin.pinId);
      throw error;
    }
    if (this.now().getTime() >= Date.parse(pin.expiresAt)) {
      for (const table of tables.values()) table.close();
      await this.releaseReaderPin(pin.pinId);
      throw new ReaderPinExpiredError(pin.pinId, pin.expiresAt);
    }
    return new PinnedGenerationReader(this, pin, tables, this.now);
  }

  async pinLatestGeneration(
    workspaceId: string,
    readerId: string,
    ttlMs = 60_000,
  ): Promise<PinnedGenerationReader> {
    const generation = await this.latestGeneration(workspaceId);
    if (!generation) {
      throw new StorageError(
        "mixed_generation",
        "Workspace has no published generation to pin",
        false,
        { workspaceId },
      );
    }
    return this.pinGeneration(generation, readerId, ttlMs);
  }

  async releaseReaderPin(pinId: string): Promise<void> {
    if (this.access === "read-only") return;
    await this.coordinator.exclusive("release reader pin", async (lease) => {
      await withLatestTable(this.connection, "reader_pins", async (table) => {
        await this.coordinator.fence(lease);
        await table.delete(`pin_id = ${sqlString(pinId)}`);
      });
    });
  }

  async ensureIndex(tableName: LanceTableName, column: string): Promise<void> {
    this.assertWritable();
    await this.coordinator.exclusive(
      `create ${tableName}.${column} index`,
      async (lease) => {
        await withLatestTable(this.connection, tableName, async (table) => {
          const field = (await table.schema()).fields.find(
            (candidate) => candidate.name === column,
          );
          if (!field) {
            throw new StorageError(
              "invalid_schema",
              `Cannot index absent column ${column}`,
              false,
              {
                column,
                tableName,
              },
            );
          }
          const indices = await table.listIndices();
          if (!indices.some((index) => index.columns.includes(column))) {
            await this.coordinator.fence(lease);
            await table.createIndex(column);
          }
        });
      },
    );
  }

  async serializeMigration<T>(
    name: string,
    migration: () => Promise<T>,
  ): Promise<T> {
    this.assertWritable();
    return this.coordinator.exclusive(`migration: ${name}`, () => migration());
  }

  async recover(): Promise<RecoveryResult> {
    this.assertWritable();
    return this.coordinator.exclusive(
      "recover interrupted storage",
      async (lease) => {
        const runningJobs = await this.rows("jobs", "state = 'running'");
        const now = this.now().toISOString();
        const resumedJobIds: string[] = [];
        const abandonedReservationIds: string[] = [];
        for (const job of runningJobs) {
          const jobId = String(job.job_id);
          resumedJobIds.push(jobId);
          const payload = parseJsonRecord(job.payload_json) ?? {};
          await this.writeRowsUnlocked(
            lease,
            "jobs",
            [
              {
                ...job,
                attempt: Number(job.attempt) + 1,
                error_code: "recovered_interrupted",
                payload_json: JSON.stringify({
                  ...payload,
                  attempt: Number(job.attempt) + 1,
                  errorCode: "recovered_interrupted",
                  state: "pending",
                  updatedAt: now,
                }),
                state: "pending",
                updated_at: now,
              },
            ],
            false,
          );
        }
        const publicationPayloads = (await this.rows("publications"))
          .map((row) => parseJsonRecord(row.payload_json))
          .filter((row): row is Record<string, unknown> => row !== null);
        const publications = publicationPayloads
          .filter((row) => row.state === "published")
          .map((row) => PublicationGenerationSchema.parse(row))
          .sort((left, right) =>
            right.publishedAt.localeCompare(left.publishedAt),
          );
        for (const payload of publicationPayloads) {
          if (payload.state !== "reserved") continue;
          const reservation = PublicationReservationSchema.parse(payload);
          if (Date.parse(reservation.expiresAt) > this.now().getTime())
            continue;
          const abandoned = PublicationReservationSchema.parse({
            ...reservation,
            abandonedAt: now,
            abandonReason: "recovered_stale_reservation",
            state: "abandoned",
          });
          await this.writeRowsUnlocked(
            lease,
            "publications",
            [this.publicationRow(abandoned)],
            false,
          );
          abandonedReservationIds.push(abandoned.generationId);
        }
        const latest = publications[0] ?? null;
        const pinnedVersions = new Map(
          latest?.tableVersions.map((pin) => [pin.table, pin.version]) ?? [],
        );
        let ignored = 0;
        for (const tableName of COMPLETE_GENERATION_TABLES) {
          const current = await withLatestTable(
            this.connection,
            tableName,
            (table) => table.version(),
          );
          ignored += Math.max(
            0,
            current - (pinnedVersions.get(tableName) ?? 1),
          );
        }
        await withLatestTable(
          this.connection,
          "coordinator_recovery",
          async (recovery) => {
            await this.coordinator.fence(lease);
            await recovery.update({
              values: {
                in_flight_job_ids_json: "[]",
                last_published_generation_id: latest?.generationId ?? null,
                recovered_at: now,
                state: "recovered",
              },
              where:
                `lease_key = 'writer' AND owner_id = ${sqlString(lease.ownerId)} ` +
                `AND epoch = ${lease.epoch} AND lease_expires_at > ${sqlString(new Date().toISOString())}`,
            });
          },
        );
        return {
          abandonedReservationIds,
          ignoredUnpublishedTableVersions: ignored,
          lastPublishedGenerationId: latest?.generationId ?? null,
          resumedJobIds,
        };
      },
    );
  }

  async metrics(): Promise<StorageMetrics> {
    const rows = Object.fromEntries(
      await Promise.all(
        CONTENT_TABLES.map(async (tableName) => [
          tableName,
          await this.rows(tableName),
        ]),
      ),
    ) as Record<(typeof CONTENT_TABLES)[number], readonly StorageRow[]>;
    const workspaces = await this.rows("workspaces", "active = true");
    const physicalArtifacts = PHYSICAL_ARTIFACT_TABLES.reduce(
      (sum, tableName) => sum + rows[tableName].length,
      0,
    );
    const physicalBytes = PHYSICAL_ARTIFACT_TABLES.reduce(
      (sum, tableName) =>
        sum +
        rows[tableName].reduce((subtotal, row) => subtotal + rowBytes(row), 0),
      0,
    );
    const logicalBytes = workspaces.reduce(
      (sum, row) => sum + Number(row.logical_bytes ?? 0),
      0,
    );
    const manifestReferences = rows.revision_manifests.reduce(
      (sum, row) => sum + Number(row.entry_count ?? 0),
      0,
    );
    return {
      logicalBytes,
      logicalReferences: workspaces.length + manifestReferences,
      physicalArtifacts,
      physicalBytes,
      reusedBytes: Math.max(0, logicalBytes - physicalBytes),
      storageGrowthBytes: physicalBytes,
    };
  }

  async collect(options: CollectionOptions = {}): Promise<CollectionResult> {
    this.assertWritable();
    return this.coordinator.exclusive(
      "collect unreachable artifacts",
      async (lease) => {
        const now = options.now ?? new Date();
        const retentionRows = await this.rows("retention");
        const retention = [...retentionRows].sort(
          (left, right) =>
            String(right.updated_at).localeCompare(String(left.updated_at)) ||
            String(left.policy_id).localeCompare(String(right.policy_id)),
        )[0];
        const keepFailedJobsForDays = boundedInteger(
          options.keepFailedJobsForDays ?? retention?.keep_failed_jobs_for_days,
          7,
          0,
          36_500,
        );
        const keepPublishedGenerations = boundedInteger(
          options.keepPublishedGenerations ??
            retention?.keep_published_generations,
          5,
          1,
          1_000,
        );
        const pinGraceSeconds = boundedInteger(
          options.pinGraceSeconds ?? retention?.pin_grace_seconds,
          60,
          0,
          86_400,
        );
        const unreachableArtifactDays = boundedInteger(
          options.unreachableArtifactDays ??
            retention?.unreachable_artifact_days,
          7,
          0,
          36_500,
        );
        const maxDeletesPerTable = boundedInteger(
          options.maxDeletesPerTable,
          1_000,
          1,
          10_000,
        );
        const cutoff = new Date(
          now.getTime() - unreachableArtifactDays * 24 * 60 * 60 * 1_000,
        ).toISOString();
        const terminalJobCutoff = new Date(
          now.getTime() - keepFailedJobsForDays * 24 * 60 * 60 * 1_000,
        ).toISOString();
        const deletions: Partial<Record<LanceTableName, number>> = {};
        const deleteCandidates = async (
          tableName: LanceTableName,
          rows: readonly StorageRow[],
        ): Promise<void> => {
          const primaryKey = TABLE_PRIMARY_KEYS[tableName];
          const candidates = [...rows]
            .sort((left, right) =>
              String(left[primaryKey]).localeCompare(String(right[primaryKey])),
            )
            .slice(0, maxDeletesPerTable);
          if (candidates.length === 0) return;
          await withLatestTable(this.connection, tableName, async (table) => {
            await this.coordinator.fence(lease);
            await table.delete(
              candidates
                .map(
                  (row) =>
                    `${primaryKey} = ${sqlString(String(row[primaryKey]))}`,
                )
                .join(" OR "),
            );
          });
          deletions[tableName] =
            (deletions[tableName] ?? 0) + candidates.length;
        };
        const protectedRevisions = new Set(options.pinnedRevisionIds ?? []);
        const protectedGenerations = new Set<string>();
        const protectedIdentities = new Set<string>();

        const workspaceRows = await this.rows("workspaces", "active = true");
        for (const row of workspaceRows) {
          protectedRevisions.add(String(row.revision_id));
          if (row.manifest_artifact_id) {
            protectedIdentities.add(String(row.manifest_artifact_id));
          }
          collectIdentityStrings(
            parseJsonRecord(row.payload_json),
            protectedIdentities,
          );
        }

        const jobRows = await this.rows("jobs");
        const activeJobRows = jobRows.filter(
          (row) => row.state === "pending" || row.state === "running",
        );
        for (const row of activeJobRows) {
          protectedRevisions.add(String(row.revision_id));
          collectIdentityStrings(
            parseJsonRecord(row.payload_json),
            protectedIdentities,
          );
        }
        await deleteCandidates(
          "jobs",
          jobRows.filter(
            (row) =>
              row.state !== "pending" &&
              row.state !== "running" &&
              String(row.updated_at) <= terminalJobCutoff,
          ),
        );

        const pinRows = await this.rows("reader_pins");
        const activePinRows = pinRows.filter(
          (row) =>
            Date.parse(String(row.expires_at)) + pinGraceSeconds * 1_000 >
            now.getTime(),
        );
        await deleteCandidates(
          "reader_pins",
          pinRows.filter((row) => !activePinRows.includes(row)),
        );
        for (const row of activePinRows) {
          protectedGenerations.add(String(row.generation_id));
          protectedRevisions.add(String(row.revision_id));
          protectedIdentities.add(String(row.manifest_artifact_id));
        }

        const publicationRows = await this.rows("publications");
        for (const row of publicationRows) {
          const record = parseJsonRecord(row.payload_json);
          if (
            row.state === "reserved" &&
            Date.parse(String(record?.expiresAt ?? "")) > now.getTime()
          ) {
            protectedGenerations.add(String(row.generation_id));
          }
        }
        const publications = publicationRows
          .filter((row) => row.state === "published")
          .map((row) => ({
            generation: PublicationGenerationSchema.parse(
              parseJsonRecord(row.payload_json),
            ),
            row,
          }))
          .sort(
            (left, right) =>
              right.generation.publishedAt.localeCompare(
                left.generation.publishedAt,
              ) ||
              left.generation.generationId.localeCompare(
                right.generation.generationId,
              ),
          );
        const keptPerWorkspace = new Map<string, number>();
        const obsoletePublications: StorageRow[] = publicationRows.filter(
          (row) =>
            row.state === "abandoned" ||
            (row.state === "reserved" &&
              Date.parse(
                String(parseJsonRecord(row.payload_json)?.expiresAt ?? ""),
              ) <= now.getTime()),
        );
        for (const { generation, row } of publications) {
          const retained = keptPerWorkspace.get(generation.workspaceId) ?? 0;
          if (
            retained < keepPublishedGenerations ||
            protectedGenerations.has(generation.generationId)
          ) {
            keptPerWorkspace.set(generation.workspaceId, retained + 1);
            protectedGenerations.add(generation.generationId);
            protectedRevisions.add(generation.revisionId);
            protectedIdentities.add(generation.manifestArtifactId);
          } else {
            obsoletePublications.push(row);
          }
        }
        await deleteCandidates("publications", obsoletePublications);
        const generationArtifactRows = await this.rows("generation_artifacts");
        await deleteCandidates(
          "generation_artifacts",
          generationArtifactRows.filter(
            (row) =>
              String(row.created_at) <= cutoff &&
              !protectedGenerations.has(String(row.generation_id)),
          ),
        );
        for (const row of generationArtifactRows) {
          if (protectedGenerations.has(String(row.generation_id))) {
            protectedIdentities.add(String(row.artifact_id));
          }
        }

        const collectProtectedRows = (
          rows: readonly StorageRow[],
          revisionColumn: "base_revision_id" | "revision_id",
        ): void => {
          for (const row of rows) {
            if (
              protectedRevisions.has(String(row[revisionColumn])) ||
              protectedIdentities.has(String(row.artifact_id))
            ) {
              protectedIdentities.add(String(row.artifact_id));
              collectIdentityStrings(
                parseJsonRecord(row.payload_json),
                protectedIdentities,
              );
            }
          }
        };
        const manifestRows = await this.rows("revision_manifests");
        collectProtectedRows(manifestRows, "revision_id");
        const overlayRows = await this.rows("dirty_overlays");
        collectProtectedRows(overlayRows, "base_revision_id");

        const syntaxRows = await this.rows("syntax_facts");
        const relationshipRows = await this.rows("relationships");
        const chunkRows = await this.rows("chunks");
        const embeddingRows = await this.rows("embeddings");
        const graphRows = {
          communities: await this.rows("communities"),
          graph_edges: await this.rows("graph_edges"),
          graph_evidence: await this.rows("graph_evidence"),
          graph_nodes: await this.rows("graph_nodes"),
          graph_occurrences: await this.rows("graph_occurrences"),
          revision_membership: await this.rows("revision_membership"),
          summaries: await this.rows("summaries"),
        } as const;
        for (const row of graphRows.revision_membership) {
          if (
            protectedRevisions.has(String(row.revision_id)) ||
            protectedGenerations.has(String(row.generation_id))
          ) {
            protectedIdentities.add(String(row.membership_id));
            protectedIdentities.add(String(row.entity_id));
          }
        }

        let changed = true;
        while (changed) {
          const before = protectedIdentities.size;
          for (const row of syntaxRows) {
            if (protectedIdentities.has(String(row.artifact_id))) {
              protectedIdentities.add(String(row.source_artifact_id));
            }
          }
          for (const row of relationshipRows) {
            if (protectedIdentities.has(String(row.artifact_id))) {
              protectedIdentities.add(String(row.syntax_facts_artifact_id));
              collectIdentityStrings(
                parseJsonRecord(row.payload_json),
                protectedIdentities,
              );
            }
          }
          for (const row of chunkRows) {
            if (
              protectedIdentities.has(String(row.artifact_id)) ||
              (row.source_artifact_id &&
                protectedIdentities.has(String(row.source_artifact_id))) ||
              (row.syntax_facts_artifact_id &&
                protectedIdentities.has(String(row.syntax_facts_artifact_id)))
            ) {
              protectedIdentities.add(String(row.artifact_id));
              if (row.source_artifact_id)
                protectedIdentities.add(String(row.source_artifact_id));
              if (row.syntax_facts_artifact_id) {
                protectedIdentities.add(String(row.syntax_facts_artifact_id));
              }
            }
          }
          for (const row of embeddingRows) {
            if (
              protectedIdentities.has(String(row.artifact_id)) ||
              protectedIdentities.has(String(row.chunk_artifact_id))
            ) {
              protectedIdentities.add(String(row.artifact_id));
              protectedIdentities.add(String(row.chunk_artifact_id));
            }
          }
          for (const row of graphRows.graph_occurrences) {
            if (
              protectedIdentities.has(String(row.occurrence_id)) ||
              protectedIdentities.has(String(row.node_id)) ||
              protectedIdentities.has(String(row.source_artifact_id))
            ) {
              protectedIdentities.add(String(row.occurrence_id));
              protectedIdentities.add(String(row.node_id));
              protectedIdentities.add(String(row.source_artifact_id));
            }
          }
          for (const row of graphRows.graph_edges) {
            if (
              protectedIdentities.has(String(row.edge_id)) ||
              protectedIdentities.has(String(row.source_node_id)) ||
              protectedIdentities.has(String(row.target_node_id))
            ) {
              protectedIdentities.add(String(row.edge_id));
              protectedIdentities.add(String(row.source_node_id));
              protectedIdentities.add(String(row.target_node_id));
            }
          }
          for (const row of graphRows.graph_evidence) {
            if (
              protectedIdentities.has(String(row.evidence_id)) ||
              protectedIdentities.has(String(row.edge_id)) ||
              protectedIdentities.has(String(row.occurrence_id)) ||
              protectedIdentities.has(String(row.source_artifact_id))
            ) {
              protectedIdentities.add(String(row.evidence_id));
              protectedIdentities.add(String(row.edge_id));
              protectedIdentities.add(String(row.occurrence_id));
              protectedIdentities.add(String(row.source_artifact_id));
            }
          }
          for (const row of graphRows.communities) {
            const members = new Set<string>();
            collectIdentityStrings(
              JSON.parse(String(row.member_ids_json)),
              members,
            );
            if (
              protectedGenerations.has(String(row.generation_id)) ||
              [...members].some((member) => protectedIdentities.has(member))
            ) {
              protectedIdentities.add(String(row.community_id));
              for (const member of members) protectedIdentities.add(member);
            }
          }
          for (const row of graphRows.summaries) {
            if (
              protectedGenerations.has(String(row.generation_id)) ||
              protectedIdentities.has(String(row.subject_id))
            ) {
              protectedIdentities.add(String(row.summary_id));
              protectedIdentities.add(String(row.subject_id));
            }
          }
          changed = protectedIdentities.size !== before;
        }

        const artifactRows: Partial<
          Record<LanceTableName, readonly StorageRow[]>
        > = {
          artifacts: await this.rows("artifacts"),
          chunks: chunkRows,
          dirty_overlays: overlayRows,
          embeddings: embeddingRows,
          relationships: relationshipRows,
          revision_manifests: manifestRows,
          syntax_facts: syntaxRows,
        };
        for (const tableName of CONTENT_TABLES) {
          const primaryKey = TABLE_PRIMARY_KEYS[tableName];
          const candidates = (artifactRows[tableName] ?? []).filter(
            (row) =>
              String(row.created_at) <= cutoff &&
              !protectedIdentities.has(String(row[primaryKey])),
          );
          await deleteCandidates(tableName, candidates);
        }

        const graphTables = [
          "graph_nodes",
          "graph_occurrences",
          "graph_edges",
          "graph_evidence",
          "revision_membership",
          "communities",
          "summaries",
        ] as const satisfies readonly LanceTableName[];
        for (const tableName of graphTables) {
          const primaryKey = TABLE_PRIMARY_KEYS[tableName];
          const rows = graphRows[tableName];
          const candidates = rows.filter(
            (row) =>
              String(row.created_at) <= cutoff &&
              !protectedIdentities.has(String(row[primaryKey])) &&
              !protectedGenerations.has(String(row.generation_id ?? "")) &&
              !protectedRevisions.has(String(row.revision_id ?? "")),
          );
          await deleteCandidates(tableName, candidates);
        }

        return {
          deletedByTable: deletions,
          protectedArtifactIds: protectedIdentities.size,
          protectedGenerationIds: protectedGenerations.size,
          protectedRevisionIds: protectedRevisions.size,
        };
      },
    );
  }

  async relocationPreview(
    destinationPathInput: string,
    policy: {
      networkFileSystem?: boolean;
      networkProof?: NetworkFileSystemProof;
    } = {},
  ): Promise<RelocationPreview> {
    const destinationPath = await assertSupportedStoragePath(
      destinationPathInput,
      policy,
    );
    validateRelocationCoordinates(this.storagePath, destinationPath);
    return this.coordinator.exclusive(
      "preview storage relocation",
      async () => {
        const files = await snapshotStorageDirectory(this.storagePath);
        return {
          destinationPath,
          files,
          sourcePath: this.storagePath,
          tableCounts: await this.tableCounts(),
          totalBytes: files.reduce((sum, file) => sum + file.size, 0),
        };
      },
    );
  }

  async relocate(preview: RelocationPreview): Promise<RelocationResult> {
    this.assertWritable();
    if (
      storagePathIdentity(preview.sourcePath) !==
        storagePathIdentity(this.storagePath) ||
      JSON.stringify(preview.tableCounts) !==
        JSON.stringify(await this.tableCounts())
    ) {
      throw new StorageError(
        "relocation_verification_failed",
        "Relocation preview no longer matches the source store",
        false,
      );
    }
    return this.coordinator.exclusive("relocate storage", async (lease) => {
      const currentFiles = await snapshotStorageDirectory(this.storagePath);
      if (JSON.stringify(currentFiles) !== JSON.stringify(preview.files)) {
        throw new StorageError(
          "relocation_verification_failed",
          "Relocation preview is stale",
          false,
        );
      }
      return copyRelocationSnapshot(preview, () =>
        this.coordinator.fence(lease),
      );
    });
  }

  async shutdownCoordinator(): Promise<void> {
    const coordinatorOwnsConnection = this.coordinator.usesConnection(
      this.connection,
    );
    await this.coordinator.release();
    if (!coordinatorOwnsConnection) this.connection.close();
  }

  private assertWritable(): void {
    if (this.access === "read-only") {
      throw new StorageError(
        "storage_unavailable",
        "Read-only LanceDB store cannot mutate persistent state",
        false,
      );
    }
  }

  private async writeRowsUnlocked(
    lease: CoordinatorLease,
    tableName: LanceTableName,
    rows: readonly StorageRow[],
    immutable: boolean,
  ): Promise<WriteMetrics> {
    if (rows.length === 0) {
      return {
        insertedBytes: 0,
        insertedRows: 0,
        logicalBytes: 0,
        reusedBytes: 0,
        reusedRows: 0,
      };
    }
    const prepared = rows.map((row) => prepareRow(tableName, row));
    const primaryKey = TABLE_PRIMARY_KEYS[tableName];
    const keys = prepared.map((row) => {
      const value = row[primaryKey];
      if (typeof value !== "string" || value.length === 0) {
        throw new StorageError(
          "invalid_schema",
          `Primary key ${primaryKey} must be a non-empty string`,
          false,
          { tableName },
        );
      }
      return value;
    });
    if (new Set(keys).size !== keys.length) {
      throw new StorageError(
        "invalid_schema",
        `Write batch for ${tableName} contains duplicate primary keys`,
        false,
      );
    }

    const table = await latestTable(this.connection, tableName);
    try {
      assertCompatibleSchema(tableName, await table.schema());
      const predicate = keys
        .map((key) => `${primaryKey} = ${sqlString(key)}`)
        .join(" OR ");
      const existingRows = (await table
        .query()
        .where(predicate)
        .toArray()) as StorageRow[];
      const existing = new Map(
        existingRows.map((row) => [String(row[primaryKey]), row]),
      );
      const missing: StorageRow[] = [];
      let reusedRows = 0;
      let reusedBytes = 0;
      for (const row of prepared) {
        const key = String(row[primaryKey]);
        const prior = existing.get(key);
        if (!prior) {
          missing.push(row);
          continue;
        }
        const preserveLegacyPublicationTag =
          immutable &&
          row.publication_generation_id === null &&
          typeof prior.publication_generation_id === "string";
        const comparableRow = immutable
          ? {
              ...row,
              ...(preserveLegacyPublicationTag
                ? {
                    publication_generation_id: prior.publication_generation_id,
                  }
                : {}),
              ...("created_at" in row ? { created_at: prior.created_at } : {}),
            }
          : row;
        if (immutable && !equivalentRows(prior, comparableRow)) {
          throw new StorageError(
            "immutable_conflict",
            `Immutable LanceDB row ${key} has conflicting content`,
            false,
            { primaryKey, tableName },
          );
        }
        reusedRows += 1;
        reusedBytes += rowBytes(row);
      }

      if (immutable) {
        if (missing.length > 0) {
          await this.coordinator.fence(lease);
          await table
            .mergeInsert(primaryKey)
            .whenNotMatchedInsertAll()
            .execute(missing, { timeoutMs: 10_000 });
        }
      } else {
        await this.coordinator.fence(lease);
        await table
          .mergeInsert(primaryKey)
          .whenMatchedUpdateAll()
          .whenNotMatchedInsertAll()
          .execute(prepared, { timeoutMs: 10_000 });
      }
      const insertedBytes = missing.reduce(
        (sum, row) => sum + rowBytes(row),
        0,
      );
      return {
        insertedBytes,
        insertedRows: missing.length,
        logicalBytes: insertedBytes + reusedBytes,
        reusedBytes,
        reusedRows,
      };
    } finally {
      table.close();
    }
  }
}
