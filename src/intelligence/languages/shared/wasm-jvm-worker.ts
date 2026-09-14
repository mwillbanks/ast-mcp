import { installMainstreamWasmWorker } from "./wasm-mainstream-worker.ts";
import { validateJvmWorkerRequest } from "./wasm-worker-validation.ts";

installMainstreamWasmWorker({
  profile: "jvm",
  validate: validateJvmWorkerRequest,
});
