import { expect, test } from "bun:test";

import { LanguageRegistry } from "../../../src/intelligence/parser/registry.ts";
import { rewriteStructuralMatches } from "../../../src/intelligence/parser/structural.ts";

const operation = {
  expectedMatches: 1,
  pattern: "fn($$$ARGS)",
  replacement: "wrap($$$ARGS)",
};

test("uses empty variadic captures and preserves unresolved replacement placeholders", () => {
  expect(
    rewriteStructuralMatches("fn();", "typescript", [operation]).source,
  ).toBe("wrap();");
  expect(
    rewriteStructuralMatches("fn(0);", "typescript", [
      { ...operation, replacement: "wrap($UNKNOWN)" },
    ]).source,
  ).toBe("wrap($UNKNOWN);");
});

test("refuses writes with an omitted grammar, invalid count or incomplete per-match replacements", () => {
  expect(() =>
    rewriteStructuralMatches(
      "package main\n",
      "go",
      [],
      new LanguageRegistry(undefined, []),
    ),
  ).toThrow("Parser is unavailable");
  for (const expectedMatches of [-1, 1.25]) {
    expect(() =>
      rewriteStructuralMatches("fn();", "typescript", [
        { ...operation, expectedMatches },
      ]),
    ).toThrow("Expected match count must be a nonnegative integer");
  }
  expect(() =>
    rewriteStructuralMatches("fn(); fn(1);", "typescript", [
      { ...operation, expectedMatches: 2, replacement: ["wrap()"] },
    ]),
  ).toThrow("requires one replacement per match");
});
