import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import * as lancedb from "@lancedb/lancedb";

import {
  createStorageDomainId,
  type StorageDomain,
} from "../../../src/intelligence/contracts/storage.ts";
import { LanceIntelligenceStore } from "../../../src/intelligence/storage/store.ts";

test("expired writer metadata cannot admit a second process during an active operation", async () => {
  const storagePath = await mkdtemp(
    path.join(os.tmpdir(), "ast-mcp-expired-storage-"),
  );
  const placement = { kind: "explicit" as const, path: storagePath };
  const domain: StorageDomain = {
    domainId: createStorageDomainId({
      engine: "lancedb",
      placement,
      pool: "shared",
      storagePath,
    }),
    engine: "lancedb",
    placement,
    pool: "shared",
    schemaVersion: "ast-mcp.intelligence.v1",
    storagePath,
  };
  const store = await LanceIntelligenceStore.open(domain, {
    leaseDurationMs: 60_000,
  });
  let enter!: () => void;
  let finish!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const operation = store.serializeMigration(
    "paused native operation",
    async () => {
      enter();
      await gate;
    },
  );
  const observed = operation.catch((error: unknown) => error);
  await entered;
  try {
    const connection = await lancedb.connect(storagePath, {
      readConsistencyInterval: 0,
    });
    const table = await connection.openTable("coordinator_recovery");
    try {
      // Simulate a paused owner whose lease deadline passed without allowing its
      // already-started native operation to finish.
      await table.update({
        values: { lease_expires_at: "2020-01-01T00:00:00.000Z" },
        where: "lease_key = 'writer'",
      });
    } finally {
      table.close();
      connection.close();
    }
    const modulePath = Bun.fileURLToPath(
      new URL("../../../src/intelligence/storage/store.ts", import.meta.url),
    );
    const child = Bun.spawn(
      [
        process.execPath,
        "--eval",
        `
      import { LanceIntelligenceStore } from ${JSON.stringify(modulePath)};
      try {
        const store = await LanceIntelligenceStore.open(${JSON.stringify(domain)});
        await store.shutdownCoordinator();
        process.exit(2);
      } catch (error) {
        console.log(error.code);
        process.exit(error.code === "coordinator_unavailable" ? 0 : 3);
      }
    `,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(stderr).toBe("");
    expect(stdout.trim()).toBe("coordinator_unavailable");
    expect(code).toBe(0);
  } finally {
    finish();
    await expect(observed).resolves.toMatchObject({
      code: "coordinator_unavailable",
    });
    await store.shutdownCoordinator();
    await rm(storagePath, { recursive: true, force: true });
  }
});
