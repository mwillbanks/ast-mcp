import { parentPort } from "node:worker_threads";

import {
  createPotionStaticSession,
  PotionStaticEmbeddingProvider,
  TransformersEmbeddingProvider,
  type EmbeddingProvider,
} from "./embedding.ts";
import type { ModelWorkerRequest } from "./worker-session.ts";

let provider: EmbeddingProvider | undefined;
let tail = Promise.resolve();

parentPort?.on("message", (request: ModelWorkerRequest) => {
  // A model session has one owner. Serialize native inference inside its thread.
  tail = tail.then(async () => {
    try {
      provider ??=
        request.kind === "potion"
          ? new PotionStaticEmbeddingProvider(request.config, (config) =>
              createPotionStaticSession(config),
            )
          : new TransformersEmbeddingProvider(
              request.config,
              request.allowDownload,
              async (task, model, options) => {
                const { pipeline } = await import("@huggingface/transformers");
                return (await pipeline(task, model, options)) as never;
              },
            );
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
