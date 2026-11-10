import { expect, spyOn, test } from "bun:test";
import { readFile } from "node:fs/promises";

import {
  captureToolReference,
  checkToolReference,
  stableReference,
} from "../../scripts/validation/check-tool-reference.ts";

const categories = [
  "workspaces",
  "files",
  "configuration",
  "code-intelligence",
  "indexing",
];
const reference = new URL(
  "../../website/content/docs/reference/tools/",
  import.meta.url,
);

function collectExamples(pages: string[]): Record<string, unknown[]> {
  const examples: Record<string, unknown[]> = {};
  for (const page of pages)
    for (const section of page.split(/^## /m).slice(1)) {
      const name = section.slice(0, section.indexOf("\n")).trim();
      const blocks = [
        ...section.matchAll(/\x60\x60\x60json\n([\s\S]*?)\x60\x60\x60/g),
      ];
      if (!blocks.length) throw new Error(`Missing example beneath ${name}`);
      for (const block of blocks) {
        const example = JSON.parse(block[1]!);
        if (example.name !== name)
          throw new Error(`Example ${example.name} is beneath ${name}`);
        (examples[name] ??= []).push(example.arguments);
      }
    }
  return examples;
}

test("canonical pages cover each registration once and every example satisfies its real schema", async () => {
  const pages = await Promise.all(
    categories.map((name) =>
      readFile(new URL(name + ".mdx", reference), "utf8"),
    ),
  );
  const headings = pages.flatMap((page) =>
    [...page.matchAll(/^## (\w+)$/gm)].map((match) => match[1]!),
  );
  const examples = collectExamples(pages);
  const actual = captureToolReference(examples);
  expect(headings.sort()).toEqual(actual.map((tool) => tool.name));
  expect(new Set(headings).size).toBe(actual.length);
  expect(Object.keys(examples).sort()).toEqual(actual.map((tool) => tool.name));
  for (const page of pages)
    expect(
      [...page.matchAll(/<ToolParameters name="(\w+)" \/>/g)].map(
        (match) => match[1],
      ),
    ).toEqual([...page.matchAll(/^## (\w+)$/gm)].map((match) => match[1]));
  expect(actual).toHaveLength(44);
  expect(
    actual.find((tool) => tool.name === "read_symbols")?.inputSchema,
  ).toMatchObject({
    properties: {
      symbols: { items: { maxLength: 256 }, maxItems: 100, minItems: 1 },
    },
    required: ["symbols"],
  });
  expect(
    actual.find((tool) => tool.name === "map")?.inputSchema,
  ).toHaveProperty("properties.detail");
  expect(() => captureToolReference({})).toThrow(
    "Missing documentation example",
  );
  const multiple = structuredClone(examples);
  multiple.file_hash!.push({ filePaths: ["value.txt"] });
  expect(captureToolReference(multiple)).toHaveLength(actual.length);
  multiple.file_hash!.unshift({ filePaths: [] });
  expect(() => captureToolReference(multiple)).toThrow();
  const empty = { ...examples, file_hash: [] };
  expect(() => captureToolReference(empty)).toThrow(
    "Missing documentation example",
  );
});

test("documentation examples stay beneath their tool heading", () => {
  const example = (name: string) =>
    `\x60\x60\x60json\n${JSON.stringify({ name, arguments: {} })}\n\x60\x60\x60`;
  expect(() =>
    collectExamples([
      `## file_hash\n${example("file_read")}\n## file_read\n${example("file_hash")}`,
    ]),
  ).toThrow("is beneath");
  expect(() => collectExamples(["## file_hash\nNo example."])).toThrow(
    "Missing example",
  );
  expect(
    collectExamples([
      `## file_hash\n${example("file_hash")}\n${example("file_hash")}`,
    ]).file_hash,
  ).toHaveLength(2);
});

test("drift check rejects missing tools and schema changes while stable ordering is ignored", async () => {
  const actual = captureToolReference();
  await checkToolReference();
  await checkToolReference({ snapshot: JSON.stringify(actual) });
  await expect(checkToolReference({ snapshot: "[]" })).rejects.toThrow(
    "snapshot is stale",
  );
  const changed = structuredClone(actual);
  changed[0]!.description += " changed";
  await expect(
    checkToolReference({ snapshot: JSON.stringify(changed) }),
  ).rejects.toThrow("snapshot is stale");
  await expect(checkToolReference({ snapshot: "invalid" })).rejects.toThrow();
  const printed: string[] = [];
  await checkToolReference({
    print: true,
    output: (value) => printed.push(value),
  });
  expect(JSON.parse(printed[0]!)).toEqual(JSON.parse(stableReference(actual)));
  const output = spyOn(console, "log").mockImplementation(() => {});
  try {
    await checkToolReference({ print: true });
    expect(output).toHaveBeenCalledTimes(1);
  } finally {
    output.mockRestore();
  }
  expect(stableReference({ z: [null, { b: false, a: 0 }], a: "x" })).toBe(
    stableReference({ a: "x", z: [null, { a: 0, b: false }] }),
  );
});
