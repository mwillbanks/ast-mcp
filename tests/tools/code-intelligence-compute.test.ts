import { expect, test } from "bun:test";

import { parseSource } from "../../src/intelligence/parser/index.ts";
import {
  type CompilerAlias,
  computeNative,
} from "../../src/tools/code-intelligence-compute.ts";
import type { ToolInput, ToolName } from "../../src/tools/code-intelligence.ts";

const root = "/workspace";
function parse(relativePath: string, source: string) {
  return {
    facts: parseSource({ languageId: "typescript", source }),
    path: root + "/" + relativePath,
    source,
  };
}

const files = [
  parse(
    "lib/entry.ts",
    [
      'import { target } from "./target";',
      'import { value } from "@impl/value.js";',
      'import "./folder";',
      'import "external";',
      'export { target } from "./target";',
      "interface Parent {}",
      "class Child implements Parent {}",
      "function hidden() {}",
      "export function entry() { return target(); }",
      "export function twice() { return target() + target(); }",
      "target();",
    ].join("\n"),
  ),
  parse("lib/folder/index.ts", "export const folder = true;"),
  parse("lib/target.js.ts", "export const alternate = true;"),
  parse(
    "lib/target.ts",
    'import { entry } from "./entry";\nexport function target() { return "λ"; }',
  ),
  parse("tests/entry.test.ts", "function testEntry() { return entry(); }"),
];

const aliases: CompilerAlias[] = [
  { hasWildcard: false, prefix: "unused", suffix: "", targets: [] },
  {
    hasWildcard: false,
    prefix: "@impl/value.js",
    suffix: "",
    targets: ["lib/target.ts"],
  },
  {
    hasWildcard: true,
    prefix: "@impl/",
    suffix: ".js",
    targets: ["lib/*", "lib/target.js.ts"],
  },
  {
    hasWildcard: true,
    prefix: "@impl/value",
    suffix: "value.js",
    targets: ["lib/*"],
  },
];

const compute = (name: ToolName, input: ToolInput) =>
  computeNative(name, input, files, root, aliases);

test("maps bounded members and keeps only exported surface symbols", async () => {
  for (const name of ["map", "digest"] as const) {
    expect(await compute(name, { limit: 1, max_members: 1 })).toMatchObject({
      files: [
        {
          language: "typescript",
          path: "lib/entry.ts",
          symbols: [{ name: "Parent" }],
        },
      ],
      total: files.length,
      truncated: true,
    });
  }
  expect(await compute("map", { max_members: 0 })).toMatchObject({
    files: Array.from({ length: files.length }, () => ({ symbols: [] })),
    total: files.length,
    truncated: true,
  });
  const surface = await compute("surface", {});
  expect(surface).toMatchObject({ schema: "ast-mcp.surface.v1" });
  if (!("items" in surface)) throw new Error("Expected a surface page");
  expect(surface.items).toContainEqual(
    expect.objectContaining({ exported: true, name: "entry" }),
  );
  expect(surface.items).not.toContainEqual(
    expect.objectContaining({ name: "hidden" }),
  );
});

test("finds relationship targets and searches definition snippets", async () => {
  expect(await compute("implements", { target: "Parent" })).toMatchObject({
    items: [{ path: "lib/entry.ts", target: "Parent" }],
    total: 1,
  });
  expect(await compute("search", { query: "Λ" })).toMatchObject({
    items: [{ name: "target", snippet: 'function target() { return "λ"; }' }],
    total: 1,
  });
  expect(
    await compute("find_related", { target: "TARGET", top_k: 1 }),
  ).toMatchObject({
    total: 3,
    truncated: true,
  });
  expect(await compute("implements", { target: "Missing" })).toMatchObject({
    items: [],
    total: 0,
  });
  expect(await compute("find_related", { path: "testEntry" })).toMatchObject({
    items: [{ name: "testEntry" }],
    total: 1,
  });
});

test("condenses text within a UTF-8 byte budget", async () => {
  expect(await compute("squeeze", { text: "  a  λ  b   ", budget: 4 })).toEqual(
    {
      schema: "ast-mcp.squeeze.v1",
      text: "a λ",
      truncated: true,
    },
  );
  expect(await compute("squeeze", { query: "  a  b " })).toMatchObject({
    text: "a b",
    truncated: false,
  });
});

