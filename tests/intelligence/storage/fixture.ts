import { spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";

import * as lancedb from "@lancedb/lancedb";

import { LanceIntelligenceStore } from "../../../src/intelligence/storage/index.ts";

/** Own native storage resources inside a test, before the global clock teardown. */
export class StorageFixture implements AsyncDisposable {
  private readonly cleanup: (() => void | Promise<void>)[] = [];
  private readonly restores: (() => void)[] = [];

  async directory(prefix: string): Promise<string> {
    const directory = await mkdtemp(prefix);
    this.cleanup.push(() => rm(directory, { recursive: true, force: true }));
    return directory;
  }

  store<T extends { shutdownCoordinator(): Promise<void> }>(store: T): T {
    this.cleanup.push(() => store.shutdownCoordinator());
    return store;
  }

  close<T extends { close(): void | Promise<void>; isOpen?(): boolean }>(
    resource: T,
  ): T {
    this.cleanup.push(() => {
      if (resource.isOpen?.() === false) return;
      return resource.close();
    });
    return resource;
  }

  async open(...args: Parameters<typeof LanceIntelligenceStore.open>) {
    return this.store(await LanceIntelligenceStore.open(...args));
  }

  async openHistoricalRead(
    ...args: Parameters<typeof LanceIntelligenceStore.openHistoricalRead>
  ) {
    return this.store(await LanceIntelligenceStore.openHistoricalRead(...args));
  }

  async connect(uri: string, options?: Partial<lancedb.ConnectionOptions>) {
    return this.close(await lancedb.connect(uri, options));
  }

  async pin(
    store: LanceIntelligenceStore,
    ...args: Parameters<LanceIntelligenceStore["pinGeneration"]>
  ) {
    return this.close(await store.pinGeneration(...args));
  }

  spyOn<T extends object, K extends keyof T>(target: T, key: K) {
    const spy = spyOn(target, key);
    this.restores.push(() => {
      spy.mockRestore();
    });
    return spy;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    const failures: unknown[] = [];
    for (const dispose of [
      ...this.restores.splice(0).reverse(),
      ...this.cleanup.splice(0).reverse(),
    ]) {
      try {
        await dispose();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0)
      throw new AggregateError(failures, "Storage fixture cleanup failed");
  }
}
