import { describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as lancedb from "@lancedb/lancedb";
import {
  Binary,
  Bool,
  DataType,
  Field,
  FixedSizeList,
  Float16,
  Float32,
  Float64,
  Int32,
  Int64,
  List,
  Schema,
  Type,
  Utf8,
} from "apache-arrow";
import * as legacy from "apache-arrow-18";

import {
  createIdentity,
  INTELLIGENCE_SCHEMA_VERSION,
} from "../../../src/intelligence/contracts/common.ts";
import {
  createStorageDomainId,
  type StorageDomain,
} from "../../../src/intelligence/contracts/storage.ts";
import {
  arrowSchemaSignature,
  toLanceSchema,
} from "../../../src/intelligence/storage/arrow.ts";
import {
  assertCompatibleSchema,
  LanceIntelligenceStore,
  TABLE_SCHEMAS,
} from "../../../src/intelligence/storage/index.ts";

function oldType(type: DataType): legacy.DataType {
  switch (type.typeId) {
    case Type.Binary:
      return new legacy.Binary();
    case Type.Bool:
      return new legacy.Bool();
    case Type.Utf8:
      return new legacy.Utf8();
    case Type.Int:
      return new legacy.Int32();
    case Type.FixedSizeList:
      if (DataType.isFixedSizeList(type)) {
        const child = type.children[0]!;
        return new legacy.FixedSizeList(
          type.listSize,
          new legacy.Field(
            child.name,
            oldType(child.type),
            child.nullable,
            child.metadata,
          ),
        );
      }
      break;
    case Type.Float:
      if (DataType.isFloat(type) && type.precision === 1)
        return new legacy.Float32();
      return new legacy.Float64();
    case Type.List:
      if (DataType.isList(type)) {
        const child = type.children[0]!;
        return new legacy.List(
          new legacy.Field(
            child.name,
            oldType(child.type),
            child.nullable,
            child.metadata,
          ),
        );
      }
  }
  throw new Error("Unsupported legacy fixture type");
}

function oldSchema(schema: Schema): legacy.Schema {
  return new legacy.Schema(
    schema.fields.map(
      (field) =>
        new legacy.Field(
          field.name,
          oldType(field.type),
          field.nullable,
          field.metadata,
        ),
    ),
    schema.metadata,
  );
}

async function domain(): Promise<StorageDomain> {
  const storagePath = await mkdtemp(join(tmpdir(), "ast-mcp-arrow-upgrade-"));
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

describe("Arrow storage boundary", () => {
  test("normalizes Arrow 21 schemas and preserves nested metadata across package versions", () => {
    const schema = new Schema(
      [
        new Field("bytes", new Binary(), true, new Map([["kind", "source"]])),
        new Field("enabled", new Bool(), false),
        new Field("title", new Utf8(), false),
        new Field("weight", new Float64(), false),
        new Field("generation", new Int32(), false),
        new Field(
          "fixed",
          new FixedSizeList(
            3,
            new Field(
              "element",
              new Float32(),
              false,
              new Map([["unit", "fixed"]]),
            ),
          ),
          true,
        ),
        new Field(
          "vector",
          new List(
            new Field(
              "item",
              new Float32(),
              true,
              new Map([["unit", "embedding"]]),
            ),
          ),
          false,
        ),
      ],
      new Map([
        ["z", "last"],
        ["a", "first"],
      ]),
    );
    const normalized = toLanceSchema(schema);
    expect(arrowSchemaSignature(normalized)).toBe(arrowSchemaSignature(schema));
    expect(arrowSchemaSignature(oldSchema(schema))).toBe(
      arrowSchemaSignature(schema),
    );
    expect(normalized.fields.map((field) => field.name)).toEqual(
      schema.fields.map((field) => field.name),
    );
    expect(normalized.metadata).toEqual(schema.metadata);
    expect(normalized.fields[0]?.metadata).toEqual(schema.fields[0]?.metadata);
    expect(() =>
      toLanceSchema(new Schema([new Field("half", new Float16())])),
    ).toThrow("Unsupported Arrow storage type");
  });

  test("rejects malformed schema and field metadata before conversion", () => {
    for (const metadata of [
      {},
      new Map([[1, "invalid"]]),
      new Map([["key", 42]]),
    ]) {
      for (const target of ["schema", "field"] as const) {
        const schema = new Schema([new Field("value", new Utf8(), false)]);
        Object.defineProperty(
          target === "schema" ? schema : schema.fields[0]!,
          "metadata",
          { value: metadata },
        );
        expect(() => toLanceSchema(schema)).toThrow(
          metadata instanceof Map
            ? "Arrow metadata must contain strings"
            : "Arrow metadata must be a string map",
        );
      }
    }
  });

  test("normalizes absent metadata on foreign field descriptors", () => {
    const expected = new Schema([new Field("value", new Utf8(), false)]);
    const foreign = new Schema();
    Object.defineProperty(foreign, "fields", {
      value: [{ name: "value", nullable: false, type: new Utf8() }],
    });
    Object.defineProperty(foreign, "metadata", { value: null });
    expect(arrowSchemaSignature(foreign)).toBe(arrowSchemaSignature(expected));
    expect(arrowSchemaSignature(toLanceSchema(foreign))).toBe(
      arrowSchemaSignature(expected),
    );
  });

  test("rejects malformed fields and storage type descriptors", () => {
    for (const field of [
      null,
      {},
      { name: 7, nullable: false, type: new Utf8() },
      { name: "value", nullable: "yes", type: new Utf8() },
      { name: "value", nullable: false },
    ]) {
      const schema = new Schema();
      Object.defineProperty(schema, "fields", { value: [field] });
      expect(() => arrowSchemaSignature(schema)).toThrow("Invalid Arrow field");
    }
    for (const type of [null, {}, "Utf8"]) {
      const field = new Field("value", new Utf8(), false);
      const schema = new Schema([field]);
      Object.defineProperty(field, "type", { value: type });
      expect(() => arrowSchemaSignature(schema)).toThrow(
        "Invalid Arrow storage type",
      );
    }
  });

  test("rejects unsupported integer widths and invalid fixed-list dimensions", () => {
    for (const type of [
      new Int64(),
      new Float16(),
      new FixedSizeList(-1, new Field("item", new Float32(), true)),
      new FixedSizeList(1.5, new Field("item", new Float32(), true)),
    ]) {
      expect(() =>
        toLanceSchema(new Schema([new Field("value", type, false)])),
      ).toThrow("Unsupported Arrow storage type");
    }
    const list = new List(new Field("item", new Float32(), true));
    Object.defineProperty(list, "children", { value: [] });
    expect(() =>
      toLanceSchema(new Schema([new Field("value", list, false)])),
    ).toThrow("Unsupported Arrow storage type");
  });

  test("rejects field types that change after initial schema validation", () => {
    const field = new Field("value", new Utf8(), false);
    const schema = new Schema([field]);
    let reads = 0;
    Object.defineProperty(field, "type", {
      get: () => (++reads === 1 ? new Utf8() : new Int64()),
    });
    expect(() => toLanceSchema(schema)).toThrow(
      "Unsupported Arrow storage type",
    );
    expect(reads).toBe(2);
  });

  test("rejects schema coercion at the public LanceDB normalization boundary", () => {
    const input = new Schema([new Field("value", new Utf8(), false)]);
    const changed = lancedb.makeArrowTable([], {
      schema: new Schema([new Field("value", new Utf8(), true)]),
    });
    const normalizer = spyOn(lancedb, "makeArrowTable").mockReturnValue(
      changed,
    );
    try {
      expect(() => toLanceSchema(input)).toThrow(
        "LanceDB changed the Arrow storage schema",
      );
    } finally {
      normalizer.mockRestore();
    }
    expect(arrowSchemaSignature(toLanceSchema(input))).toBe(
      arrowSchemaSignature(input),
    );
  });

  test("compares field order, nested nullability, precision, and metadata instead of display strings", () => {
    const expected = TABLE_SCHEMAS.embeddings;
    const changeVector = (child: Field) =>
      new Schema(
        expected.fields.map((field) =>
          field.name === "vector"
            ? new Field(field.name, new List(child), field.nullable)
            : field,
        ),
      );
    expect(() =>
      assertCompatibleSchema("embeddings", oldSchema(expected)),
    ).not.toThrow();
    for (const changed of [
      new Schema([...expected.fields].reverse()),
      changeVector(new Field("item", new Float64(), true)),
      changeVector(new Field("item", new Float32(), false)),
      changeVector(new Field("renamed", new Float32(), true)),
      new Schema(expected.fields, new Map([["unexpected", "metadata"]])),
    ]) {
      expect(() => assertCompatibleSchema("embeddings", changed)).toThrow(
        "does not match ast-mcp intelligence schema",
      );
    }
    const misleading = new Float64();
    misleading.toString = () => "Float32";
    expect(() =>
      assertCompatibleSchema(
        "embeddings",
        changeVector(new Field("item", misleading, true)),
      ),
    ).toThrow("does not match ast-mcp intelligence schema");
  });

  test("preserves fixed list size and rejects changes to element types and nested properties", () => {
    const vector = (size: number, child: Field) =>
      new Schema([new Field("vector", new FixedSizeList(size, child), false)]);
    const expected = vector(3, new Field("item", new Float32(), true));
    const signature = arrowSchemaSignature(toLanceSchema(expected));
    expect(signature).toBe(arrowSchemaSignature(expected));
    for (const changed of [
      vector(4, new Field("item", new Float32(), true)),
      vector(3, new Field("item", new Float64(), true)),
      vector(3, new Field("item", new Float32(), false)),
      vector(3, new Field("renamed", new Float32(), true)),
      vector(
        3,
        new Field("item", new Float32(), true, new Map([["unit", "changed"]])),
      ),
    ]) {
      expect(arrowSchemaSignature(toLanceSchema(changed))).not.toBe(signature);
    }
  });

  test("rejects incompatible populated tables without recreating or rewriting their rows", async () => {
    const storage = await domain();
    const connection = await lancedb.connect(storage.storagePath);
    try {
      const incompatible = new Schema(
        TABLE_SCHEMAS.artifacts.fields.map((field) =>
          field.name === "byte_length"
            ? new Field(field.name, new Float32(), field.nullable)
            : field,
        ),
      );
      const table = await connection.createEmptyTable(
        "artifacts",
        toLanceSchema(incompatible),
      );
      try {
        await table.add([
          {
            artifact_id: "preserved",
            kind: "source",
            content_digest: null,
            content_bytes: new Uint8Array([7]),
            byte_length: 1,
            created_at: "",
            payload_json: "{}",
            publication_generation_id: null,
          },
        ]);
      } finally {
        table.close();
      }
      for (const access of ["read-write", "read-only"] as const) {
        await expect(
          LanceIntelligenceStore.open(storage, { access }),
        ).rejects.toMatchObject({ code: "invalid_schema" });
      }
      const preserved = await connection.openTable("artifacts");
      try {
        expect(await preserved.countRows()).toBe(1);
        expect((await preserved.query().toArray())[0]?.artifact_id).toBe(
          "preserved",
        );
        expect(arrowSchemaSignature(await preserved.schema())).toBe(
          arrowSchemaSignature(incompatible),
        );
      } finally {
        preserved.close();
      }
    } finally {
      connection.close();
      await rm(storage.storagePath, { recursive: true, force: true });
    }
  });

  test("opens Arrow 18 tables, migrates legacy tags once, and roundtrips empty and nullable values read-only", async () => {
    const storage = await domain();
    const artifactIds = [0, 1, 2].map((value) =>
      createIdentity("source", { arrowUpgrade: value }),
    );
    const connection = await lancedb.connect(storage.storagePath);
    try {
      const beforeTags = new Schema(
        TABLE_SCHEMAS.artifacts.fields.filter(
          (field) => field.name !== "publication_generation_id",
        ),
      );
      const artifacts = await connection.createEmptyTable(
        "artifacts",
        oldSchema(beforeTags),
      );
      try {
        await artifacts.add(
          artifactIds.map((id, index) => ({
            artifact_id: id,
            byte_length: index === 2 ? 3 : 0,
            content_bytes:
              index === 0
                ? null
                : index === 1
                  ? new Uint8Array()
                  : new Uint8Array([0, 128, 255]),
            content_digest: null,
            created_at: "",
            kind: "source",
            payload_json: "{}",
          })),
        );
      } finally {
        artifacts.close();
      }
      const embeddings = await connection.createEmptyTable(
        "embeddings",
        oldSchema(TABLE_SCHEMAS.embeddings),
      );
      try {
        await embeddings.add(
          [[], [0.25, -0.5, 1]].map((vector, index) => ({
            artifact_id: createIdentity("embedding", { arrowUpgrade: index }),
            chunk_artifact_id: createIdentity("chunk", { arrowUpgrade: index }),
            model_id: "",
            model_revision: "",
            dimensions: vector.length,
            dtype: "float32",
            normalized: false,
            pooling: "",
            exact_input_digest: "",
            vector,
            byte_length: vector.length * 4,
            created_at: "",
            payload_json: "{}",
            publication_generation_id: null,
          })),
        );
      } finally {
        embeddings.close();
      }
    } finally {
      connection.close();
    }
    try {
      const writer = await LanceIntelligenceStore.open(storage);
      const migrationCount = await writer.count("migrations");
      expect(
        (await writer.rows("artifacts")).every(
          (row) => row.publication_generation_id === null,
        ),
      ).toBeTrue();
      await writer.shutdownCoordinator();
      const reopened = await LanceIntelligenceStore.open(storage);
      expect(await reopened.count("migrations")).toBe(migrationCount);
      await reopened.shutdownCoordinator();
      const reader = await LanceIntelligenceStore.open(storage, {
        access: "read-only",
      });
      try {
        const rows = await reader.rows("artifacts");
        const byId = new Map(rows.map((row) => [row.artifact_id, row]));
        expect(byId.get(artifactIds[0])?.content_bytes).toBeNull();
        expect(
          Array.from(byId.get(artifactIds[1])?.content_bytes as Uint8Array),
        ).toEqual([]);
        expect(
          Array.from(byId.get(artifactIds[2])?.content_bytes as Uint8Array),
        ).toEqual([0, 128, 255]);
        expect(
          rows.every(
            (row) => row.content_digest === null && row.created_at === "",
          ),
        ).toBeTrue();
        const vectors = (await reader.rows("embeddings")).map((row) =>
          Array.from(row.vector as Iterable<number>),
        );
        expect(vectors).toEqual(expect.arrayContaining([[], [0.25, -0.5, 1]]));
        await expect(reader.putRows("artifacts", [])).rejects.toMatchObject({
          code: "storage_unavailable",
        });
      } finally {
        await reader.shutdownCoordinator();
      }
    } finally {
      await rm(storage.storagePath, { force: true, recursive: true });
    }
  });
});
