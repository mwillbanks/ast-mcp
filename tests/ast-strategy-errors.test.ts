import { expect, test } from "bun:test";
import type { PatchStrategyContext } from "../src/patch/strategy";
import { astStrategy } from "../src/patch/strategy/ast";

function context(
  original: string,
  astRules: PatchStrategyContext["astRules"],
  language = "typescript",
): PatchStrategyContext {
  return {
    aiderBlocks: [],
    astRules,
    capabilities: {
      effective: {
        aiderMatchers: [
          "exact",
          "whitespace",
          "relative-indentation",
          "diff-match-patch",
        ],
        patch: ["ast", "aider_block"],
        read: ["ast", "text"],
      },
      filePath: "/workspace/value.ts",
      generation: 1,
      intrinsic: {
        patch: ["ast", "aider_block"],
        read: ["ast", "text"],
        search: ["ast"],
      },
      kind: "source",
      language,
      parseErrorCount: 0,
      parseStatus: "parseable",
      size: original.length,
    },
    filePath: "/workspace/value.ts",
    language,
    mode: 0o644,
    original,
  };
}

test("AST strategy returns structured match-count diagnostics", async () => {
  await expect(
    astStrategy.prepare(
      context("export const value = 1;\n", [
        {
          expectedMatches: 2,
          fix: "export const value = 2",
          pattern: "export const value = 1",
        },
      ]),
    ),
  ).rejects.toMatchObject({
    code: "ast_match_count",
    details: { expected: 2, matches: 1 },
    retryable: true,
    suggestedNextCall: "run",
  });
});

test("AST strategy rejects overlapping structural matches", async () => {
  await expect(
    astStrategy.prepare(
      context("foo(foo(1));\n", [
        {
          expectedMatches: 2,
          fix: "bar($A)",
          pattern: "foo($A)",
        },
      ]),
    ),
  ).rejects.toMatchObject({
    code: "ast_rewrite_overlap",
    retryable: true,
    suggestedNextCall: "run",
  });
});

test("AST strategy maps parser failures to preview diagnostics", async () => {
  await expect(
    astStrategy.prepare(
      context(
        "value\n",
        [{ fix: "next", pattern: "value" }],
        "unsupported-language",
      ),
    ),
  ).rejects.toMatchObject({
    code: "ast_preview_error",
    retryable: true,
    suggestedNextCall: "run",
  });
});
