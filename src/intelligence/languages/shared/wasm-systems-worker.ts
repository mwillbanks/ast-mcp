import { installMainstreamWasmWorker } from "./wasm-mainstream-worker.ts";
import { validateSystemsWorkerRequest } from "./wasm-worker-validation.ts";

installMainstreamWasmWorker({
  profile: "systems",
  validate: validateSystemsWorkerRequest,
});
