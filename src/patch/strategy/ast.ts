import { randomUUID } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { callAstBro } from "../../ast-bro/client";
import { parseAstBroJson } from "../../ast-bro/result";
import type {
  AstRule,
  PatchStrategyAdapter,
  PatchStrategyContext,
} from "../strategy";

function validate(
  context: PatchStrategyContext,
): asserts context is PatchStrategyContext & { language: string } {
  if (
    !context.language ||
    !context.capabilities.effective.patch.includes("ast")
  )
    throw Object.assign(
      new Error(
        `patchStrategy 'ast' is not available for this file; available strategies: ${context.capabilities.effective.patch.join(", ") || "none"}`,
      ),
      {
        code: "patch_strategy_unavailable",
        details: { capabilities: context.capabilities },
        retryable: true,
      },
    );
  if (context.astRules.length === 0 || context.aiderBlocks.length > 0)
    throw Object.assign(
      new Error("patchStrategy 'ast' requires astRules and no aiderBlocks"),
      { code: "patch_strategy_arguments", retryable: true },
    );
}

function temporary(filePath: string): string {
  const extension = path.extname(filePath);
  const base = extension ? filePath.slice(0, -extension.length) : filePath;
  return `${base}.ast-mcp-patch-${randomUUID()}${extension}`;
}

async function previewRule(
  context: PatchStrategyContext & { language: string },
  next: string,
  rule: AstRule,
): Promise<number> {
  const preview = parseAstBroJson(
    await callAstBro(
      "run",
      {
        json: true,
        lang: context.language,
        paths: [next],
        pattern: rule.pattern,
      },
      path.dirname(context.filePath),
    ),
  );
  if (preview.error_count)
    throw Object.assign(
      new Error(`ast-bro preview failed with ${preview.error_count} errors`),
      {
        code: "ast_preview_error",
        details: { errors: preview.errors },
        retryable: true,
        suggestedNextCall: "run",
      },
    );
  const locations = Array.isArray(preview.matches)
    ? preview.matches.slice(0, 10).map((match) => {
        const value = match as Record<string, unknown>;
        return {
          endCol: value.end_col,
          endLine: value.end_line,
          file: value.file,
          matchedText:
            typeof value.matched_text === "string"
              ? value.matched_text.slice(0, 200)
              : undefined,
          startCol: value.start_col,
          startLine: value.start_line,
        };
      })
    : [];
  const matches = Array.isArray(preview.matches) ? preview.matches.length : 0;
  const expected = rule.expectedMatches ?? 1;
  if (matches !== expected)
    throw Object.assign(
      new Error(`AST rule matched ${matches} nodes; expected ${expected}`),
      {
        code: "ast_match_count",
        details: { expected, locations, matches },
        retryable: true,
        suggestedNextCall: "run",
      },
    );
  if (expected !== 1)
    throw Object.assign(
      new Error(
        "ast-bro run rewrites only the first match per file; narrow the AST rule to exactly one node",
      ),
      {
        code: "ast_rewrite_cardinality",
        details: { expected, locations, matches },
        retryable: true,
        suggestedNextCall: "run",
      },
    );
  return matches;
}

async function rewriteRule(
  context: PatchStrategyContext & { language: string },
  next: string,
  rule: AstRule,
): Promise<void> {
  const rewritten = parseAstBroJson(
    await callAstBro(
      "run",
      {
        json: true,
        lang: context.language,
        paths: [next],
        pattern: rule.pattern,
        rewrite: rule.fix,
        write: true,
      },
      path.dirname(context.filePath),
    ),
  );
  if (
    rewritten.error_count ||
    rewritten.rewrite_count !== 1 ||
    rewritten.files?.[0]?.status !== "rewritten"
  )
    throw new Error("ast-bro run did not rewrite exactly one file");
}

export const astStrategy: PatchStrategyAdapter = {
  name: "ast",
  async prepare(context) {
    validate(context);
    const next = temporary(context.filePath);
    try {
      await writeFile(next, context.original, {
        encoding: "utf8",
        flag: "wx",
        mode: context.mode,
      });
      let matches = 0;
      for (const rule of context.astRules) {
        matches += await previewRule(context, next, rule);
        await rewriteRule(context, next, rule);
      }
      return {
        candidate: await readFile(next, "utf8"),
        metadata: {
          engine: "ast-bro.run",
          matches,
          operations: context.astRules.length,
          strategy: "ast",
        },
      };
    } finally {
      try {
        await unlink(next);
      } catch {}
    }
  },
};
