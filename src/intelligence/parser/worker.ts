import { parseSource } from "./parser.ts";
import { type DynamicGrammarManifest, LanguageRegistry } from "./registry.ts";
import {
  ParserError,
  type ParseSourceRequest,
  type SerializedParserError,
  type SyntaxFacts,
} from "./types.ts";

interface InitializeWorkerRequest {
  manifest?: DynamicGrammarManifest;
  type: "initialize";
}

interface ParseWorkerRequest {
  id: number;
  request: ParseSourceRequest;
  type: "parse";
}

interface ParseWorkerSuccess {
  facts: SyntaxFacts;
  id: number;
  ok: true;
  type: "result";
}

interface ParseWorkerReady {
  error?: SerializedParserError;
  ok: boolean;
  type: "ready";
}

interface ParseWorkerFailure {
  error: SerializedParserError;
  id: number;
  ok: false;
  type: "result";
}

interface ParserWorkerScope {
  onmessage:
    | ((
        event: MessageEvent<InitializeWorkerRequest | ParseWorkerRequest>,
      ) => void)
    | null;
  postMessage(
    message: ParseWorkerSuccess | ParseWorkerFailure | ParseWorkerReady,
  ): void;
}

const workerScope = globalThis as unknown as ParserWorkerScope;
let registry: LanguageRegistry | null = null;

function serializeError(error: unknown): SerializedParserError {
  if (error instanceof ParserError) return error.toJSON();
  return {
    code: "worker-error",
    message:
      error instanceof Error ? error.message : "Unknown parser worker error",
    retryable: false,
  };
}

workerScope.onmessage = async (
  event: MessageEvent<InitializeWorkerRequest | ParseWorkerRequest>,
): Promise<void> => {
  const message = event.data;
  if (message.type === "initialize") {
    try {
      const initialized = new LanguageRegistry();
      if (message.manifest) {
        await initialized.loadDynamicManifest(message.manifest);
      }
      initialized.registerDynamicGrammars();
      registry = initialized;
      workerScope.postMessage({ ok: true, type: "ready" });
    } catch (error) {
      workerScope.postMessage({
        error: serializeError(error),
        ok: false,
        type: "ready",
      });
    }
    return;
  }
  try {
    if (!registry) {
      throw new ParserError({
        code: "worker-error",
        message: "Parser worker is not initialized",
        retryable: false,
      });
    }
    const response: ParseWorkerSuccess = {
      facts: parseSource(message.request, registry),
      id: message.id,
      ok: true,
      type: "result",
    };
    workerScope.postMessage(response);
  } catch (error) {
    const response: ParseWorkerFailure = {
      error: serializeError(error),
      id: message.id,
      ok: false,
      type: "result",
    };
    workerScope.postMessage(response);
  }
};
