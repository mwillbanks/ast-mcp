import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { LanceMutationLifecycle } from "../../../src/intelligence/mutation/service.ts";
import { LanceIntelligenceStore } from "../../../src/intelligence/storage/store.ts";
import { WorkspaceRegistry } from "../../../src/intelligence/workspace/index.ts";
import { sha256 } from "../../../src/runtime/hash.ts";

test.each([
  "owner",
  "material",
  "concurrent",
  "denied",
  "verification",
] as const)(
  "durable recovery preserves its journal on %s failures",
  async (failure) => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "ast-mcp-recovery-validation-"),
    );
    const workspace = await new WorkspaceRegistry().open({
      configurationGeneration: 1,
      directory: root,
      storage: { kind: "explicit", path: path.join(root, "index") },
    });
    const store = await LanceIntelligenceStore.open(workspace.storageDomain);
    const lifecycle = new LanceMutationLifecycle(store, workspace);
    const target = path.join(root, "value.txt");
    const source = "original\n";
    const candidate = "candidate\n";
    const operationId = `job:v1:${sha256(failure)}`;
    await fs.writeFile(
      target,
      failure === "concurrent" ? "external bytes\n" : candidate,
    );
    await lifecycle.journal.begin({
      operationId,
      workspace,
      tool: "file_patch",
      files: [
        {
          filePath: target,
          candidateSha256: sha256(candidate),
          sourceSha256: failure === "concurrent" ? null : sha256(source),
          sourceContentBase64:
            failure === "concurrent"
              ? null
              : Buffer.from(
                  failure === "material" ? "wrong material" : source,
                ).toString("base64"),
          sourceMode: null,
          sourceUid: failure === "owner" ? 0 : null,
          sourceGid: null,
        },
      ],
    });
    await lifecycle.journal.transition(operationId, "recovery-required");
    const originalStat = fs.lstat;
    const originalRename = fs.rename;
    const stat =
      failure === "denied"
        ? spyOn(fs, "lstat").mockImplementation((async (
            ...args: Parameters<typeof fs.lstat>
          ) => {
            if (String(args[0]) === target)
              throw Object.assign(new Error("recovery read denied"), {
                code: "EACCES",
              });
            return originalStat(...args);
          }) as typeof fs.lstat)
        : undefined;
    const rename =
      failure === "verification"
        ? spyOn(fs, "rename").mockImplementation(
            async (...args: Parameters<typeof fs.rename>) => {
              await originalRename(...args);
              if (String(args[1]) === target)
                await fs.writeFile(target, "external replacement\n");
            },
          )
        : undefined;
    try {
      await expect(lifecycle.recover()).rejects.toThrow(
        "mutation_recovery_required",
      );
      expect((await lifecycle.journal.get(operationId))?.state).toBe(
        "recovery-required",
      );
      expect(await Bun.file(target).text()).toBe(
        failure === "verification"
          ? "external replacement\n"
          : failure === "concurrent"
            ? "external bytes\n"
            : candidate,
      );
    } finally {
      stat?.mockRestore();
      rename?.mockRestore();
      await store.shutdownCoordinator();
      await fs.rm(root, { force: true, recursive: true });
    }
  },
);
