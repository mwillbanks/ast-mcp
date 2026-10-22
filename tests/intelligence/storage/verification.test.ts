import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  resolvedRelationshipsArtifactIdentity,
  revisionManifestArtifactIdentity,
  sourceArtifactIdentity,
  syntaxFactsArtifactIdentity,
} from "../../../src/intelligence/contracts/artifacts.ts";
import {
  createIdentity,
  INTELLIGENCE_SCHEMA_VERSION,
} from "../../../src/intelligence/contracts/common.ts";
import {
  createStorageDomainId,
  createPublicationReservationId,
  type LanceTableName,
  type StorageDomain,
} from "../../../src/intelligence/contracts/storage.ts";
import { LanceIntelligenceStore } from "../../../src/intelligence/storage/store.ts";

const NOW = "2026-09-10T00:00:00.000Z";
type VerificationTable =
  | "artifacts"
  | "revision_manifests"
  | "syntax_facts"
  | "relationships";

async function publication(
  reserved: boolean,
  mutate: (
    rows: Partial<Record<LanceTableName, Record<string, unknown>[]>>,
  ) => void = () => {},
) {
  const storagePath = await mkdtemp(join(tmpdir(), "ast-mcp-verification-"));
  const placement = { kind: "explicit" as const, path: storagePath };
  const domain: StorageDomain = {
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
  const store = await LanceIntelligenceStore.open(domain);
  const repositoryId = createIdentity("repository", { storagePath });
  const revisionId = createIdentity("revision", { repositoryId });
  const workspaceId = createIdentity("workspace", { repositoryId });
  const source = "export const value = 1;\n";
  const digest = createHash("sha256").update(source).digest("hex");
  const sourceArtifactId = sourceArtifactIdentity({ contentDigest: digest });
  const parserFingerprint = "b".repeat(64);
  const resolverFingerprint = "c".repeat(64);
  const environmentFingerprint = "d".repeat(64);
  const syntaxFactsArtifactId = syntaxFactsArtifactIdentity({
    languageId: "typescript",
    parserFingerprint,
    sourceArtifactId,
  });
  const relationshipId = resolvedRelationshipsArtifactIdentity({
    environmentFingerprint,
    resolverFingerprint,
    syntaxFactsArtifactId,
  });
  const manifest = {
    dirtyOverlayId: null,
    entries: [
      {
        path: "entry.ts",
        sourceArtifactId,
        syntaxFactsArtifactId,
        resolvedRelationshipsArtifactId: relationshipId,
      },
    ],
    repositoryId,
    revisionId,
  };
  const manifestArtifactId = revisionManifestArtifactIdentity(manifest);
  const payload = JSON.stringify(manifest);
  const rows: Partial<Record<LanceTableName, Record<string, unknown>[]>> = {
    artifacts: [
      {
        artifact_id: sourceArtifactId,
        byte_length: Buffer.byteLength(source),
        content_bytes: new TextEncoder().encode(source),
        content_digest: digest,
        created_at: NOW,
        kind: "source",
        payload_json: JSON.stringify({ contentDigest: digest }),
      },
      {
        artifact_id: manifestArtifactId,
        byte_length: Buffer.byteLength(payload),
        content_bytes: null,
        content_digest: createHash("sha256").update(payload).digest("hex"),
        created_at: NOW,
        kind: "revision-manifest",
        payload_json: payload,
      },
    ],
    revision_manifests: [
      {
        artifact_id: manifestArtifactId,
        created_at: NOW,
        dirty_overlay_id: null,
        entry_count: 1,
        logical_bytes: Buffer.byteLength(payload),
        payload_json: payload,
        repository_id: repositoryId,
        revision_id: revisionId,
      },
    ],
    syntax_facts: [
      {
        artifact_id: syntaxFactsArtifactId,
        byte_length: 2,
        created_at: NOW,
        language_id: "typescript",
        parser_fingerprint: parserFingerprint,
        payload_json: "{}",
        source_artifact_id: sourceArtifactId,
      },
    ],
    relationships: [
      {
        artifact_id: relationshipId,
        byte_length: 2,
        created_at: NOW,
        environment_fingerprint: environmentFingerprint,
        payload_json: "{}",
        resolver_fingerprint: resolverFingerprint,
        syntax_facts_artifact_id: syntaxFactsArtifactId,
      },
    ],
  };
  mutate(rows);
  const input = { manifestArtifactId, revisionId, workspaceId };
  if (reserved) {
    const reservation = await store.reservePublication({
      ...input,
      requiredTables: [
        "artifacts",
        "revision_manifests",
        "syntax_facts",
        "relationships",
      ],
      reservationKey: "verification",
    });
    await store.putReservedRowsBatch(
      reservation,
      Object.entries(rows).map(([tableName, values]) => ({
        tableName: tableName as VerificationTable,
        rows: values,
      })),
    );
    await store.finalizePublication(reservation);
  } else {
    for (const [tableName, values] of Object.entries(rows))
      await store.putRows(tableName as LanceTableName, values);
    await store.publish(input);
  }
  return {
    store,
    workspaceId,
    revisionId,
    async close() {
      await store.shutdownCoordinator();
      await rm(storagePath, { recursive: true, force: true });
    },
  };
}

describe("published storage verification", () => {
  for (const reserved of [true]) {
    test(
      "verifies all referenced artifact families for " +
        (reserved ? "reserved" : "legacy") +
        " publications",
      async () => {
        const fixture = await publication(reserved);
        try {
          const verified = await fixture.store.verifyLatestGeneration(
            fixture.workspaceId,
            fixture.revisionId,
          );
          expect(verified).toMatchObject({
            artifactReferences: 3,
            exhaustive: true,
          });
          expect(verified.checkedTables).toBeGreaterThanOrEqual(4);
          expect(await fixture.store.countRows("artifacts")).toBe(2);
          expect(
            Number.isFinite(Date.parse(fixture.store.currentTimestamp())),
          ).toBeTrue();
          await expect(
            fixture.store.verifyLatestGeneration(
              fixture.workspaceId,
              createIdentity("revision", { wrong: true }),
            ),
          ).rejects.toMatchObject({ code: "mixed_generation" });
          await expect(
            fixture.store.verifyLatestGeneration(
              fixture.workspaceId,
              fixture.revisionId,
              { timeoutMs: 0 },
            ),
          ).rejects.toMatchObject({ code: "storage_unavailable" });
          await expect(
            fixture.store.verifyLatestGeneration(
              fixture.workspaceId,
              fixture.revisionId,
              { maxArtifacts: 2 },
            ),
          ).rejects.toMatchObject({ code: "storage_unavailable" });
        } finally {
          await fixture.close();
        }
      },
    );
  }

  test("rejects legacy publications whose manifest has no generation tag", async () => {
    const fixture = await publication(false);
    try {
      await expect(
        fixture.store.verifyLatestGeneration(
          fixture.workspaceId,
          fixture.revisionId,
        ),
      ).rejects.toThrow("outside the selected generation");
    } finally {
      await fixture.close();
    }
  });

  test("rejects invalid writes, absent indexes, and unpublished reader coordinates", async () => {
    const fixture = await publication(true);
    try {
      const generation = (
        await fixture.store.verifyLatestGeneration(
          fixture.workspaceId,
          fixture.revisionId,
        )
      ).generation;
      await expect(
        fixture.store.pinGeneration(
          { ...generation, publishedAt: "2020-01-01T00:00:00.000Z" },
          "altered",
        ),
      ).rejects.toMatchObject({ code: "mixed_generation" });
      await expect(
        fixture.store.pinLatestGeneration(
          createIdentity("workspace", { absent: true }),
          "missing",
        ),
      ).rejects.toMatchObject({ code: "mixed_generation" });
      await expect(
        fixture.store.pinGeneration(generation, "expired", 0),
      ).rejects.toThrow("Reader pin expiration must follow creation");
      expect(await fixture.store.count("reader_pins")).toBe(0);
      await expect(
        fixture.store.ensureIndex("artifacts", "absent_column"),
      ).rejects.toMatchObject({ code: "invalid_schema" });
      const row = (await fixture.store.rows("artifacts"))[0]!;
      await expect(
        fixture.store.putRows("artifacts", [{ ...row, unknown_column: true }]),
      ).rejects.toMatchObject({ code: "invalid_schema" });
      await expect(
        fixture.store.putRows("artifacts", [{ ...row, artifact_id: null }]),
      ).rejects.toMatchObject({ code: "invalid_schema" });
    } finally {
      await fixture.close();
    }
  });

  test("fences reservation tokens and rejects undeclared or conflicting producer writes", async () => {
    const fixture = await publication(true);
    try {
      const latest = (await fixture.store.latestGeneration(
        fixture.workspaceId,
      ))!;
      const token = await fixture.store.reservePublication({
        manifestArtifactId: latest.manifestArtifactId,
        revisionId: latest.revisionId,
        workspaceId: latest.workspaceId,
        reservationKey: "boundary-producers",
        requiredTables: ["artifacts"],
      });
      const reservationId = (input: typeof token) =>
        createPublicationReservationId({
          attempt: input.attempt,
          inputFingerprint: input.inputFingerprint,
          manifestArtifactId: input.manifestArtifactId,
          requiredTables: input.requiredTables,
          reservationKey: input.reservationKey,
          revisionId: input.revisionId,
          storageDomainId: input.storageDomainId,
          workspaceId: input.workspaceId,
        });
      const conflict = { code: "publication_conflict" };
      await expect(
        fixture.store.putReservedRowsBatch(token, []),
      ).rejects.toMatchObject(conflict);
      await expect(
        fixture.store.putReservedRowsBatch(token, [
          { tableName: "artifacts", rows: [] },
          { tableName: "artifacts", rows: [] },
        ]),
      ).rejects.toMatchObject(conflict);
      await expect(
        fixture.store.putReservedRowsBatch(token, [
          { tableName: "syntax_facts", rows: [] },
        ]),
      ).rejects.toMatchObject(conflict);
      await expect(
        fixture.store.recordGenerationArtifacts(token, "syntax_facts", []),
      ).rejects.toMatchObject(conflict);
      await expect(
        fixture.store.putReservedRows(token, "syntax_facts", []),
      ).rejects.toMatchObject(conflict);
      await expect(
        fixture.store.recordReservedTableVersion(token, "syntax_facts"),
      ).rejects.toMatchObject(conflict);
      const invalidTable = "reader_pins" as Parameters<
        LanceIntelligenceStore["putReservedRows"]
      >[1];
      await expect(
        fixture.store.putReservedRows(token, invalidTable, []),
      ).rejects.toMatchObject(conflict);
      await expect(
        fixture.store.recordReservedTableVersion(token, invalidTable),
      ).rejects.toMatchObject(conflict);
      for (const coordinate of ["publication_generation_id", "generation_id"]) {
        const row = {
          [coordinate]: createIdentity("generation", { foreign: true }),
        };
        await expect(
          fixture.store.putReservedRows(token, "artifacts", [row]),
        ).rejects.toMatchObject(conflict);
        await expect(
          fixture.store.putReservedRowsBatch(token, [
            { tableName: "artifacts", rows: [row] },
          ]),
        ).rejects.toMatchObject(conflict);
      }
      const foreign = {
        ...token,
        storageDomainId: createStorageDomainId({
          engine: "lancedb",
          placement: { kind: "explicit", path: "/foreign" },
          pool: "shared",
          storagePath: "/foreign",
        }),
      };
      foreign.generationId = reservationId(foreign);
      await expect(
        fixture.store.putReservedRows(foreign, "artifacts", []),
      ).rejects.toMatchObject(conflict);
      const absent = { ...token, reservationKey: "never-reserved" };
      absent.generationId = reservationId(absent);
      await expect(
        fixture.store.putReservedRows(absent, "artifacts", []),
      ).rejects.toMatchObject({ code: "publication_not_found" });
      await expect(
        fixture.store.putReservedRows(
          { ...token, reservationKey: "different-token" },
          "artifacts",
          [],
        ),
      ).rejects.toThrow("Reservation identity does not match its coordinates");
      await expect(
        fixture.store.abandonPublication(token, " "),
      ).rejects.toMatchObject(conflict);
      const abandoned = await fixture.store.abandonPublication(
        token,
        "producer cancellation",
      );
      expect(abandoned.state).toBe("abandoned");
      await expect(
        fixture.store.putReservedRows(token, "artifacts", []),
      ).rejects.toMatchObject({ code: "publication_abandoned" });
      await expect(
        fixture.store.finalizePublication({
          ...token,
          generationId: latest.generationId,
        }),
      ).rejects.toThrow("Reservation identity does not match its coordinates");
      expect(
        (await fixture.store.latestGeneration(fixture.workspaceId))
          ?.generationId,
      ).toBe(latest.generationId);
    } finally {
      await fixture.close();
    }
  });

  test("rejects duplicate and empty primary keys without changing pinned data", async () => {
    const fixture = await publication(true);
    try {
      const rows = await fixture.store.rows("artifacts");
      const row = rows[0]!;
      for (const artifact_id of ["", 42]) {
        await expect(
          fixture.store.putRows("artifacts", [{ ...row, artifact_id }]),
        ).rejects.toMatchObject({ code: "invalid_schema" });
      }
      await expect(
        fixture.store.putRows("artifacts", [row, row]),
      ).rejects.toMatchObject({ code: "invalid_schema" });
      const reader = await fixture.store.pinLatestGeneration(
        fixture.workspaceId,
        "boundary-reader",
      );
      expect(await reader.rows("graph_nodes")).toEqual([]);
      await expect(
        reader.rows("publications" as Parameters<typeof reader.rows>[0]),
      ).rejects.toMatchObject({
        code: "mixed_generation",
      });
      expect(
        await reader.rows("artifacts", undefined, { limit: 1 }),
      ).toHaveLength(1);
      await reader.close();
      await expect(reader.rows("artifacts")).rejects.toMatchObject({
        code: "mixed_generation",
      });
      expect(await fixture.store.count("reader_pins")).toBe(0);
      expect(await fixture.store.rows("artifacts")).toEqual(rows);
    } finally {
      await fixture.close();
    }
  });

  test("releases persistent reader pins when a recorded Lance version is unavailable", async () => {
    const fixture = await publication(true);
    try {
      const generation = (await fixture.store.latestGeneration(
        fixture.workspaceId,
      ))!;
      const publicationRow = (await fixture.store.rows("publications"))[0]!;
      const unavailable = {
        ...generation,
        tableVersions: generation.tableVersions.map((pin) =>
          pin.table === "syntax_facts"
            ? { ...pin, version: pin.version + 100_000 }
            : pin,
        ),
      };
      await fixture.store.putRows(
        "publications",
        [{ ...publicationRow, payload_json: JSON.stringify(unavailable) }],
        { immutable: false },
      );
      await expect(
        fixture.store.pinGeneration(unavailable, "unavailable-version"),
      ).rejects.toThrow();
      expect(await fixture.store.count("reader_pins")).toBe(0);
      await fixture.store.putRows("publications", [publicationRow], {
        immutable: false,
      });
      const reader = await fixture.store.pinLatestGeneration(
        fixture.workspaceId,
        "restored-version",
      );
      expect(await reader.rows("syntax_facts")).toHaveLength(1);
      await reader.close();
    } finally {
      await fixture.close();
    }
  });

  for (const missing of ["manifest", "source"] as const) {
    test(
      "rejects " + missing + " artifacts without generation membership",
      async () => {
        const fixture = await publication(true);
        try {
          const generation = (await fixture.store.latestGeneration(
            fixture.workspaceId,
          ))!;
          const links = await fixture.store.rows("generation_artifacts");
          const link = links.find(
            (row) =>
              row.table_name === "artifacts" &&
              (missing === "manifest"
                ? row.artifact_id === generation.manifestArtifactId
                : row.artifact_id !== generation.manifestArtifactId),
          )!;
          await fixture.store.putRows(
            "generation_artifacts",
            [
              {
                ...link,
                artifact_id: sourceArtifactIdentity({
                  contentDigest: "f".repeat(64),
                }),
              },
            ],
            { immutable: false },
          );
          await expect(
            fixture.store.verifyLatestGeneration(
              fixture.workspaceId,
              fixture.revisionId,
            ),
          ).rejects.toMatchObject({ code: "mixed_generation" });
        } finally {
          await fixture.close();
        }
      },
    );
  }

  const corruptionCases = [
    {
      name: "missing manifest",
      expected: "mixed_generation",
      mutate(rows: Partial<Record<LanceTableName, Record<string, unknown>[]>>) {
        rows.revision_manifests = [];
      },
    },
    {
      name: "wrong manifest artifact kind",
      expected: "invalid_schema",
      mutate(rows: Partial<Record<LanceTableName, Record<string, unknown>[]>>) {
        rows.artifacts![1]!.kind = "source";
      },
    },
    {
      name: "non-source reference",
      expected: "invalid_schema",
      mutate(rows: Partial<Record<LanceTableName, Record<string, unknown>[]>>) {
        rows.artifacts![0]!.kind = "revision-manifest";
      },
    },
    {
      name: "source payload disagreement",
      expected: "invalid_schema",
      mutate(rows: Partial<Record<LanceTableName, Record<string, unknown>[]>>) {
        rows.artifacts![0]!.payload_json = JSON.stringify({
          contentDigest: "f".repeat(64),
        });
      },
    },
    {
      name: "missing source",
      expected: "mixed_generation",
      mutate(rows: Partial<Record<LanceTableName, Record<string, unknown>[]>>) {
        rows.artifacts!.shift();
      },
    },
    {
      name: "syntax identity disagreement",
      expected: "invalid_schema",
      mutate(rows: Partial<Record<LanceTableName, Record<string, unknown>[]>>) {
        rows.syntax_facts![0]!.parser_fingerprint = "f".repeat(64);
      },
    },
    {
      name: "resolution identity disagreement",
      expected: "invalid_schema",
      mutate(rows: Partial<Record<LanceTableName, Record<string, unknown>[]>>) {
        rows.relationships![0]!.resolver_fingerprint = "f".repeat(64);
      },
    },
    {
      name: "malformed manifest artifact",
      expected: "invalid_schema",
      mutate(rows: Partial<Record<LanceTableName, Record<string, unknown>[]>>) {
        rows.artifacts![1]!.payload_json = "{";
      },
    },
    {
      name: "manifest checksum disagreement",
      expected: "invalid_schema",
      mutate(rows: Partial<Record<LanceTableName, Record<string, unknown>[]>>) {
        rows.artifacts![1]!.content_digest = "f".repeat(64);
      },
    },
  ];
  for (const scenario of corruptionCases) {
    test(
      "rejects " + scenario.name + " without accepting a mixed generation",
      async () => {
        const fixture = await publication(true, scenario.mutate);
        try {
          await expect(
            fixture.store.verifyLatestGeneration(
              fixture.workspaceId,
              fixture.revisionId,
            ),
          ).rejects.toMatchObject({ code: scenario.expected });
        } finally {
          await fixture.close();
        }
      },
    );
  }
});
