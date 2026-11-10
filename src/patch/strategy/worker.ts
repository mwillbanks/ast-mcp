import { parentPort } from "node:worker_threads";

import type { NativeGrammarSet } from "../../intelligence/parser/native-pack-selection.ts";
import {
  defaultLanguageRegistry,
  type DynamicGrammarManifest,
  initializeNativePackRegistry,
} from "../../intelligence/parser/registry.ts";
import type { PatchStrategyContext } from "../strategy.ts";
import { inlineAiderBlockStrategy, inlineAstStrategy } from "./inline.ts";

async function prepare(request: {
  context: PatchStrategyContext;
  manifest?: DynamicGrammarManifest;
  packs?: NativeGrammarSet;
  strategy: "ast" | "aider_block";
}) {
  const reply = (value: unknown) =>
    parentPort
      ? parentPort.postMessage(value)
      : process.send?.(
          value as Parameters<NonNullable<typeof process.send>>[0],
        );
  try {
    if (request.packs) {
      await initializeNativePackRegistry(request.packs, request.manifest);
    } else if (request.strategy === "ast" && request.manifest) {
      await defaultLanguageRegistry.loadDynamicManifest(request.manifest);
      defaultLanguageRegistry.registerDynamicGrammars();
    }
    const adapter =
      request.strategy === "ast" ? inlineAstStrategy : inlineAiderBlockStrategy;
    const patch = await adapter.prepare(request.context);
    reply({ ok: true, patch });
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    const fields = cause as {
      code?: unknown;
      details?: unknown;
      retryable?: unknown;
      suggestedNextCall?: unknown;
    } | null;
    reply({
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
}

if (parentPort) parentPort.once("message", prepare);
else if (typeof process.send === "function") process.once("message", prepare);
