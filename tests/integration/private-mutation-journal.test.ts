import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createIdentity } from "../../src/intelligence/contracts/common.ts";
import { openNarrowLanceMutationJournal } from "../../src/intelligence/mutation/narrow-lance-journal.ts";
import { openPrivateMutationJournal } from "../../src/intelligence/mutation/private-journal.ts";
import { LanceMutationLifecycle } from "../../src/intelligence/mutation/service.ts";
import { WorkspaceRegistry } from "../../src/intelligence/workspace/index.ts";
import { sha256 } from "../../src/runtime/hash.ts";
import {
  ensurePrivateLockDirectory,
  systemAccount,
} from "../../src/runtime/private-lock-directory.ts";
import { spawnLiveProcess } from "./support/live-process.ts";

const sqliteAdapter = new URL(
  "../../src/intelligence/mutation/private-journal.ts",
  import.meta.url,
).href;
const lanceAdapter = new URL(
  "../../src/intelligence/mutation/narrow-lance-journal.ts",
  import.meta.url,
).href;
const leaseModule = new URL(
  "../../src/runtime/transaction-lock.ts",
  import.meta.url,
).href;

const crashCases = (["delete", "wal", "lance"] as const).flatMap((backend) =>
  (
    [
      "intent",
      "unrecorded-file",
      "recorded-file",
      "all-files",
      "terminal",
    ] as const
  ).map((boundary) => [backend, boundary] as const),
);

