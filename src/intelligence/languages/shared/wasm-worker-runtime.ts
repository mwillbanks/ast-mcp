import type { MessagePort } from "node:worker_threads";

import type { SyntaxFacts } from "../../parser/index.ts";

interface WasmWorkerCancel {
  id: number;
  type: "cancel";
}

export interface WasmWorkerStart<LanguageId extends string> {
  id: number;
  languageId: LanguageId;
  source: string;
  type: "start";
}

type WasmWorkerMessage<Start extends WasmWorkerStart<string>> =
  | Start
  | WasmWorkerCancel;

export type WasmWorkerResult =
  | { facts: SyntaxFacts; id: number; ok: true; type: "result" }
  | { error: string; id: number; ok: false; type: "result" };

export function serializeWasmWorkerError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function installWasmWorker<
  Start extends WasmWorkerStart<string>,
>(options: {
  invalidError?: string;
  invalidId: (value: unknown) => number | null;
  parse: (message: Start) => Promise<SyntaxFacts>;
  port: MessagePort | null;
  suppressCanceledErrors?: boolean;
  throwOnMissingInvalidId?: boolean;
  validate: (value: unknown) => WasmWorkerMessage<Start>;
}): void {
  const canceled = new Set<number>();
  let queued = 0;
  const send = (result: WasmWorkerResult) => options.port?.postMessage(result);

  options.port?.on("message", async (value: unknown) => {
    let message: WasmWorkerMessage<Start>;
    try {
      message = options.validate(value);
    } catch (error) {
      const id = options.invalidId(value);
      if (id !== null) {
        send({
          error: options.invalidError ?? serializeWasmWorkerError(error),
          id,
          ok: false,
          type: "result",
        });
        return;
      }
      if (options.throwOnMissingInvalidId) throw error;
      return;
    }

    if (message.type === "cancel") {
      canceled.add(message.id);
      return;
    }
    if (queued >= 64) {
      send({
        error: "Worker queue capacity exceeded",
        id: message.id,
        ok: false,
        type: "result",
      });
      return;
    }

    queued += 1;
    try {
      const facts = await options.parse(message);
      if (!canceled.delete(message.id)) {
        send({ facts, id: message.id, ok: true, type: "result" });
      }
    } catch (error) {
      const wasCanceled = canceled.delete(message.id);
      if (!wasCanceled || !options.suppressCanceledErrors) {
        send({
          error: serializeWasmWorkerError(error),
          id: message.id,
          ok: false,
          type: "result",
        });
      }
    } finally {
      queued -= 1;
    }
  });
}
