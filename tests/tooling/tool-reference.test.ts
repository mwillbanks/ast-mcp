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

test("canonical pages cover each registration once and every example satisfies its real schema", async () => {
  const pages = await Promise.all(
    categories.map((name) =>
      readFile(new URL(name + ".mdx", reference), "utf8"),
    ),
  );
  const headings = pages.flatMap((page) =>
    [...page.matchAll(/^## (\w+)$/gm)].map((match) => match[1]!),
  );
  const examples = Object.fromEntries(
    pages.flatMap((page) =>
      [...page.matchAll(/\x60\x60\x60json\n([\s\S]*?)\x60\x60\x60/g)].map(
        (match) => {
          const example = JSON.parse(match[1]!);
          return [example.name, example.arguments];
        },
      ),
    ),
  );
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
  expect(actual).toHaveLength(43);
  expect(
    actual.find((tool) => tool.name === "map")?.inputSchema,
  ).toHaveProperty("properties.detail");
  expect(() => captureToolReference({})).toThrow();
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
