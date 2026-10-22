import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import { z } from "zod";

import { fileV2Schema } from "../../src/config/v2-schema";

function schemaLeaves(schema: z.ZodType, prefix = ""): string[] {
  if (
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodDefault ||
    schema instanceof z.ZodNullable
  )
    return schemaLeaves(schema.unwrap() as z.ZodType, prefix);
  if (schema instanceof z.ZodObject)
    return Object.entries(schema.shape).flatMap(([key, value]) =>
      schemaLeaves(value as z.ZodType, prefix ? `${prefix}.${key}` : key),
    );
  if (schema instanceof z.ZodUnion)
    return schema.options.flatMap((option) =>
      schemaLeaves(option as z.ZodType, prefix),
    );
  if (schema instanceof z.ZodArray) {
    const element = schema.element;
    return element instanceof z.ZodObject || element instanceof z.ZodUnion
      ? schemaLeaves(element, `${prefix}[]`)
      : [prefix];
  }
  return [prefix];
}

test("website reference inventories every accepted version 2 configuration field", async () => {
  const source = await readFile(
    "website/content/docs/reference/configuration.mdx",
    "utf8",
  );
  const inventory = source
    .split("## Complete version 2 reference\n")[1]!
    .split("## CLI output\n")[0]!;
  const documented = new Set(
    [...inventory.matchAll(/^\|\s+`([^`]+)`\s+\|/gm)].map((match) => match[1]),
  );
  expect([...documented].sort()).toEqual(
    [...new Set(schemaLeaves(fileV2Schema))].sort(),
  );
});

test("website configuration and formatter TOML examples pass the current schema", async () => {
  for (const file of [
    "website/content/docs/reference/configuration.mdx",
    "website/content/docs/guides/formatting.mdx",
    "website/content/docs/guides/filesystem-access.mdx",
  ]) {
    const source = await readFile(file, "utf8");
    const examples = [...source.matchAll(/```toml\n([\s\S]*?)```/g)];
    expect(examples.length).toBeGreaterThan(0);
    for (const example of examples) {
      const parsed = { version: 2, ...Bun.TOML.parse(example[1]!) };
      const result = fileV2Schema.safeParse(parsed);
      expect(
        result.success,
        `${file}: ${JSON.stringify(result.error?.issues)}`,
      ).toBe(true);
    }
  }
});
