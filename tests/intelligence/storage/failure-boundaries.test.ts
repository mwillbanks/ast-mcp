import { describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as lancedb from "@lancedb/lancedb";
import { Schema } from "apache-arrow";

import {
  createIdentity,
  INTELLIGENCE_SCHEMA_VERSION,
} from "../../../src/intelligence/contracts/common.ts";
import {
  createStorageDomainId,
  type StorageDomain,
} from "../../../src/intelligence/contracts/storage.ts";
import { toLanceSchema } from "../../../src/intelligence/storage/arrow.ts";
import {
  LanceIntelligenceStore,
  TABLE_SCHEMAS,
} from "../../../src/intelligence/storage/index.ts";

const OLD = "2020-01-01T00:00:00.000Z";

async function domain(): Promise<StorageDomain> {
  const storagePath = await mkdtemp(
    join(tmpdir(), "ast-mcp-store-boundaries-"),
  );
  const placement = { kind: "explicit" as const, path: storagePath };
  return {
    domainId: createStorageDomainId({
      engine: "lancedb",
      placement,
      pool: "shared",
      storagePath,
    }),
    engine: "lancedb",
    placement,
    pool: "shared",
    schemaVersion: INTELLIGENCE_SCHEMA_VERSION,
    storagePath,
  };
}

function source(tag: string, publicationGenerationId: string | null = null) {
  return {
    artifact_id: createIdentity("artifact", { tag }),
    byte_length: 1,
    content_bytes: new Uint8Array([1]),
    content_digest: "a".repeat(64),
    created_at: OLD,
    kind: "source",
    payload_json: "{}",
    publication_generation_id: publicationGenerationId,
  };
}

describe("persistent store failure boundaries", () => {
  test("retries an interrupted schema migration and rebuilds legacy generation membership", async () => {
    const storage = await domain();
    let store = await LanceIntelligenceStore.open(storage);
    const migrationId = createIdentity("migration", {
      migration: "publication-generation-tag-v1",
      storageDomainId: storage.domainId,
    });
    const membershipId = createIdentity("migration", {
      migration: "generation-artifacts-v2",
      storageDomainId: storage.domainId,
    });
    await store.putRows(
      "migrations",
      [
        {
          completed_at: null,
          from_schema_version: "legacy",
          migration_id: migrationId,
          payload_json: JSON.stringify({
            targetTables: ["artifacts", "not-a-table", 42],
          }),
          started_at: OLD,
          state: "running",
          to_schema_version: INTELLIGENCE_SCHEMA_VERSION,
        },
      ],
      { immutable: false },
    );
    await store.shutdownCoordinator();
    const connection = await lancedb.connect(storage.storagePath);
    try {
      await connection.dropTable("artifacts");
      const legacy = await connection.createEmptyTable(
        "artifacts",
        toLanceSchema(
          new Schema(
            TABLE_SCHEMAS.artifacts.fields.filter(
              (field) => field.name !== "publication_generation_id",
            ),
          ),
        ),
      );
      const prototype = Object.getPrototypeOf(legacy) as typeof legacy;
      legacy.close();
      const failure = new Error("schema migration interrupted");
      const addColumns = spyOn(prototype, "addColumns").mockRejectedValueOnce(
        failure,
      );
      try {
        await expect(LanceIntelligenceStore.open(storage)).rejects.toBe(
          failure,
        );
      } finally {
        addColumns.mockRestore();
      }
      store = await LanceIntelligenceStore.open(storage);
      const migration = (
        await store.rows("migrations", `migration_id = '${migrationId}'`)
      )[0];
      expect(migration?.started_at).toBe(OLD);
      expect(migration?.state).toBe("completed");
      expect(JSON.parse(String(migration?.payload_json))).toMatchObject({
        migratedTables: ["artifacts"],
        targetTables: ["artifacts"],
      });
      const generationId = createIdentity("generation", { tag: "legacy" });
      const artifact = source("legacy", generationId);
      await store.putRows("artifacts", [artifact]);
      await store.shutdownCoordinator();
      const migrations = await connection.openTable("migrations");
      try {
        await migrations.delete(`migration_id = '${membershipId}'`);
      } finally {
        migrations.close();
      }
      store = await LanceIntelligenceStore.open(storage);
      expect(await store.rows("generation_artifacts")).toMatchObject([
        {
          artifact_id: artifact.artifact_id,
          generation_id: generationId,
          table_name: "artifacts",
        },
      ]);
      const completed = (
        await store.rows("migrations", `migration_id = '${membershipId}'`)
      )[0];
      expect(JSON.parse(String(completed?.payload_json))).toMatchObject({
        migratedLinks: 1,
        state: "completed",
      });
      await store.shutdownCoordinator();
      store = await LanceIntelligenceStore.open(storage);
      expect(await store.count("generation_artifacts")).toBe(1);
    } finally {
      await store.shutdownCoordinator();
      connection.close();
      await rm(storage.storagePath, { recursive: true, force: true });
    }
  });

  test("rejects stale relocation previews after row and file changes without copying", async () => {
    const storage = await domain();
    const destinationRoot = await mkdtemp(
      join(tmpdir(), "ast-mcp-store-destination-"),
    );
    const store = await LanceIntelligenceStore.open(storage);
    try {
      const destination = join(destinationRoot, "store");
      const preview = await store.relocationPreview(destination);
      await store.putRows("artifacts", [source("new")]);
      await expect(store.relocate(preview)).rejects.toMatchObject({
        code: "relocation_verification_failed",
      });
      const refreshed = await store.relocationPreview(destination);
      await writeFile(join(storage.storagePath, "external-marker"), "changed");
      await expect(store.relocate(refreshed)).rejects.toMatchObject({
        code: "relocation_verification_failed",
        message: "Relocation preview is stale",
      });
      expect(await store.count("artifacts")).toBe(1);
    } finally {
      await store.shutdownCoordinator();
      await rm(storage.storagePath, { recursive: true, force: true });
      await rm(destinationRoot, { recursive: true, force: true });
    }
  });

  test("requires initialized read-only storage and rejects persistent mutation", async () => {
    const storage = await domain();
    try {
      await expect(
        LanceIntelligenceStore.open(storage, { access: "read-only" }),
      ).rejects.toMatchObject({
        code: "storage_unavailable",
        message: "Read-only storage requires an initialized LanceDB directory",
      });
      const writable = await LanceIntelligenceStore.open(storage);
      await writable.putRows("artifacts", [source("retained")]);
      await writable.shutdownCoordinator();
      const readonly = await LanceIntelligenceStore.open(storage, {
        access: "read-only",
      });
      try {
        await expect(
          readonly.putRows("artifacts", [source("rejected")]),
        ).rejects.toMatchObject({ code: "storage_unavailable" });
        await expect(readonly.collect()).rejects.toMatchObject({
          code: "storage_unavailable",
        });
        await expect(readonly.recover()).rejects.toMatchObject({
          code: "storage_unavailable",
        });
        await expect(
          readonly.serializeMigration("blocked", async () => "no"),
        ).rejects.toMatchObject({ code: "storage_unavailable" });
        await readonly.releaseReaderPin("absent");
        expect(await readonly.count("artifacts")).toBe(1);
      } finally {
        await readonly.shutdownCoordinator();
      }
    } finally {
      await rm(storage.storagePath, { recursive: true, force: true });
    }
  });

  test("returns bounded diagnostics on native query timeout and propagates unrelated failures", async () => {
    const storage = await domain();
    const store = await LanceIntelligenceStore.open(storage);
    const connection = await lancedb.connect(storage.storagePath);
    const table = await connection.openTable("artifacts");
    const prototype = Object.getPrototypeOf(table.query()) as ReturnType<
      typeof table.query
    >;
    table.close();
    const query = spyOn(prototype, "toArray");
    try {
      query.mockRejectedValueOnce(new Error("native query timed out"));
      expect(
        await store.boundedTableCounts({
          maxRowsPerTable: 10,
          timeoutMs: 10_000,
        }),
      ).toMatchObject({
        counts: {},
        exhaustive: false,
        returnedTables: 0,
        truncated: true,
      });
      const failure = new Error("native query invalid expression");
      query.mockRejectedValueOnce(failure);
      await expect(
        store.boundedTableCounts({ maxRowsPerTable: 10, timeoutMs: 10_000 }),
      ).rejects.toBe(failure);
      query.mockRestore();
      await expect(
        store.ensureIndex("artifacts", "missing_column"),
      ).rejects.toMatchObject({ code: "invalid_schema" });
      expect(await store.count("artifacts")).toBe(0);
    } finally {
      query.mockRestore();
      connection.close();
      await store.shutdownCoordinator();
      await rm(storage.storagePath, { recursive: true, force: true });
    }
  });
});
