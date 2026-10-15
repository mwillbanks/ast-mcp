import { makeArrowTable, type SchemaLike } from "@lancedb/lancedb";
import { DataType, type Field, type Schema, Type } from "apache-arrow";

import { StorageError } from "./errors.ts";

function metadataSignature(
  metadata: unknown,
): readonly (readonly [string, string])[] {
  if (metadata === undefined || metadata === null) return [];
  if (!(metadata instanceof Map)) {
    throw new StorageError(
      "invalid_schema",
      "Arrow metadata must be a string map",
      false,
    );
  }
  const entries: [string, string][] = [];
  for (const [key, value] of metadata) {
    if (typeof key !== "string" || typeof value !== "string") {
      throw new StorageError(
        "invalid_schema",
        "Arrow metadata must contain strings",
        false,
      );
    }
    entries.push([key, value]);
  }
  return entries.sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
}

function fieldSignature(field: unknown): unknown {
  if (
    !field ||
    typeof field !== "object" ||
    !("name" in field) ||
    typeof field.name !== "string" ||
    !("nullable" in field) ||
    typeof field.nullable !== "boolean" ||
    !("type" in field)
  ) {
    throw new StorageError("invalid_schema", "Invalid Arrow field", false);
  }
  return {
    name: field.name,
    nullable: field.nullable,
    metadata: metadataSignature(
      "metadata" in field ? field.metadata : undefined,
    ),
    type: typeSignature(field.type),
  };
}

function typeSignature(type: unknown): unknown {
  if (!type || typeof type !== "object" || !("typeId" in type)) {
    throw new StorageError(
      "invalid_schema",
      "Invalid Arrow storage type",
      false,
    );
  }
  switch (type.typeId) {
    case Type.Binary:
    case Type.Bool:
    case Type.Utf8:
      return { typeId: type.typeId };
    case Type.Int:
      if (
        "bitWidth" in type &&
        type.bitWidth === 32 &&
        "isSigned" in type &&
        type.isSigned === true
      ) {
        return {
          typeId: type.typeId,
          bitWidth: type.bitWidth,
          isSigned: type.isSigned,
        };
      }
      break;
    case Type.Float:
      if (
        "precision" in type &&
        (type.precision === 1 || type.precision === 2)
      ) {
        return { typeId: type.typeId, precision: type.precision };
      }
      break;
    case Type.List:
    case Type.FixedSizeList:
      if (
        "children" in type &&
        Array.isArray(type.children) &&
        type.children.length === 1
      ) {
        if (type.typeId === Type.FixedSizeList) {
          if (
            !("listSize" in type) ||
            typeof type.listSize !== "number" ||
            !Number.isSafeInteger(type.listSize) ||
            type.listSize < 0
          )
            break;
          return {
            typeId: type.typeId,
            listSize: type.listSize,
            children: type.children.map(fieldSignature),
          };
        }
        return {
          typeId: type.typeId,
          children: type.children.map(fieldSignature),
        };
      }
      break;
  }
  throw new StorageError(
    "invalid_schema",
    "Unsupported Arrow storage type",
    false,
    {
      typeId: type.typeId,
    },
  );
}

/** Compare wire-relevant structure instead of Arrow package identity or display strings. */
export function arrowSchemaSignature(schema: SchemaLike): string {
  return JSON.stringify({
    fields: schema.fields.map(fieldSignature),
    metadata: metadataSignature(schema.metadata),
  });
}

interface StorageFieldDescriptor {
  name: string;
  nullable: boolean;
  metadata: Map<string, string>;
  type:
    | string
    | {
        typeId: Type.List | Type.FixedSizeList;
        children: StorageFieldDescriptor[];
        listSize?: number;
      };
}

function storageType(type: DataType): StorageFieldDescriptor["type"] {
  if (DataType.isUtf8(type)) return "Utf8";
  if (DataType.isBinary(type)) return "Binary";
  if (DataType.isBool(type)) return "Bool";
  if (DataType.isInt(type) && type.bitWidth === 32 && type.isSigned)
    return "Int32";
  if (DataType.isFloat(type)) {
    if (type.precision === 1) return "Float32";
    if (type.precision === 2) return "Float64";
  }
  if (DataType.isList(type) && type.children.length === 1) {
    return { typeId: Type.List, children: type.children.map(storageField) };
  }
  if (DataType.isFixedSizeList(type) && type.children.length === 1) {
    return {
      typeId: Type.FixedSizeList,
      listSize: type.listSize,
      children: type.children.map(storageField),
    };
  }
  throw new StorageError(
    "invalid_schema",
    "Unsupported Arrow storage type",
    false,
  );
}

function storageField(field: Field): StorageFieldDescriptor {
  return {
    name: field.name,
    type: storageType(field.type),
    nullable: field.nullable,
    metadata: new Map(field.metadata),
  };
}

/** Normalize supported schemas without leaking ESM or bundled Arrow constructors. */
export function toLanceSchema(schema: Schema): SchemaLike {
  const signature = arrowSchemaSignature(schema);
  const descriptor: unknown = {
    fields: schema.fields.map(storageField),
    metadata: new Map(schema.metadata),
    names: schema.fields.map((field) => field.name),
  };
  // LanceDB's public SchemaLike type omits recursive List/FixedSizeList descriptors
  // accepted by its sanitizer. Validate the supported input above and require an
  // exact structural round trip below before allowing this boundary value.
  const normalized = makeArrowTable([], {
    schema: descriptor as SchemaLike,
  }).schema;
  if (arrowSchemaSignature(normalized) !== signature) {
    throw new StorageError(
      "invalid_schema",
      "LanceDB changed the Arrow storage schema",
      false,
    );
  }
  return normalized;
}
