import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { withConfig } from "../../src/config/index.ts";
import { createIdentity } from "../../src/intelligence/contracts/common.ts";
import {
  markRefreshPending,
  readRefreshState,
} from "../../src/intelligence/mutation/experimental-deferred-refresh.ts";
import { activeMutationLifecycle } from "../../src/intelligence/mutation/lifecycle.ts";
import { openNarrowLanceMutationJournal } from "../../src/intelligence/mutation/narrow-lance-journal.ts";
import {
  LanceMutationLifecycle,
  mutationTransactionLockPath,
  withLanceMutationLifecycle,
} from "../../src/intelligence/mutation/service.ts";
import {
  withWorkspaceContext,
  WorkspaceRegistry,
} from "../../src/intelligence/workspace/index.ts";
import { sha256 } from "../../src/runtime/hash.ts";
import { spawnLiveProcess } from "./support/live-process.ts";

const moduleUrl = (module: string) =>
  JSON.stringify(new URL("../../src/" + module + ".ts", import.meta.url).href);
const boundaries = [
  "before-enrollment",
  "before-intent",
  "after-intent",
] as const;
test.each(boundaries)(
  "restarts a Lance-to-SQLite cutover stopped %s",
  async (boundary) => {
    const root = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "ast-mcp-cutover-")),
    );
    const checkout = path.join(root, "checkout");
    let transactionPath: string | undefined;
    let sqlitePath: string | undefined;
    try {
      await mkdir(checkout);
      await writeFile(path.join(checkout, "ast-mcp.toml"), "version = 2\n");
      const workspace = await new WorkspaceRegistry().open({
        configurationGeneration: 1,
        directory: checkout,
        storage: { kind: "explicit", path: path.join(root, "index") },
      });
      const domain = workspace.storageDomain;
      const transaction = await mutationTransactionLockPath(checkout);
      transactionPath = transaction;
      sqlitePath = path.join(
        path.dirname(transaction),
        "mutation-journal-" +
          sha256(
            JSON.stringify([path.basename(transaction), domain.domainId]),
          ) +
          ".sqlite",
      );
      const oldOperation = createIdentity("job", { checkout, stage: "old" });
      const newOperation = createIdentity("job", { checkout, stage: "new" });
      const original = "export const state = 0;\n";
      const candidate = "export const state = 1;\n";
      const files = ["a.ts", "b.ts"].map((name) => ({
        candidateSha256: sha256(candidate),
        filePath: path.join(checkout, name),
        sourceContentBase64: Buffer.from(original).toString("base64"),
        sourceSha256: sha256(original),
      }));
      await Promise.all(
        files.map((file) => writeFile(file.filePath, original)),
      );
      const openOld = (requireExisting: boolean) =>
        openNarrowLanceMutationJournal(domain, checkout, { requireExisting });
      const old = await openOld(false);
      const plan = { files, tool: "file_patch" as const, workspace };
      try {
        await markRefreshPending(
          transaction,
          ["a.ts", "b.ts"],
          sha256("old scope"),
          sha256(domain.domainId),
          { inFlight: true, journal: "lance-v1" },
        );
        await old.journal.begin({ ...plan, operationId: oldOperation });
        await writeFile(files[0]!.filePath, candidate);
        await old.journal.committed(oldOperation, {
          filePath: files[0]!.filePath,
          sha256: sha256(candidate),
        });
      } finally {
        old.close();
      }

      const child = spawnLiveProcess(
        process.execPath,
        [
          "--eval",
          `
          import { withConfig } from ${moduleUrl("config/index")};
          import { LanceMutationJournal } from ${moduleUrl("intelligence/mutation/journal")};
          import { activeMutationLifecycle } from ${moduleUrl("intelligence/mutation/lifecycle")};
          import { withLanceMutationLifecycle } from ${moduleUrl("intelligence/mutation/service")};
          import { withWorkspaceContext } from ${moduleUrl("intelligence/workspace/index")};
          const plan = ${JSON.stringify({ ...plan, operationId: newOperation })};
          const boundary = ${JSON.stringify(boundary)};
          async function pause() {
            console.log(boundary);
            await new Promise(resolve => process.stdin.once("data", resolve));
          }
          const begin = LanceMutationJournal.prototype.begin;
          LanceMutationJournal.prototype.begin = async function (value) {
            if (boundary === "before-intent") await pause();
            const record = await begin.call(this, value);
            if (boundary === "after-intent") await pause();
            return record;
          };
          await withConfig({ cwd: ${JSON.stringify(checkout)} }, () =>
            withWorkspaceContext(plan.workspace, () =>
              withLanceMutationLifecycle(async () => {
                if (boundary === "before-enrollment") await pause();
                await activeMutationLifecycle().begin(plan);
              }),
            ),
          );
        `,
        ],
        { cwd: checkout },
      );
      try {
        expect(await child.readStdoutLine()).toBe(boundary);
        child.process.kill("SIGKILL");
        expect(await child.waitForExit()).not.toBe(0);
      } finally {
        await child.stop();
      }

      expect(await readRefreshState(transaction)).toMatchObject({
        inFlight: true,
        journal: boundary === "before-enrollment" ? "lance-v1" : "sqlite-v1",
      });
      const recoveredOld = await openOld(true);
      try {
        expect(await recoveredOld.journal.get(oldOperation)).toMatchObject({
          state: "recovered",
        });
      } finally {
        recoveredOld.close();
      }

      await withConfig({ cwd: checkout }, () =>
        withWorkspaceContext(workspace, () =>
          withLanceMutationLifecycle(async () => {
            const lifecycle = activeMutationLifecycle();
            if (!(lifecycle instanceof LanceMutationLifecycle))
              throw new Error("Missing mutation lifecycle");
            expect((await lifecycle.journal.get(newOperation))?.state).toBe(
              boundary === "after-intent" ? "recovered" : undefined,
            );
          }),
        ),
      );
      expect(
        await Promise.all(files.map((file) => readFile(file.filePath, "utf8"))),
      ).toEqual([original, original]);
    } finally {
      if (transactionPath)
        for (const suffix of [".refresh.json", ".refresh.json.tmp"])
          await rm(transactionPath + suffix, { force: true });
      if (sqlitePath)
        for (const suffix of ["", "-journal", "-wal", "-shm"])
          await rm(sqlitePath + suffix, { force: true });
      await rm(root, { recursive: true, force: true });
    }
  },
);