test("returns bounded structural matches and preview edits", async () => {
  expect(await compute("run", { pattern: "target()" })).toMatchObject({
    total: 4,
    items: Array.from({ length: 4 }, () => ({
      path: "lib/entry.ts",
      text: "target()",
    })),
  });
  expect(
    await compute("run", { pattern: "target()", rewrite: "replacement()" }),
  ).toMatchObject({
    total: 4,
    items: Array.from({ length: 4 }, () => ({
      path: "lib/entry.ts",
      replacement: "replacement()",
    })),
  });
  await expect(compute("run", {})).rejects.toThrow("run requires pattern");
  await expect(
    compute("run", { pattern: "target()", write: true }),
  ).rejects.toMatchObject({
    code: "use_file_patch",
  });
});

test("resolves module graph edges, ambiguity and external imports", async () => {
  expect(await compute("deps", {})).toMatchObject({
    items: [],
    total: 0,
  });
  expect(await compute("deps", { file: "lib/entry.ts" })).toMatchObject({
    items: [
      { external: true, to: "external" },
      { external: false, to: "lib/folder/index.ts" },
      { ambiguous: true, to: "lib/target.js.ts" },
      { ambiguous: false, to: "lib/target.ts" },
      { ambiguous: true, to: "lib/target.ts" },
    ],
    total: 5,
  });
  expect(
    await compute("reverse_deps", {
      path: "lib/target.ts",
      hide_ambiguous: true,
    }),
  ).toMatchObject({
    items: [{ from: "lib/entry.ts", to: "lib/target.ts" }],
    total: 1,
  });
  expect(
    await compute("graph", { hide_external: true, hide_ambiguous: true }),
  ).toMatchObject({
    items: [
      { from: "lib/entry.ts", to: "lib/folder/index.ts" },
      { from: "lib/entry.ts", to: "lib/target.ts" },
      { from: "lib/target.ts", to: "lib/entry.ts" },
    ],
    total: 3,
  });
  expect(await compute("cycles", {})).toEqual({
    cycles: ["lib/entry.ts -> lib/target.ts -> lib/entry.ts"],
    schema: "ast-mcp.cycles.v1",
    truncated: false,
  });
  expect(await compute("cycles", { budget: 2 })).toMatchObject({
    cycles: [],
    truncated: true,
  });
});

test("traces bounded call paths and prioritizes definitions in context", async () => {
  expect(
    await compute("trace", { target: "target", depth: 2, detail: "full" }),
  ).toMatchObject({
    callees: { total: 0 },
    callers: {
      items: expect.arrayContaining([
        expect.objectContaining({
          callee: "target",
          caller: "entry",
          range: { startLine: 9, endLine: 9 },
        }),
        expect.objectContaining({
          callee: "target",
          caller: null,
          path: "lib/entry.ts",
        }),
        expect.objectContaining({
          callee: "entry",
          caller: "testEntry",
          path: "tests/entry.test.ts",
        }),
      ]),
    },
    depth: 2,
    target: "target",
  });
  expect(
    await compute("callees", { target: "entry", direct: true }),
  ).toMatchObject({
    items: [{ callee: "target", caller: "entry" }],
    total: 1,
  });
  expect(await compute("impact", { target: "target", depth: 2 })).toMatchObject(
    {
      dependents: { total: 3 },
      tests: {
        items: [{ caller: "testEntry", path: "tests/entry.test.ts" }],
        total: 1,
      },
    },
  );
  expect(await compute("context", { target: "target" })).toMatchObject({
    definitions: [{ name: "target", path: "lib/target.ts" }],
    truncated: false,
  });
  expect(
    await compute("context", { target: "target", budget: 2 }),
  ).toMatchObject({
    definitions: [],
    truncated: true,
  });
});

test("returns the caller's cancellation reason before scanning or condensing", async () => {
  const reason = new Error("cancelled by caller");
  const signal = AbortSignal.abort(reason);
  for (const name of ["graph", "read_symbols", "squeeze"] as const)
    await expect(
      computeNative(name, {}, files, root, aliases, signal),
    ).rejects.toBe(reason);
});
