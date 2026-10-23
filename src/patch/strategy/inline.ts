import {
  type ParserLanguageId,
  rewriteStructuralMatches,
} from "../../intelligence/parser/index.ts";
import { applyAiderBlock } from "../aider";
import type {
  AstRule,
  PatchStrategyAdapter,
  PatchStrategyContext,
} from "../strategy";

function validateAst(
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

export const inlineAstStrategy: PatchStrategyAdapter = {
  name: "ast",
  async prepare(context) {
    validateAst(context);
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

function validateAider(context: PatchStrategyContext): void {
  if (!context.capabilities.effective.patch.includes("aider_block"))
    throw Object.assign(
      new Error(
        `patchStrategy 'aider_block' is not available for this file; available strategies: ${context.capabilities.effective.patch.join(", ") || "none"}`,
      ),
      {
        code: "patch_strategy_unavailable",
        details: { capabilities: context.capabilities },
        retryable: true,
      },
    );
  if (context.aiderBlocks.length === 0 || context.astRules.length > 0)
    throw Object.assign(
      new Error(
        "patchStrategy 'aider_block' requires aiderBlocks and no astRules",
      ),
      { code: "patch_strategy_arguments", retryable: true },
    );
}

function assertAiderMatcher(
  context: PatchStrategyContext,
  method: string,
  operation: number,
): void {
  if (method === "append") return;
  if (context.capabilities.effective.aiderMatchers.includes(method as never))
    return;
  throw Object.assign(
    new Error(`Aider matcher '${method}' is disabled by policy`),
    {
      code: "aider_matcher_disabled",
      details: {
        capabilities: context.capabilities,
        matcher: method,
        operation,
      },
      retryable: true,
    },
  );
}

function throwAiderFailure(
  error: unknown,
  operation: number,
  search: string,
): never {
  if (typeof error === "object" && error && "code" in error) throw error;
  const message = error instanceof Error ? error.message : String(error);
  const code = /ambiguous|multiple/i.test(message)
    ? "aider_ambiguous"
    : "aider_no_match";
  throw Object.assign(error instanceof Error ? error : new Error(message), {
    code,
    details: { operation, searchPreview: search.slice(0, 200) },
    retryable: true,
    suggestedNextCall: "file_read",
  });
}

function applyConfiguredAiderBlock(
  context: PatchStrategyContext,
  content: string,
  block: PatchStrategyContext["aiderBlocks"][number],
  operation: number,
) {
  try {
    const result = applyAiderBlock(content, block.search, block.replace);
    assertAiderMatcher(context, result.method, operation);
    return result;
  } catch (error) {
    return throwAiderFailure(error, operation, block.search);
  }
}

function prepareAiderBlocks(context: PatchStrategyContext) {
  let content = context.original;
  const methods: string[] = [];
  for (const [index, block] of context.aiderBlocks.entries()) {
    const result = applyConfiguredAiderBlock(
      context,
      content,
      block,
      index + 1,
    );
    content = result.content;
    methods.push(result.method);
  }
  return { content, methods };
}

export const inlineAiderBlockStrategy: PatchStrategyAdapter = {
  name: "aider_block",
  async prepare(context) {
    validateAider(context);
    const { content, methods } = prepareAiderBlocks(context);
    return {
      candidate: content,
      metadata: {
        matchMethods: methods,
        operations: context.aiderBlocks.length,
        strategy: "aider_block",
      },
    };
  },
};
