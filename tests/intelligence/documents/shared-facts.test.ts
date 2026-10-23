import { expect, test } from "bun:test";

import { analyzeDocument } from "../../../src/intelligence/documents/index.ts";
import { parseSource } from "../../../src/intelligence/parser/index.ts";

test("embedded coordinate mapping preserves shared parser cache values", async () => {
  const code = "export function cached() {}\n";
  const shared = parseSource({ languageId: "typescript", source: code });
  const original = structuredClone(shared);
  const source =
    "# Heading\n\n\`\`\`ts\n" +
    code +
    "\`\`\`\n\n" +
    "\`\`\`ts\n" +
    code +
    "\`\`\`\n";
  const [left, right] = await Promise.all([
    analyzeDocument({
      format: "markdown",
      source,
      parseEmbedded: async () => shared,
    }),
    analyzeDocument({
      format: "markdown",
      source,
      parseEmbedded: async () => shared,
    }),
  ]);
  expect(shared).toEqual(original);
  expect(left).toEqual(right);
  expect(left.embeddedCode).toHaveLength(2);
  const starts = left.embeddedCode.map(
    (region) => region.facts!.symbols[0]!.range.startCoordinate.utf16Offset,
  );
  expect(starts[0]).toBe(source.indexOf("function"));
  expect(starts[1]).toBe(source.lastIndexOf("function"));
});
