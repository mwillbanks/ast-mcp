import { rm } from "node:fs/promises";

/** Await transport and process teardown before removing an owned fixture root. */
export function removeTempDirectory(directory: string): Promise<void> {
  return rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}
