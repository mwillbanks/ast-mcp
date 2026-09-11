import {
  type ParserLanguageId,
  rewriteStructuralMatches,
} from "../../intelligence/parser/index.ts";
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

function structuralFailure(error: unknown, rule: AstRule): Error {
  const message = error instanceof Error ? error.message : String(error);
  const matchCount = message.match(/expected (\d+) matches but found (\d+)/);
  if (matchCount) {
    const expected = Number(matchCount[1]);
    const matches = Number(matchCount[2]);
    return Object.assign(
      new Error(`AST rule matched ${matches} nodes; expected ${expected}`),
      {
        code: "ast_match_count",
        details: { expected, matches, pattern: rule.pattern },
        retryable: true,
        suggestedNextCall: "run",
      },
    );
  }
  if (message.includes("overlap"))
    return Object.assign(new Error(message), {
      code: "ast_rewrite_overlap",
      details: { pattern: rule.pattern },
      retryable: true,
      suggestedNextCall: "run",
    });
  return Object.assign(new Error(message), {
    code: "ast_preview_error",
    details: { pattern: rule.pattern },
    retryable: true,
    suggestedNextCall: "run",
  });
}

export const astStrategy: PatchStrategyAdapter = {
  name: "ast",
  async prepare(context) {
    validate(context);
    let candidate = context.original;
    let matches = 0;
    for (const rule of context.astRules) {
      try {
        const rewritten = rewriteStructuralMatches(
          candidate,
          context.language as ParserLanguageId,
          [
            {
              expectedMatches: rule.expectedMatches ?? 1,
              pattern: rule.pattern,
              replacement: rule.fix,
            },
          ],
        );
        candidate = rewritten.source;
        matches += rewritten.matches.length;
      } catch (error) {
        throw structuralFailure(error, rule);
      }
    }
    return {
      candidate,
      metadata: {
        engine: "ast-mcp.native",
        matches,
        operations: context.astRules.length,
        strategy: "ast",
      },
    };
  },
};
