import { expect, test } from "bun:test";

import tools from "../src/data/tool-reference.json";
import {
  type ParameterSchema,
  parameterConstraints,
  parameterRows,
  parameterType,
} from "../src/lib/tool-schema";

test("parameter tables preserve nested records, arrays, defaults, constraints, and alternatives", () => {
  const schema: ParameterSchema = {
    type: "object",
    required: ["settings"],
    additionalProperties: false,
    properties: {
      settings: {
        type: "object",
        required: ["mode"],
        properties: {
          mode: { enum: ["allow", "deny"], default: "deny" },
          count: { type: "integer", default: 0, minimum: 0, maximum: 5 },
          active: { type: "boolean", default: false },
          values: {
            type: "array",
            minItems: 1,
            maxItems: 3,
            items: { type: "string", minLength: 1 },
          },
          records: {
            type: "object",
            propertyNames: { minLength: 1 },
            additionalProperties: { oneOf: [{ const: "x" }, { type: "null" }] },
          },
          choice: {
            anyOf: [
              { type: "string", pattern: "^x", format: "uuid" },
              { type: "number" },
            ],
          },
          combined: { allOf: [{ type: "number" }, { minimum: 1 }] },
        },
      },
    },
  };
  const rows = parameterRows(schema);
  expect(rows.settings?.required).toBe(true);
  expect(rows["settings.mode"]?.type).toBe('"allow" | "deny"');
  expect(rows["settings.count"]?.default).toBe("0");
  expect(rows["settings.active"]?.default).toBe("false");
  expect(rows["settings.values[]"]?.description).toContain("minLength: 1");
  expect(rows["settings.records.*[alternative 1]"]?.type).toBe('"x"');
  expect(rows["settings.records.*[alternative 2]"]?.type).toBe("null");
  expect(rows["settings.choice"]?.type).toBe("string | number");
  expect(rows["settings.combined"]?.type).toBe("number & unknown");
  expect(parameterType({ type: ["string", "null"] })).toBe("string | null");
  expect(parameterType({ type: "array" })).toBe("Array<unknown>");
  expect(parameterRows({})).toEqual({});
  expect(() => parameterRows(null)).toThrow("Expected a JSON Schema");
  expect(parameterType(false)).toBe("never");
  expect(parameterType(true)).toBe("unknown");
  expect(
    parameterType({
      type: "array",
      prefixItems: [{ type: "number" }],
      items: false,
    }),
  ).toBe("[number]");
  expect(
    parameterType({ type: "array", prefixItems: [{ type: "number" }] }),
  ).toBe("[number, ...Array<unknown>]");
  const tuple = parameterRows({
    type: "object",
    properties: {
      lines: {
        type: "array",
        prefixItems: [{ type: "number" }, { type: "number" }],
        minItems: 2,
        items: false,
      },
    },
  });
  expect(tuple["lines[0]"]?.required).toBe(false);
  expect(tuple["lines[0]"]?.description).toContain(
    "Schema for array position 0",
  );
  expect(rows["settings.values[]"]?.required).toBe(false);
  expect(rows["settings.records.*"]?.description).toContain(
    "each existing record value",
  );
  expect(rows["settings.mode"]?.required).toBe(true);
  expect(tuple["lines[]"]?.description).toContain("No values are accepted.");
  expect(parameterConstraints(schema)).toContain(
    "Unknown properties are rejected",
  );
  expect(rows["settings.records"]?.description).toContain(
    "Record keys: minLength: 1",
  );
});

test("root constraints and conjunctive required fields remain visible without changing named parameter paths", () => {
  const rows = parameterRows({
    type: "object",
    additionalProperties: false,
    minProperties: 1,
    maxProperties: 3,
    properties: {
      token: { type: "string" },
      optional: { type: "string" },
      selection: {
        type: "object",
        properties: { name: { type: "string" } },
        allOf: [{ allOf: [{ required: ["name"] }] }],
      },
    },
    allOf: [{ required: ["token"] }],
    anyOf: [{ required: ["optional"] }, { required: ["token"] }],
  });
  expect(rows.$?.description).toContain("complete arguments object");
  expect(rows.$?.description).toContain("Unknown properties are rejected");
  expect(rows.$?.description).toContain("minProperties: 1");
  expect(rows.$?.description).toContain("maxProperties: 3");
  expect(rows.token?.required).toBe(true);
  expect(rows.optional?.required).toBe(false);
  expect(rows["selection.name"]?.required).toBe(true);
  const branches = parameterRows({
    required: ["token"],
    allOf: [{ properties: { token: { type: "string" } } }],
  });
  expect(branches["[alternative 1].token"]?.required).toBe(true);
  const mixed = parameterRows({
    required: ["token"],
    anyOf: [{ properties: { token: { type: "string" } } }],
    allOf: [{ properties: { count: { type: "integer" } } }],
  });
  expect(mixed["[alternative 1].token"]?.required).toBe(true);
  expect(mixed["[alternative 2].count"]?.type).toBe("integer");
  expect(
    parameterType({
      anyOf: [{ type: "string" }, { type: "number" }],
      allOf: [{ minLength: 1 }],
    }),
  ).toBe("(string | number) & (unknown)");
  expect(parameterRows(false).$?.description).toContain(
    "No values are accepted",
  );
});

test("real schemas expose patch record branches, config alternatives, constraints, and defaults", () => {
  const patch = parameterRows(
    tools.find((tool) => tool.name === "file_patch")!.inputSchema,
  );
  expect(patch["files.*.aiderBlocks[].search"]?.required).toBe(true);
  expect(patch["files.*.expectedSha256"]?.description).toContain(
    "maxLength: 64",
  );
  expect(
    patch["revision[alternative 3].oid[alternative 1]"]?.description,
  ).toContain("pattern:");
  const config = parameterRows(
    tools.find((tool) => tool.name === "config_paths")!.inputSchema,
  );
  expect(config["operations[][alternative 1].op"]?.type).toBe('"add"');
  const graph = parameterRows(
    tools.find((tool) => tool.name === "graph_query")!.inputSchema,
  );
  expect(graph["budget.maxDepth"]?.default).toBe("8");
  expect(graph["budget.maxDepth"]?.description).toContain("maximum: 1000");
  for (const tool of tools) {
    const rows = parameterRows(tool.inputSchema);
    expect(rows.$?.description).toContain("Unknown properties are rejected");
    expect(Object.keys(rows)).toEqual(
      expect.arrayContaining(Object.keys(tool.inputSchema.properties)),
    );
  }
});
