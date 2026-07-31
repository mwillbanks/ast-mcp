import { applyAiderBlock } from "../aider";
import type { PatchStrategyAdapter, PatchStrategyContext } from "../strategy";

function validate(context: PatchStrategyContext): void {
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

export const aiderBlockStrategy: PatchStrategyAdapter = {
  name: "aider_block",
  async prepare(context) {
    validate(context);
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
