import { parentPort } from "node:worker_threads";

import {
  defaultLanguageRegistry,
  type DynamicGrammarManifest,
} from "../../intelligence/parser/registry.ts";
import type { PatchStrategyContext } from "../strategy.ts";
import { inlineAiderBlockStrategy, inlineAstStrategy } from "./inline.ts";

parentPort?.once(
  "message",
  async (request: {
    context: PatchStrategyContext;
    manifest?: DynamicGrammarManifest;
    strategy: "ast" | "aider_block";
  }) => {
    try {
      if (request.strategy === "ast" && request.manifest) {
        await defaultLanguageRegistry.loadDynamicManifest(request.manifest);
        defaultLanguageRegistry.registerDynamicGrammars();
      }
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
