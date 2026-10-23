import { parentPort } from "node:worker_threads";

import {
  createPotionStaticSession,
  InlinePotionProvider,
  InlineTransformersProvider,
} from "./model-provider.ts";
import type { ModelWorkerRequest } from "./worker-session.ts";

let provider: InlinePotionProvider | InlineTransformersProvider | undefined;
let tail = Promise.resolve();

parentPort?.on("message", (request: ModelWorkerRequest) => {
  // A model session has one owner. Serialize native inference inside its thread.
  tail = tail.then(async () => {
    try {
      provider ??=
        request.kind === "potion"
          ? new InlinePotionProvider(request.config, (config) =>
              createPotionStaticSession(config),
            )
          : new InlineTransformersProvider(
              request.config,
              request.allowDownload,
              async (task, model, options) => {
                const { pipeline } = await import("@huggingface/transformers");
                return (await pipeline(task, model, options)) as never;
              },
            );
      await provider.initialize();
      parentPort?.postMessage({ id: request.id, type: "started" });
      const vectors = await provider.embed(request.texts);
      parentPort?.postMessage({ id: request.id, vectors });
    } catch (error) {
      parentPort?.postMessage({
        error: error instanceof Error ? error.message : String(error),
        errorName: error instanceof Error ? error.name : "Error",
        id: request.id,
      });
    }
  });
});