test.each(crashCases)(
  "%s journal recovers exact source bytes after a crash at %s",
  async (backend, boundary) => {
    const root = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "ast-mcp-private-journal-")),
    );
    let databasePath: string | undefined;
    try {
      const checkoutRoot = path.join(root, "checkout");
      const storage = {
        kind: "explicit" as const,
        path: path.join(root, "index"),
      };
      await mkdir(checkoutRoot);
      const registry = new WorkspaceRegistry();
      const workspace = await registry.open({
        configurationGeneration: 1,
        directory: checkoutRoot,
        storage,
      });
      const domain = workspace.storageDomain;
      const directory = await ensurePrivateLockDirectory(await systemAccount());
      const checkout = "transaction-" + sha256(checkoutRoot);
      const transactionPath = path.join(directory, checkout);
      const databaseIdentity = sha256(
        JSON.stringify([checkout, domain.domainId]),
      );
      databasePath =
        backend === "lance"
          ? path.join(
              storage.path,
              "mutation_journal_" +
                sha256(JSON.stringify([checkoutRoot, domain.domainId])) +
                ".lance",
            )
          : path.join(
              directory,
              "mutation-journal-" + databaseIdentity + ".sqlite",
            );
      const operationId = createIdentity("job", { root });
      const source = "export const n = 1;\n";
      const candidate = "export const n = 2;\n";
      const candidateSha256 = sha256(candidate);
      const files = ["a.ts", "b.ts"].map((file) => ({
        candidateSha256,
        filePath: path.join(checkoutRoot, file),
        sourceContentBase64: Buffer.from(source).toString("base64"),
        sourceSha256: sha256(source),
      }));
      await Promise.all(files.map((file) => writeFile(file.filePath, source)));
      const plan = { files, operationId, tool: "file_patch", workspace };
      const openChild =
        backend === "lance"
          ? `await openNarrowLanceMutationJournal(${JSON.stringify(domain)}, ${JSON.stringify(checkoutRoot)})`
          : `await openPrivateMutationJournal(${JSON.stringify(transactionPath)}, ${JSON.stringify(domain.domainId)}, { journalMode: ${JSON.stringify(backend)} })`;
      const child = spawnLiveProcess(process.execPath, [
        "--eval",
        `
          import { open } from "node:fs/promises";
          import { acquireTransactionLock } from ${JSON.stringify(leaseModule)};
          import { openPrivateMutationJournal } from ${JSON.stringify(sqliteAdapter)};
          import { openNarrowLanceMutationJournal } from ${JSON.stringify(lanceAdapter)};
          const lease = await acquireTransactionLock(${JSON.stringify(transactionPath)});
          const { journal } = ${openChild};
          const plan = ${JSON.stringify(plan)};
          const boundary = ${JSON.stringify(boundary)};
          const candidate = ${JSON.stringify(candidate)};
          async function commitFile(file, record) {
            const handle = await open(file.filePath, "w");
            try {
              await handle.writeFile(candidate);
              await handle.sync();
            } finally {
              await handle.close();
            }
            if (record)
              await journal.committed(plan.operationId, {
                filePath: file.filePath,
                sha256: file.candidateSha256,
              });
          }
          await journal.begin(plan);
          if (boundary !== "intent")
            await commitFile(plan.files[0], boundary !== "unrecorded-file");
          if (boundary === "all-files" || boundary === "terminal")
            await commitFile(plan.files[1], true);
          if (boundary === "terminal")
            await journal.transition(plan.operationId, "succeeded");
          console.log(boundary);
          await new Promise(resolve => process.stdin.once("data", resolve));
          lease.release();
        `,
      ]);
      try {
        expect(await child.readStdoutLine()).toBe(boundary);
        child.process.kill("SIGKILL");
        expect(await child.waitForExit()).not.toBe(0);
      } finally {
        await child.stop();
      }

      const openEnrolled = () =>
        backend === "lance"
          ? openNarrowLanceMutationJournal(domain, checkoutRoot, {
              requireExisting: true,
            })
          : openPrivateMutationJournal(transactionPath, domain.domainId, {
              requireExisting: true,
            });
      const recovery = await openEnrolled();
      try {
        if (backend !== "lance") {
          const inspector = new Database(databasePath, { readonly: true });
          try {
            expect(inspector.query("PRAGMA journal_mode").get()).toEqual({
              journal_mode: backend,
            });
          } finally {
            inspector.close();
          }
        } else {
          const otherRoot = path.join(root, "other");
          await mkdir(otherRoot);
          const otherWorkspace = await registry.open({
            configurationGeneration: 1,
            directory: otherRoot,
            storage,
          });
          const other = await openNarrowLanceMutationJournal(domain, otherRoot);
          try {
            expect(await other.journal.get(operationId)).toBeNull();
            await expect(
              recovery.journal.begin({
                ...plan,
                tool: "file_patch",
                workspace: otherWorkspace,
              }),
            ).rejects.toThrow("mutation_journal_scope_mismatch");
          } finally {
            other.close();
          }
        }

        const record = await recovery.journal.get(operationId);
        expect(record?.state).toBe(
          boundary === "terminal" ? "succeeded" : "running",
        );
        expect(record?.files.map((file) => file.committedSha256)).toEqual([
          ["intent", "unrecorded-file"].includes(boundary)
            ? null
            : candidateSha256,
          ["all-files", "terminal"].includes(boundary) ? candidateSha256 : null,
        ]);
        await new LanceMutationLifecycle(undefined, workspace, undefined, {
          journal: recovery.journal,
        }).recover();
        const expected = boundary === "terminal" ? candidate : source;
        expect(
          await Promise.all(
            files.map((file) => readFile(file.filePath, "utf8")),
          ),
        ).toEqual([expected, expected]);
      } finally {
        recovery.close();
      }

      const reopened = await openEnrolled();
      try {
        expect(await reopened.journal.get(operationId)).toMatchObject({
          state: boundary === "terminal" ? "succeeded" : "recovered",
        });
        expect(
          await reopened.journal.unfinished(
            workspace.workspaceId,
            checkoutRoot,
          ),
        ).toEqual([]);
      } finally {
        reopened.close();
      }

      await rm(databasePath, { recursive: backend === "lance" });
      await expect(openEnrolled()).rejects.toThrow("mutation_journal_missing");
      await expect(lstat(databasePath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      if (databasePath && backend !== "lance") {
        for (const suffix of ["", "-journal", "-wal", "-shm"])
          await rm(databasePath + suffix, { force: true });
      }
      await rm(root, { force: true, recursive: true });
    }
  },
);
