import { parentPort } from "node:worker_threads";

import type { PatchStrategyContext } from "../strategy.ts";
import { inlineAiderBlockStrategy, inlineAstStrategy } from "./inline.ts";

parentPort?.once(
  "message",
  async (request: {
    context: PatchStrategyContext;
    strategy: "ast" | "aider_block";
  }) => {
    try {
      const adapter =
        request.strategy === "ast"
          ? inlineAstStrategy
          : inlineAiderBlockStrategy;
      parentPort?.postMessage({
        ok: true,
        patch: await adapter.prepare(request.context),
      });
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      const fields = cause as {
        code?: unknown;
        details?: unknown;
        retryable?: unknown;
        suggestedNextCall?: unknown;
      } | null;
      parentPort?.postMessage({
        error: {
          code: fields?.code,
          details: fields?.details,
          message: error.message,
          name: error.name,
          retryable: fields?.retryable,
          suggestedNextCall: fields?.suggestedNextCall,
        },
        ok: false,
      });
    } finally {
      parentPort?.close();
    }
  },
);
