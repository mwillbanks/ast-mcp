import { afterEach, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { withConfig } from "../../../src/config/index.ts";
import { withMutationLifecycle } from "../../../src/intelligence/mutation/lifecycle.ts";
import {
  LanceMutationLifecycle,
  mutationOperationId,
} from "../../../src/intelligence/mutation/service.ts";
import type { MutationFilePlan } from "../../../src/intelligence/mutation/types.ts";
import { LanceIntelligenceStore } from "../../../src/intelligence/storage/store.ts";
import {
  WorkspaceRegistry,
  withWorkspaceContext,
} from "../../../src/intelligence/workspace/index.ts";
import { patchFiles, writeFilesSafely } from "../../../src/patch/engine.ts";
import { deleteFilesSafely } from "../../../src/runtime/file-delete.ts";
import { renameFilesSafely } from "../../../src/runtime/file-rename.ts";
import { sha256, sha256File } from "../../../src/runtime/hash.ts";
import * as hashing from "../../../src/runtime/hash.ts";
import {
  ensurePrivateLockDirectory,
  systemAccount,
} from "../../../src/runtime/private-lock-directory.ts";
import {
  snapshotNamespace,
  stageFileSnapshot,
  type StagedFileSnapshot,
} from "../../../src/runtime/snapshot-blob.ts";
import * as snapshotStorage from "../../../src/runtime/snapshot-blob.ts";
import registerFileTools from "../../../src/tools/files.ts";
import registerLifecycleTools from "../../../src/tools/lifecycle.ts";

const cleanup: Array<() => Promise<void>> = [];
const previousRoots = process.env.AST_MCP_ROOTS;
const previousExternal = process.env.AST_MCP_ALLOW_EXTERNAL_ROOTS;
afterEach(async () => {
  for (const operation of cleanup.splice(0).reverse()) await operation();
  if (previousRoots === undefined) delete process.env.AST_MCP_ROOTS;
  else process.env.AST_MCP_ROOTS = previousRoots;
  if (previousExternal === undefined)
    delete process.env.AST_MCP_ALLOW_EXTERNAL_ROOTS;
  else process.env.AST_MCP_ALLOW_EXTERNAL_ROOTS = previousExternal;
});

async function fixture() {
  const temporary = await fs.mkdtemp(
    path.join(os.tmpdir(), "ast-mcp-durable-blob-"),
  );
  const workspace = await new WorkspaceRegistry().open({
    configurationGeneration: 1,
    directory: temporary,
    storage: { kind: "explicit", path: path.join(temporary, "index") },
  });
  const root = workspace.checkoutRoot;
  await fs.writeFile(path.join(root, "ast-mcp.toml"), "version = 1\n");
  process.env.AST_MCP_ROOTS = root;
  process.env.AST_MCP_ALLOW_EXTERNAL_ROOTS = "1";
  const store = await LanceIntelligenceStore.open(workspace.storageDomain);
  const lifecycle = new LanceMutationLifecycle(store, workspace, async () => ({
    dirtyOverlayId: null,
    generationId: null,
    indexedAt: new Date().toISOString(),
    parsedFiles: [],
    skippedFiles: [],
  }));
  const snapshotRoot = path.join(
    await ensurePrivateLockDirectory(await systemAccount()),
    "snapshots",
    snapshotNamespace(workspace),
  );
  cleanup.push(async () => {
    await store.shutdownCoordinator();
    await fs.rm(root, { force: true, recursive: true });
    await fs.rm(snapshotRoot, { force: true, recursive: true });
  });
  return { root, workspace, store, lifecycle, snapshotRoot };
}

function sourcePlan(
  filePath: string,
  snapshot: StagedFileSnapshot,
  candidate: string | null = null,
): MutationFilePlan {
  return {
    filePath,
    sourceSha256: snapshot.sha256,
    sourceBlob: snapshot.sourceBlob,
    sourceContentBase64: null,
    candidateSha256: candidate,
    sourceMode: snapshot.mode,
    sourceUid: process.platform === "win32" ? null : snapshot.uid,
    sourceGid: process.platform === "win32" ? null : snapshot.gid,
  };
}

test("guarded binary deletion journals compact durable snapshots", async () => {
  const { root, workspace, store, lifecycle, snapshotRoot } = await fixture();
  const target = path.join(root, "checkpoint.bin");
  const bytes = Buffer.alloc(4 * 1024 * 1024, 0xa1);
  await fs.writeFile(target, bytes);
  await withWorkspaceContext(workspace, () =>
    withMutationLifecycle(lifecycle, () =>
      deleteFilesSafely({ [target]: { expectedSha256: sha256(bytes) } }),
    ),
  );
  expect(await Bun.file(target).exists()).toBeFalse();
  const rows = await store.rows("jobs");
  const record = rows
    .map((row) => JSON.parse(String(row.payload_json)))
    .find((row) => row.tool === "file_delete");
  expect(record.state).toBe("succeeded");
  expect(record.files[0].sourceContentBase64).toBeNull();
  expect(record.files[0].sourceBlob.size).toBe(bytes.length);
  expect(JSON.stringify(record).length).toBeLessThan(4096);
  expect(await fs.readdir(snapshotRoot)).toEqual([]);
});

test.each([
  "default",
  "number",
  "date",
  "expired",
  "elapsed",
  "invalid",
] as const)(
  "recovery hashes share the absolute caller deadline: %s",
  async (kind) => {
    const { root, workspace, store, lifecycle, snapshotRoot } = await fixture();
    const target = path.join(root, "deadline.bin");
    await fs.writeFile(target, "original");
    const snapshot = await withWorkspaceContext(workspace, () =>
      stageFileSnapshot(target),
    );
    const operationId = `job:v1:${sha256("deadline " + kind)}`;
    await lifecycle.journal.begin({
      operationId,
      workspace,
      tool: "file_write",
      files: [sourcePlan(target, snapshot, sha256("candidate"))],
    });
    await lifecycle.journal.transition(operationId, "recovery-required");
    await fs.writeFile(target, "candidate");
    let now = Date.now();
    const absolute = now + 120_000;
    const deadline =
      kind === "default"
        ? undefined
        : kind === "date"
          ? new Date(absolute)
          : kind === "invalid"
            ? new Date(NaN)
            : kind === "elapsed"
              ? now - 1
              : absolute;
    const recovery = new LanceMutationLifecycle(store, workspace, undefined, {
      deadline,
      signal: kind === "date" ? new AbortController().signal : undefined,
    });
    const actualHash = hashing.sha256Handle;
    const budgets: Array<number | undefined> = [];
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    const hash = spyOn(hashing, "sha256Handle").mockImplementation(
      async (...args) => {
        budgets.push(args[2]);
        const digest = await actualHash(...args);
        now = kind === "expired" ? absolute + 1 : now + 100;
        return digest;
      },
    );
    const failed = ["expired", "elapsed", "invalid"].includes(kind);
    try {
      if (failed)
        await expect(recovery.recover()).rejects.toThrow(
          "mutation_recovery_required",
        );
      else await recovery.recover();
    } finally {
      hash.mockRestore();
      clock.mockRestore();
    }
    if (kind === "default")
      expect(budgets.every((budget) => budget === undefined)).toBeTrue();
    else if (kind === "elapsed" || kind === "invalid")
      expect(budgets).toEqual([]);
    else {
      expect(budgets.length).toBeGreaterThan(0);
      expect(
        budgets.every((budget) => budget! > 30_000 && budget! <= 120_000),
      ).toBeTrue();
      for (let index = 1; index < budgets.length; index++)
        expect(budgets[index]!).toBeLessThan(budgets[index - 1]!);
    }
    expect(await fs.readFile(target, "utf8")).toBe(
      failed ? "candidate" : "original",
    );
    expect((await lifecycle.journal.get(operationId))?.state).toBe(
      failed ? "recovery-required" : "recovered",
    );
    if (failed)
      expect(await fs.readdir(snapshotRoot)).toContain(snapshot.sourceBlob.id);
    else expect(await fs.readdir(snapshotRoot)).toEqual([]);
  },
);

test("failed journal creation preserves targets and reclaims unreferenced captures", async () => {
  const { root, workspace, lifecycle, snapshotRoot } = await fixture();
  const target = path.join(root, "checkpoint.bin");
  await fs.writeFile(target, "original");
  const begin = spyOn(lifecycle.journal, "begin").mockRejectedValue(
    new Error("journal unavailable"),
  );
  try {
    await expect(
      withWorkspaceContext(workspace, () =>
        withMutationLifecycle(lifecycle, () =>
          deleteFilesSafely({
            [target]: { expectedSha256: sha256("original") },
          }),
        ),
      ),
    ).rejects.toThrow("journal unavailable");
  } finally {
    begin.mockRestore();
  }
  expect(await fs.readFile(target, "utf8")).toBe("original");
  await lifecycle.recover();
  expect(await fs.readdir(snapshotRoot)).toEqual([]);
});

test.each(["missing", "corrupt", "symlink"] as const)(
  "recovery validates all %s blob material before changing targets",
  async (failure) => {
    const { root, workspace, lifecycle, snapshotRoot } = await fixture();
    const first = path.join(root, "first.bin"),
      second = path.join(root, "second.bin");
    await fs.writeFile(first, "first original");
    await fs.writeFile(second, "second original");
    const [a, b] = await withWorkspaceContext(workspace, async () => [
      await stageFileSnapshot(first),
      await stageFileSnapshot(second),
    ]);
    const operationId = `job:v1:${sha256(failure)}`;
    await lifecycle.journal.begin({
      operationId,
      workspace,
      tool: "file_delete",
      files: [
        sourcePlan(first, a!, sha256("first candidate")),
        sourcePlan(second, b!, sha256("second candidate")),
      ],
    });
    await lifecycle.journal.transition(operationId, "recovery-required");
    await fs.writeFile(first, "first candidate");
    await fs.writeFile(second, "second candidate");
    const stored = path.join(
      snapshotRoot,
      b!.sourceBlob.id,
      `${b!.sha256}.blob`,
    );
    if (failure === "corrupt") await fs.writeFile(stored, "broken material");
    else {
      await fs.unlink(stored);
      if (failure === "symlink") await fs.symlink(first, stored);
    }
    await expect(lifecycle.recover()).rejects.toThrow(
      "mutation_recovery_required",
    );
    expect(await fs.readFile(first, "utf8")).toBe("first candidate");
    expect(await fs.readFile(second, "utf8")).toBe("second candidate");
    expect((await lifecycle.journal.get(operationId))?.state).toBe(
      "recovery-required",
    );
  },
);

test("streaming recovery preserves a target changed during copying", async () => {
  const { root, workspace, lifecycle } = await fixture();
  const target = path.join(root, "checkpoint.bin");
  await fs.writeFile(target, Buffer.alloc(4 * 1024 * 1024, 9));
  const snapshot = await withWorkspaceContext(workspace, () =>
    stageFileSnapshot(target),
  );
  const operationId = `job:v1:${sha256("recovery conflict")}`;
  await lifecycle.journal.begin({
    operationId,
    workspace,
    tool: "file_write",
    files: [sourcePlan(target, snapshot, sha256("candidate"))],
  });
  await lifecycle.journal.transition(operationId, "recovery-required");
  await fs.writeFile(target, "candidate");
  const actualOpen = fs.open;
  let injected = false;
  const open = spyOn(fs, "open").mockImplementation((async (
    ...args: Parameters<typeof fs.open>
  ) => {
    const handle = await actualOpen(...args);
    if (String(args[0]).includes(".recovery-") && args[1] === "wx") {
      const write = handle.write.bind(handle);
      spyOn(handle, "write").mockImplementation((async (
        ...writeArgs: Parameters<typeof handle.write>
      ) => {
        if (!injected) {
          injected = true;
          await fs.writeFile(target, "external change");
        }
        return write(...writeArgs);
      }) as typeof handle.write);
    }
    return handle;
  }) as typeof fs.open);
  try {
    await expect(lifecycle.recover()).rejects.toThrow(
      "mutation_recovery_required",
    );
    expect(await fs.readFile(target, "utf8")).toBe("external change");
    expect(
      (await fs.readdir(root)).filter((name) => name.includes(".recovery-")),
    ).toEqual([]);
  } finally {
    open.mockRestore();
  }
});

test.each(["replacement", "unlink", "directory"] as const)(
  "recovery retains its blob when temporary cleanup fails: %s",
  async (phase) => {
    if (phase === "directory" && process.platform === "win32") return;
    const { root, workspace, lifecycle, snapshotRoot } = await fixture();
    const target = path.join(root, "cleanup.bin");
    await fs.writeFile(target, "original");
    const snapshot = await withWorkspaceContext(workspace, () =>
      stageFileSnapshot(target),
    );
    const operationId = `job:v1:${sha256("cleanup " + phase)}`;
    await lifecycle.journal.begin({
      operationId,
      workspace,
      tool: "file_write",
      files: [sourcePlan(target, snapshot, sha256("candidate"))],
    });
    await lifecycle.journal.transition(operationId, "recovery-required");
    await fs.writeFile(target, "candidate");
    const actualOpen = fs.open,
      actualUnlink = fs.unlink;
    let temporary = "";
    let output: Awaited<ReturnType<typeof fs.open>> | undefined;
    let cleanupAttempted = false;
    const open = spyOn(fs, "open").mockImplementation((async (
      ...args: Parameters<typeof fs.open>
    ) => {
      const handle = await actualOpen(...args);
      const name = String(args[0]);
      if (name.includes(".recovery-") && args[1] !== "wx") {
        temporary = name;
        output = handle;
        spyOn(handle, "sync").mockImplementation(async () => {
          if (phase === "replacement") {
            await fs.rename(name, name + ".owned");
            await fs.writeFile(name, "replacement");
          }
          throw new Error("recovery metadata failed");
        });
      } else if (name === root && phase === "directory")
        spyOn(handle, "sync").mockImplementation(async () => {
          cleanupAttempted = true;
          throw new Error("cleanup directory sync failed");
        });
      return handle;
    }) as typeof fs.open);
    const unlink = spyOn(fs, "unlink").mockImplementation(async (file) => {
      if (String(file).includes(".recovery-") && phase === "unlink") {
        cleanupAttempted = true;
        throw new Error("cleanup unlink failed");
      }
      return actualUnlink(file);
    });
    try {
      await expect(lifecycle.recover()).rejects.toThrow(
        "mutation_recovery_required",
      );
      expect(await fs.readFile(target, "utf8")).toBe("candidate");
      expect((await lifecycle.journal.get(operationId))?.state).toBe(
        "recovery-required",
      );
      expect(await fs.readdir(snapshotRoot)).toContain(snapshot.sourceBlob.id);
      if (phase === "replacement")
        expect(await fs.readFile(temporary, "utf8")).toBe("replacement");
      else expect(cleanupAttempted).toBeTrue();
      await expect(output!.stat()).rejects.toMatchObject({ code: "EBADF" });
    } finally {
      open.mockRestore();
      unlink.mockRestore();
    }
  },
);

test("successful blob recovery restores bytes and metadata then releases material", async () => {
  const { root, workspace, lifecycle, snapshotRoot } = await fixture();
  const target = path.join(root, "checkpoint.bin");
  await fs.writeFile(target, Buffer.alloc(4 * 1024 * 1024, 0xff), {
    mode: 0o640,
  });
  const snapshot = await withWorkspaceContext(workspace, () =>
    stageFileSnapshot(target),
  );
  const operationId = `job:v1:${sha256("recover binary")}`;
  await lifecycle.journal.begin({
    operationId,
    workspace,
    tool: "file_delete",
    files: [sourcePlan(target, snapshot)],
  });
  await fs.unlink(target);
  await lifecycle.journal.transition(operationId, "recovery-required");
  await lifecycle.recover();
  expect(await sha256File(target)).toBe(snapshot.sha256);
  expect((await fs.stat(target)).mode & 0o777).toBe(snapshot.mode & 0o777);
  expect((await lifecycle.journal.get(operationId))?.state).toBe("recovered");
  expect(await fs.readdir(snapshotRoot)).toEqual([]);
});

test("failed commit and rollback retain null-commit recovery material", async () => {
  const { root, workspace, lifecycle, snapshotRoot } = await fixture();
  const target = path.join(root, "checkpoint.bin");
  const bytes = Buffer.alloc(4 * 1024 * 1024, 0x73);
  await fs.writeFile(target, bytes, { mode: 0o640 });
  const original = await fs.stat(target);
  const committed = spyOn(lifecycle.journal, "committed").mockRejectedValue(
    new Error("commit journal unavailable"),
  );
  const actualOpen = fs.open;
  let rollbackAttempted = false;
  const open = spyOn(fs, "open").mockImplementation((async (
    ...args: Parameters<typeof fs.open>
  ) => {
    if (String(args[0]).includes(".rollback-") && args[1] === "wx") {
      rollbackAttempted = true;
      throw new Error("rollback copy unavailable");
    }
    return actualOpen(...args);
  }) as typeof fs.open);
  try {
    await expect(
      withWorkspaceContext(workspace, () =>
        withMutationLifecycle(lifecycle, () =>
          deleteFilesSafely({ [target]: { expectedSha256: sha256(bytes) } }),
        ),
      ),
    ).rejects.toThrow("rollback requires recovery");
  } finally {
    committed.mockRestore();
    open.mockRestore();
  }
  expect(rollbackAttempted).toBeTrue();
  expect(await Bun.file(target).exists()).toBeFalse();
  const records = await lifecycle.journal.unfinished(workspace.workspaceId);
  expect(records).toHaveLength(1);
  const record = records[0]!;
  expect(record.state).toBe("recovery-required");
  expect(record.files[0]?.committedSha256).toBeNull();
  expect(await fs.readdir(snapshotRoot)).toContain(
    record.files[0]!.sourceBlob!.id,
  );
  await lifecycle.recover();
  expect(await sha256File(target)).toBe(sha256(bytes));
  const restored = await fs.stat(target);
  if (process.platform !== "win32") {
    expect(restored.mode & 0o777).toBe(original.mode & 0o777);
    expect(restored.uid).toBe(original.uid);
    expect(restored.gid).toBe(original.gid);
  }
  expect((await lifecycle.journal.get(record.operationId))?.state).toBe(
    "recovered",
  );
  expect(await fs.readdir(snapshotRoot)).toEqual([]);
  await expect(
    lifecycle.committed(record.operationId, {
      filePath: target,
      sha256: sha256(bytes),
      deleted: true,
    }),
  ).rejects.toThrow("mutation_operation_unknown");
});

test.each([
  "temporary",
  "directory",
  "existing",
  "deleted",
  "ordering",
] as const)(
  "recovery persists bytes, metadata, and directory entries: %s",
  async (phase) => {
    if (
      process.platform === "win32" &&
      phase !== "temporary" &&
      phase !== "existing"
    )
      return;
    const { root, workspace, lifecycle, snapshotRoot } = await fixture();
    const target = path.join(root, "durable.bin");
    const created = path.join(root, "created.bin");
    await fs.writeFile(target, "durable original", { mode: 0o640 });
    const snapshot = await withWorkspaceContext(workspace, () =>
      stageFileSnapshot(target),
    );
    const operationId = `job:v1:${sha256("sync " + phase)}`;
    const files: MutationFilePlan[] = [sourcePlan(target, snapshot)];
    if (phase === "deleted") {
      await fs.writeFile(created, "candidate");
      files.push({
        filePath: created,
        sourceSha256: null,
        sourceContentBase64: null,
        candidateSha256: sha256("candidate"),
      });
    } else if (phase !== "existing") await fs.unlink(target);
    await lifecycle.journal.begin({
      operationId,
      workspace,
      tool: "file_delete",
      files,
    });
    await lifecycle.journal.transition(operationId, "recovery-required");
    const events: string[] = [];
    const actualOpen = fs.open,
      actualLink = fs.link;
    const actualTransition = lifecycle.journal.transition.bind(
      lifecycle.journal,
    );
    let injected = false;
    const open = spyOn(fs, "open").mockImplementation((async (
      ...args: Parameters<typeof fs.open>
    ) => {
      const handle = await actualOpen(...args);
      const opened = String(args[0]);
      if (
        opened === root ||
        opened === target ||
        opened.includes(".recovery-")
      ) {
        const sync = handle.sync.bind(handle);
        spyOn(handle, "sync").mockImplementation(async () => {
          const metadata = await handle.stat();
          const temporaryMetadata =
            opened.includes(".recovery-") &&
            args[1] !== "wx" &&
            (metadata.mode & 0o777) === (snapshot.mode & 0o777);
          if (temporaryMetadata) events.push("metadata-sync");
          if (opened === root) events.push("directory-sync");
          if (
            !injected &&
            ((phase === "temporary" && temporaryMetadata) ||
              (phase === "existing" && opened === target) ||
              ((phase === "directory" || phase === "deleted") &&
                opened === root))
          ) {
            injected = true;
            throw new Error("injected sync failure");
          }
          await sync();
        });
      }
      return handle;
    }) as typeof fs.open);
    const link = spyOn(fs, "link").mockImplementation((async (
      ...args: Parameters<typeof fs.link>
    ) => {
      if (String(args[0]).includes(".recovery-")) events.push("publish");
      return actualLink(...args);
    }) as typeof fs.link);
    const transition = spyOn(
      lifecycle.journal,
      "transition",
    ).mockImplementation(async (...args) => {
      if (args[1] === "recovered") events.push("recovered");
      return actualTransition(...args);
    });
    try {
      if (phase === "ordering") await lifecycle.recover();
      else
        await expect(lifecycle.recover()).rejects.toThrow(
          "mutation_recovery_required",
        );
    } finally {
      open.mockRestore();
      link.mockRestore();
      transition.mockRestore();
    }
    if (phase === "ordering") {
      expect(events.indexOf("metadata-sync")).toBeLessThan(
        events.indexOf("publish"),
      );
      expect(events.indexOf("publish")).toBeLessThan(
        events.indexOf("directory-sync"),
      );
      expect(events.indexOf("directory-sync")).toBeLessThan(
        events.indexOf("recovered"),
      );
    } else {
      expect(injected).toBeTrue();
      expect((await lifecycle.journal.get(operationId))?.state).toBe(
        "recovery-required",
      );
      expect(await fs.readdir(snapshotRoot)).toContain(snapshot.sourceBlob.id);
      await lifecycle.recover();
    }
    expect(await fs.readFile(target, "utf8")).toBe("durable original");
    expect((await fs.stat(target)).mode & 0o777).toBe(snapshot.mode & 0o777);
    expect(await Bun.file(created).exists()).toBeFalse();
    expect((await lifecycle.journal.get(operationId))?.state).toBe("recovered");
    expect(await fs.readdir(snapshotRoot)).toEqual([]);
  },
);

test.each(["delete", "rename"] as const)(
  "selected workspace completes authorized external binary %s",
  async (operation) => {
    const { workspace, lifecycle, snapshotRoot } = await fixture();
    const external = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "ast-mcp-external-blob-")),
    );
    cleanup.push(() => fs.rm(external, { recursive: true, force: true }));
    process.env.AST_MCP_ROOTS = external;
    await fs.writeFile(
      path.join(external, "ast-mcp.toml"),
      `version = 2\n[[paths]]\nid = "external"\npath = ${JSON.stringify(external)}\n[paths.policies]\nread = "allow"\nwrite = "allow"\ndelete = "allow"\n`,
    );
    const target = path.join(external, "source.bin");
    const destination = path.join(external, "new", "nested", "renamed.bin");
    await fs.writeFile(target, "external bytes");
    const directories: string[] = [];
    const actualSync = snapshotStorage.syncDirectory;
    const sync = spyOn(snapshotStorage, "syncDirectory").mockImplementation(
      async (directory) => {
        if (directory === path.dirname(external))
          throw Object.assign(new Error("execute-only unchanged ancestor"), {
            code: "EACCES",
          });
        if (directory === external || directory.startsWith(external + path.sep))
          directories.push(directory);
        await actualSync(directory);
      },
    );
    try {
      await withConfig({ cwd: external }, () =>
        withWorkspaceContext(workspace, () =>
          withMutationLifecycle(lifecycle, () =>
            operation === "delete"
              ? deleteFilesSafely({
                  [target]: { expectedSha256: sha256("external bytes") },
                })
              : renameFilesSafely({
                  [target]: {
                    destination,
                    expectedSha256: sha256("external bytes"),
                  },
                }),
          ),
        ),
      );
      expect(await Bun.file(target).exists()).toBeFalse();
      if (operation === "rename")
        expect(await fs.readFile(destination, "utf8")).toBe("external bytes");
      expect(directories).toEqual(
        operation === "rename"
          ? [path.dirname(destination), path.join(external, "new"), external]
          : [external],
      );
      expect(await lifecycle.journal.unfinished(workspace.workspaceId)).toEqual(
        [],
      );
      expect(await fs.readdir(snapshotRoot)).toEqual([]);
    } finally {
      sync.mockRestore();
    }
  },
);

test("directory durability ledger survives a failed terminal sync and releases after rollback", async () => {
  const { root, workspace, lifecycle } = await fixture();
  const target = path.join(root, "original.bin");
  const destination = path.join(root, "new", "nested", "candidate.bin");
  await fs.writeFile(target, "original");
  const snapshot = await withWorkspaceContext(workspace, () =>
    stageFileSnapshot(target),
  );
  const operationId = `job:v1:${sha256("parent ledger rollback")}`;
  await lifecycle.begin({
    operationId,
    workspace,
    tool: "file_rename",
    files: [
      sourcePlan(target, snapshot),
      {
        filePath: destination,
        sourceSha256: null,
        candidateSha256: snapshot.sha256,
      },
    ],
  });
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const directories: string[] = [];
  const actualSync = snapshotStorage.syncDirectory;
  let fails = true;
  const sync = spyOn(snapshotStorage, "syncDirectory").mockImplementation(
    async (directory) => {
      directories.push(directory);
      if (fails && directory === path.join(root, "new"))
        throw new Error("parent durability failed");
      await actualSync(directory);
    },
  );
  try {
    await expect(lifecycle.complete(operationId, [])).rejects.toThrow(
      "parent durability failed",
    );
    expect((await lifecycle.journal.get(operationId))?.state).toBe(
      "recovery-required",
    );
    await fs.rmdir(path.dirname(destination));
    await fs.rmdir(path.join(root, "new"));
    fails = false;
    directories.length = 0;
    await lifecycle.rolledBack(operationId);
    expect(directories).toEqual([
      path.dirname(destination),
      path.join(root, "new"),
      root,
    ]);
    expect((await lifecycle.journal.get(operationId))?.state).toBe(
      "rolled-back",
    );
    directories.length = 0;
    await lifecycle.rolledBack(operationId);
    expect(directories).toEqual([]);
    await expect(lifecycle.complete(operationId, [])).rejects.toThrow(
      "mutation_operation_unknown",
    );
    expect(await fs.readFile(target, "utf8")).toBe("original");
  } finally {
    sync.mockRestore();
  }
});

test.each(["permission", "abort", "journal"] as const)(
  "parent ledger collection fails before mutation and releases staging: %s",
  async (phase) => {
    const {
      root,
      workspace,
      store,
      lifecycle: ordinary,
      snapshotRoot,
    } = await fixture();
    const target = path.join(root, "source.bin");
    const destination = path.join(root, "new", "nested", "candidate.bin");
    await fs.writeFile(target, "original");
    const abort = new AbortController();
    const lifecycle =
      phase === "abort"
        ? new LanceMutationLifecycle(store, workspace, undefined, {
            signal: abort.signal,
          })
        : ordinary;
    const actualBegin = lifecycle.begin.bind(lifecycle),
      actualStat = fs.lstat;
    let collecting = false;
    const begin = spyOn(lifecycle, "begin").mockImplementation(async (plan) => {
      collecting = true;
      return actualBegin(plan);
    });
    const stat = spyOn(fs, "lstat").mockImplementation((async (
      ...args: Parameters<typeof fs.lstat>
    ) => {
      if (collecting && String(args[0]) === path.dirname(destination)) {
        if (phase === "permission")
          throw Object.assign(new Error("parent denied"), { code: "EACCES" });
        if (phase === "abort")
          abort.abort(new Error("parent collection aborted"));
      }
      return actualStat(...args);
    }) as typeof fs.lstat);
    const journal =
      phase === "journal"
        ? spyOn(lifecycle.journal, "begin").mockRejectedValue(
            new Error("journal failed"),
          )
        : null;
    try {
      await expect(
        withWorkspaceContext(workspace, () =>
          withMutationLifecycle(lifecycle, () =>
            withConfig({ cwd: root }, () =>
              renameFilesSafely(
                {
                  [target]: { destination, expectedSha256: sha256("original") },
                },
                abort.signal,
              ),
            ),
          ),
        ),
      ).rejects.toThrow(
        phase === "permission"
          ? "parent denied"
          : phase === "abort"
            ? "parent collection aborted"
            : "journal failed",
      );
      expect(await fs.readFile(target, "utf8")).toBe("original");
      expect(await Bun.file(destination).exists()).toBeFalse();
      expect(
        await fs.lstat(path.join(root, "new")).catch(() => null),
      ).toBeNull();
      expect(await lifecycle.journal.unfinished(workspace.workspaceId)).toEqual(
        [],
      );
      // An uncertain begin retains captures until journal reconciliation.
      await ordinary.recover();
      expect(await fs.readdir(snapshotRoot)).toEqual([]);
    } finally {
      begin.mockRestore();
      stat.mockRestore();
      journal?.mockRestore();
    }
  },
);

test.each(["success", "fence", "mkdir"] as const)(
  "registered all-new nested writes sync changed parents without blobs: %s",
  async (phase) => {
    const { root, workspace, store } = await fixture();
    const target = path.join(root, "new", "nested", "created.txt");
    let failFence = false;
    const lifecycle = new LanceMutationLifecycle(
      store,
      workspace,
      async () => ({
        dirtyOverlayId: null,
        generationId: null,
        indexedAt: new Date().toISOString(),
        parsedFiles: [],
        skippedFiles: [],
      }),
      {
        fence: async () => {
          if (failFence) {
            failFence = false;
            throw new Error("terminal parent fence failed");
          }
        },
      },
    );
    let handler!: (
      input: Record<string, unknown>,
    ) => Promise<{ isError?: boolean }>;
    registerFileTools(
      {
        registerTool(
          name: string,
          _definition: unknown,
          callback: typeof handler,
        ) {
          if (name === "file_write") handler = callback;
        },
      } as never,
      async (_args, operation) => withConfig({ cwd: root }, () => operation()),
    );
    const actualBegin = lifecycle.journal.begin.bind(lifecycle.journal);
    let began = false;
    const begin = spyOn(lifecycle.journal, "begin").mockImplementation(
      async (plan) => {
        expect(
          plan.files.every(
            (file) => !file.sourceBlob && file.sourceSha256 === null,
          ),
        ).toBeTrue();
        expect(
          await fs.lstat(path.join(root, "new")).catch(() => null),
        ).toBeNull();
        const record = await actualBegin(plan);
        began = true;
        return record;
      },
    );
    const actualSync = snapshotStorage.syncDirectory,
      actualMkdir = fs.mkdir;
    const directories: string[] = [];
    let injected = false;
    const sync = spyOn(snapshotStorage, "syncDirectory").mockImplementation(
      async (directory) => {
        if (directory === path.dirname(root))
          throw Object.assign(new Error("unchanged ancestor denied"), {
            code: "EACCES",
          });
        directories.push(directory);
        await actualSync(directory);
        if (phase === "fence" && !injected) {
          injected = true;
          failFence = true;
        }
      },
    );
    const mkdir = spyOn(fs, "mkdir").mockImplementation((async (
      ...args: Parameters<typeof fs.mkdir>
    ) => {
      if (
        phase === "mkdir" &&
        began &&
        String(args[0]) === path.dirname(target)
      ) {
        injected = true;
        throw new Error("parent creation failed");
      }
      return actualMkdir(...args);
    }) as typeof fs.mkdir);
    try {
      const result = await withWorkspaceContext(workspace, () =>
        withMutationLifecycle(lifecycle, () =>
          handler({ files: { [target]: { content: "new durable output" } } }),
        ),
      );
      expect(Boolean(result.isError)).toBe(phase !== "success");
      expect(began).toBeTrue();
      if (phase === "success") {
        expect(await fs.readFile(target, "utf8")).toBe("new durable output");
        expect(directories).toEqual([
          path.dirname(target),
          path.join(root, "new"),
          root,
        ]);
      } else {
        expect(injected).toBeTrue();
        expect(await Bun.file(target).exists()).toBeFalse();
        expect(
          await fs.lstat(path.join(root, "new")).catch(() => null),
        ).toBeNull();
        expect(directories.slice(-3)).toEqual([
          path.dirname(target),
          path.join(root, "new"),
          root,
        ]);
      }
      const rows = await store.rows("jobs");
      const record = rows
        .map((row) => JSON.parse(String(row.payload_json)))
        .find((row) => row.tool === "file_write");
      expect(record.files[0].sourceBlob).toBeNull();
      expect(record.state).toBe(
        phase === "success" ? "succeeded" : "rolled-back",
      );
      expect(await lifecycle.journal.unfinished(workspace.workspaceId)).toEqual(
        [],
      );
    } finally {
      begin.mockRestore();
      sync.mockRestore();
      mkdir.mockRestore();
    }
  },
);

function chattrHandler(root: string) {
  let handler: (
    input: Record<string, unknown>,
  ) => Promise<{ isError?: boolean }>;
  registerLifecycleTools(
    {
      registerTool(
        name: string,
        _definition: unknown,
        callback: typeof handler,
      ) {
        if (name === "file_chattr") handler = callback;
      },
    } as never,
    async (_args, operation) => withConfig({ cwd: root }, () => operation()),
  );
  return (input: Record<string, unknown>) => handler(input);
}

test.each([
  [0o444, false],
  [0o444, true],
  [0o644, false],
  [0o644, true],
] as const)(
  "durable chattr preserves readonly transitions and batch rollback: mode=%s failure=%s",
  async (initial, fails) => {
    const { root, workspace, lifecycle, snapshotRoot } = await fixture();
    const target = path.join(root, "readonly.bin");
    await fs.writeFile(target, "original");
    await fs.chmod(target, initial);
    const original = (await fs.stat(target)).mode & 0o777;
    const desired = initial === 0o444 ? 0o644 : 0o444;
    const second = path.join(root, "inverse.bin");
    await fs.writeFile(second, "inverse");
    await fs.chmod(second, desired);
    const secondOriginal = (await fs.stat(second)).mode & 0o777;
    const complete = fails
      ? spyOn(lifecycle, "complete").mockRejectedValue(
          new Error("refresh failed"),
        )
      : null;
    try {
      const result = await withWorkspaceContext(workspace, () =>
        withMutationLifecycle(lifecycle, () =>
          chattrHandler(root)({
            files: {
              [target]: {
                expectedSha256: sha256("original"),
                chattr: { chmod: desired },
              },
              [second]: {
                expectedSha256: sha256("inverse"),
                chattr: { chmod: initial },
              },
            },
          }),
        ),
      );
      expect(Boolean(result.isError)).toBe(fails);
      expect(((await fs.stat(target)).mode & 0o200) !== 0).toBe(
        ((fails ? original : desired) & 0o200) !== 0,
      );
      expect(((await fs.stat(second)).mode & 0o200) !== 0).toBe(
        ((fails ? secondOriginal : initial) & 0o200) !== 0,
      );
      expect(await fs.readFile(second, "utf8")).toBe("inverse");
      expect(await fs.readFile(target, "utf8")).toBe("original");
      expect(await lifecycle.journal.unfinished(workspace.workspaceId)).toEqual(
        [],
      );
      expect(await fs.readdir(snapshotRoot)).toEqual([]);
    } finally {
      complete?.mockRestore();
      await fs.chmod(target, 0o644);
      await fs.chmod(second, 0o644);
    }
  },
);

test.each([false, true])(
  "binary chattr keeps compact material and mode-zero descriptors, refresh failure=%s",
  async (fails) => {
    if (process.platform === "win32") return;
    const { root, workspace, store, lifecycle, snapshotRoot } = await fixture();
    const target = path.join(root, "attributes.bin");
    const bytes = Buffer.alloc(8 * 1024 * 1024, 0xab);
    await fs.writeFile(target, bytes, { mode: 0o640 });
    const handler = chattrHandler(root);
    const actualOpen = fs.open;
    let forbiddenReopens = 0;
    const open = spyOn(fs, "open").mockImplementation((async (
      ...args: Parameters<typeof fs.open>
    ) => {
      if (
        String(args[0]) === target &&
        ((await fs.stat(target)).mode & 0o777) === 0
      ) {
        forbiddenReopens++;
        throw Object.assign(new Error("mode zero cannot reopen"), {
          code: "EACCES",
        });
      }
      const handle = await actualOpen(...args);
      if (String(args[0]) === target)
        spyOn(handle, "readFile").mockRejectedValue(
          new Error("unbounded read forbidden"),
        );
      return handle;
    }) as typeof fs.open);
    const complete = fails
      ? spyOn(lifecycle, "complete").mockRejectedValue(
          new Error("refresh failed"),
        )
      : null;
    try {
      const result = await withWorkspaceContext(workspace, () =>
        withMutationLifecycle(lifecycle, () =>
          handler({
            files: {
              [target]: { expectedSha256: sha256(bytes), chattr: { chmod: 0 } },
            },
          }),
        ),
      );
      expect(Boolean(result.isError)).toBe(fails);
      expect((await fs.stat(target)).mode & 0o777).toBe(fails ? 0o640 : 0);
      expect(forbiddenReopens).toBe(0);
      const rows = await store.rows("jobs");
      const record = rows
        .map((row) => JSON.parse(String(row.payload_json)))
        .find((row) => row.tool === "file_chattr");
      expect(record.state).toBe(fails ? "rolled-back" : "succeeded");
      expect(record.files[0].sourceContentBase64).toBeNull();
      expect(record.files[0].sourceBlob.size).toBe(bytes.length);
      expect(JSON.stringify(record).length).toBeLessThan(4096);
      expect(await fs.readdir(snapshotRoot)).toEqual([]);
    } finally {
      open.mockRestore();
      complete?.mockRestore();
      await fs.chmod(target, 0o640);
    }
  },
);

test.each(["write", "patch"] as const)(
  "text %s journals compact source material",
  async (operation) => {
    const { root, workspace, store, lifecycle, snapshotRoot } = await fixture();
    const target = path.join(root, "source.txt");
    await fs.writeFile(target, "original text\n");
    await withWorkspaceContext(workspace, () =>
      withMutationLifecycle(lifecycle, () =>
        withConfig({ cwd: root }, () =>
          operation === "write"
            ? writeFilesSafely({
                [target]: {
                  content: "changed text\n",
                  expectedSha256: sha256("original text\n"),
                },
              })
            : patchFiles({
                [target]: {
                  patchStrategy: "aider_block",
                  aiderBlocks: [
                    { search: "original text", replace: "changed text" },
                  ],
                  expectedSha256: sha256("original text\n"),
                },
              }),
        ),
      ),
    );
    expect(await fs.readFile(target, "utf8")).toBe("changed text\n");
    const rows = await store.rows("jobs");
    const record = rows
      .map((row) => JSON.parse(String(row.payload_json)))
      .find(
        (row) =>
          row.tool === (operation === "write" ? "file_write" : "file_patch"),
      );
    expect(record.files[0].sourceContentBase64).toBeNull();
    expect(record.files[0].sourceBlob.size).toBe(
      Buffer.byteLength("original text\n"),
    );
    expect(record.state).toBe("succeeded");
    expect(await fs.readdir(snapshotRoot)).toEqual([]);
  },
);

test.each(["chattr", "write", "patch"] as const)(
  "post-begin %s blob validation precedes every target mutation",
  async (operation) => {
    const { root, workspace, lifecycle, snapshotRoot } = await fixture();
    const target = path.join(root, "source.txt");
    await fs.writeFile(target, "original text\n", { mode: 0o640 });
    const originalBegin = lifecycle.begin.bind(lifecycle);
    const begin = spyOn(lifecycle, "begin").mockImplementation(async (plan) => {
      await originalBegin(plan);
      const blob = plan.files[0]!.sourceBlob!;
      await fs.writeFile(
        path.join(snapshotRoot, blob.id, `${blob.sha256}.blob`),
        Buffer.alloc(blob.size, 0xff),
      );
    });
    try {
      const invoke = () =>
        withWorkspaceContext(workspace, () =>
          withMutationLifecycle(lifecycle, () =>
            withConfig({ cwd: root }, () =>
              operation === "chattr"
                ? chattrHandler(root)({
                    files: {
                      [target]: {
                        chattr: { chmod: 0o600 },
                        expectedSha256: sha256("original text\n"),
                      },
                    },
                  })
                : operation === "write"
                  ? writeFilesSafely({
                      [target]: {
                        content: "changed",
                        expectedSha256: sha256("original text\n"),
                      },
                    })
                  : patchFiles({
                      [target]: {
                        patchStrategy: "aider_block",
                        aiderBlocks: [
                          { search: "original", replace: "changed" },
                        ],
                        expectedSha256: sha256("original text\n"),
                      },
                    }),
            ),
          ),
        );
      if (operation === "chattr") expect((await invoke()).isError).toBeTrue();
      else
        await expect(invoke()).rejects.toThrow(
          "mutation_recovery_material_mismatch",
        );
      expect(await fs.readFile(target, "utf8")).toBe("original text\n");
      if (process.platform !== "win32")
        expect((await fs.stat(target)).mode & 0o777).toBe(0o640);
      expect(await lifecycle.journal.unfinished(workspace.workspaceId)).toEqual(
        [],
      );
      expect(await fs.readdir(snapshotRoot)).toEqual([]);
    } finally {
      begin.mockRestore();
    }
  },
);

test.each(["absent", "original", "candidate"] as const)(
  "recovery retains descriptors while restoring mode zero from %s target",
  async (current) => {
    if (process.platform === "win32") return;
    const { root, workspace, lifecycle, snapshotRoot } = await fixture();
    const target = path.join(root, "mode-zero.bin");
    await fs.writeFile(target, "original", { mode: 0o640 });
    const snapshot = await withWorkspaceContext(workspace, () =>
      stageFileSnapshot(target),
    );
    const operationId = `job:v1:${sha256("zero " + current)}`;
    await lifecycle.journal.begin({
      operationId,
      workspace,
      tool: "file_chattr",
      files: [
        { ...sourcePlan(target, snapshot, sha256("candidate")), sourceMode: 0 },
      ],
    });
    await lifecycle.journal.transition(operationId, "recovery-required");
    if (current === "absent") await fs.unlink(target);
    else if (current === "candidate") await fs.writeFile(target, "candidate");
    const actualOpen = fs.open;
    let rejectedReopens = 0;
    const open = spyOn(fs, "open").mockImplementation((async (
      ...args: Parameters<typeof fs.open>
    ) => {
      const name = String(args[0]);
      const metadata = await fs.lstat(name).catch(() => null);
      if (metadata?.isFile() && (metadata.mode & 0o777) === 0) {
        rejectedReopens++;
        throw Object.assign(new Error("unreadable file"), { code: "EACCES" });
      }
      return actualOpen(...args);
    }) as typeof fs.open);
    try {
      await lifecycle.recover();
      expect(rejectedReopens).toBe(0);
      expect((await fs.stat(target)).mode & 0o777).toBe(0);
      expect((await lifecycle.journal.get(operationId))?.state).toBe(
        "recovered",
      );
      expect(await fs.readdir(snapshotRoot)).toEqual([]);
    } finally {
      open.mockRestore();
      await fs.chmod(target, 0o640).catch(() => undefined);
    }
    expect(await fs.readFile(target, "utf8")).toBe("original");
  },
);

test.each([
  "clean",
  "clean-null",
  "upgrade",
  "inverse",
  "open",
  "sync",
  "race",
  "same-byte-race",
  "unflushable",
] as const)(
  "Windows recovery keeps readonly originals and flushes every mutation: %s",
  async (phase) => {
    const { root, workspace, lifecycle, snapshotRoot } = await fixture();
    const target = path.join(root, "readonly-recovery.bin");
    const initial = phase === "inverse" ? 0o644 : 0o444;
    const desired =
      phase === "clean"
        ? 0o444
        : phase === "clean-null"
          ? null
          : phase === "inverse"
            ? 0o444
            : phase === "unflushable"
              ? 0o400
              : 0o644;
    await fs.writeFile(target, "original");
    let sourceMode = desired;
    if (desired !== null && phase !== "unflushable") {
      await fs.chmod(target, desired);
      sourceMode = (await fs.stat(target)).mode & 0o7777;
    }
    await fs.chmod(target, initial);
    const snapshot = await withWorkspaceContext(workspace, () =>
      stageFileSnapshot(target),
    );
    const operationId = `job:v1:${sha256("readonly recovery " + phase)}`;
    await lifecycle.journal.begin({
      operationId,
      workspace,
      tool: "file_chattr",
      files: [
        {
          ...sourcePlan(target, snapshot),
          sourceMode,
          sourceUid: null,
          sourceGid: null,
        },
      ],
    });
    await lifecycle.journal.transition(operationId, "recovery-required");
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    const actualOpen = fs.open;
    const handles: Array<Awaited<ReturnType<typeof fs.open>>> = [];
    let writeOpens = 0,
      flushes = 0,
      readonlyFlushes = 0;
    Object.defineProperty(process, "platform", { value: "win32" });
    const open = spyOn(fs, "open").mockImplementation((async (
      ...args: Parameters<typeof fs.open>
    ) => {
      const isTarget = String(args[0]) === target;
      const writable =
        isTarget &&
        typeof args[1] === "number" &&
        (args[1] & constants.O_RDWR) !== 0;
      if (writable) {
        writeOpens++;
        if (phase === "open") throw new Error("recovery writable open denied");
        if (((await fs.stat(target)).mode & 0o200) === 0)
          throw Object.assign(new Error("Windows readonly open denied"), {
            code: "EACCES",
          });
      }
      const openArgs = [...args] as Parameters<typeof fs.open>;
      if (writable && phase === "same-byte-race") {
        openArgs[0] = target + ".replacement";
        await fs.writeFile(openArgs[0], "original");
        await fs.chmod(openArgs[0], sourceMode!);
      }
      const handle = await actualOpen(...openArgs);
      if (isTarget) {
        handles.push(handle);
        const sync = handle.sync.bind(handle);
        spyOn(handle, "sync").mockImplementation(async () => {
          if (!writable) {
            readonlyFlushes++;
            throw new Error("readonly FlushFileBuffers denied");
          }
          flushes++;
          if (phase === "sync") throw new Error("recovery flush failed");
          await sync();
        });
        if (writable && phase === "same-byte-race") {
          const stat = handle.stat.bind(handle);
          let swapped = false;
          spyOn(handle, "stat").mockImplementation((async () => {
            if (!swapped) {
              swapped = true;
              await fs.rename(target, target + ".owned");
              await fs.rename(target + ".replacement", target);
            }
            return stat();
          }) as typeof handle.stat);
        }
        if (writable && phase === "race") {
          await fs.rename(target, target + ".owned");
          await fs.writeFile(target, "external replacement");
        }
      }
      return handle;
    }) as typeof fs.open);
    const fails = [
      "open",
      "sync",
      "race",
      "same-byte-race",
      "unflushable",
    ].includes(phase);
    try {
      if (fails)
        await expect(lifecycle.recover()).rejects.toThrow(
          "mutation_recovery_required",
        );
      else await lifecycle.recover();
      expect(readonlyFlushes).toBe(0);
      if (phase === "same-byte-race") {
        expect((await fs.stat(target)).ino).not.toBe(snapshot.ino);
        expect((await fs.stat(target)).mode & 0o7777).toBe(sourceMode!);
      }
      expect(await fs.readFile(target, "utf8")).toBe(
        phase === "race" ? "external replacement" : "original",
      );
      expect((await lifecycle.journal.get(operationId))?.state).toBe(
        fails ? "recovery-required" : "recovered",
      );
      if (
        phase === "clean" ||
        phase === "clean-null" ||
        phase === "unflushable"
      )
        expect(writeOpens).toBe(0);
      else expect(writeOpens).toBe(1);
      if (!fails && phase !== "clean" && phase !== "clean-null")
        expect(flushes).toBeGreaterThan(0);
      if (fails)
        expect(await fs.readdir(snapshotRoot)).toContain(
          snapshot.sourceBlob.id,
        );
      else expect(await fs.readdir(snapshotRoot)).toEqual([]);
      for (const handle of handles)
        await expect(handle.stat()).rejects.toMatchObject({ code: "EBADF" });
    } finally {
      Object.defineProperty(process, "platform", platform);
      open.mockRestore();
      await fs.chmod(target, 0o644).catch(() => undefined);
      await fs.chmod(target + ".owned", 0o644).catch(() => undefined);
    }
  },
);

test.each(["success", "rollback", "wrong-digest", "replacement"] as const)(
  "Windows readonly rename preserves namespace-only durability: %s",
  async (phase) => {
    const { root, workspace, store, snapshotRoot } = await fixture();
    const sources = [
      path.join(root, "readonly.bin"),
      path.join(root, "writable.bin"),
    ];
    const destinations = [
      path.join(root, "new", "nested", "readonly.bin"),
      path.join(root, "new", "nested", "writable.bin"),
    ];
    await fs.writeFile(sources[0]!, "identical bytes");
    await fs.writeFile(sources[1]!, "identical bytes");
    await fs.chmod(sources[0]!, 0o444);
    await fs.chmod(sources[1]!, 0o644);
    const original = await Promise.all(
      sources.map((source) => fs.stat(source)),
    );
    const lifecycle = new LanceMutationLifecycle(store, workspace, async () => {
      if (phase === "rollback") throw new Error("refresh failed");
      if (phase === "wrong-digest") {
        await fs.chmod(destinations[0]!, 0o644);
        await fs.writeFile(destinations[0]!, "external bytes");
        await fs.chmod(destinations[0]!, original[0]!.mode & 0o777);
      }
      return {
        dirtyOverlayId: null,
        generationId: null,
        indexedAt: new Date().toISOString(),
        parsedFiles: [],
        skippedFiles: [],
      };
    });
    let handler!: (
      input: Record<string, unknown>,
    ) => Promise<{ isError?: boolean }>;
    registerLifecycleTools(
      {
        registerTool(
          name: string,
          _definition: unknown,
          callback: typeof handler,
        ) {
          if (name === "file_rename") handler = callback;
        },
      } as never,
      async (_args, operation) => withConfig({ cwd: root }, () => operation()),
    );
    const actualOpen = fs.open;
    const handles: Array<Awaited<ReturnType<typeof fs.open>>> = [];
    let readonlyAttempts = 0,
      readonlySyncs = 0,
      writableSyncs = 0,
      replaced = false;
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32" });
    const open = spyOn(fs, "open").mockImplementation((async (
      ...args: Parameters<typeof fs.open>
    ) => {
      const name = String(args[0]),
        target = [...sources, ...destinations].includes(name);
      const writable =
        typeof args[1] === "number" && (args[1] & constants.O_RDWR) !== 0;
      const metadata = target ? await fs.lstat(name).catch(() => null) : null;
      const readonly = metadata && (metadata.mode & 0o200) === 0;
      if (target && writable && readonly) {
        readonlyAttempts++;
        throw Object.assign(new Error("Windows readonly descriptor denied"), {
          code: "EPERM",
        });
      }
      const handle = await actualOpen(...args);
      if (target) {
        handles.push(handle);
        const sync = handle.sync.bind(handle);
        spyOn(handle, "sync").mockImplementation(async () => {
          if (!writable) {
            readonlySyncs++;
            throw new Error("readonly descriptor cannot flush");
          }
          writableSyncs++;
          await sync();
        });
        if (
          phase === "replacement" &&
          name === destinations[0] &&
          !writable &&
          !replaced
        ) {
          replaced = true;
          await fs.rename(name, name + ".owned");
          await fs.writeFile(name, "external bytes");
          await fs.chmod(name, original[0]!.mode & 0o777);
        }
      }
      return handle;
    }) as typeof fs.open);
    try {
      const result = await withWorkspaceContext(workspace, () =>
        withMutationLifecycle(lifecycle, () =>
          handler({
            files: Object.fromEntries(
              sources.map((source, index) => [
                source,
                {
                  destination: destinations[index],
                  expectedSha256: sha256("identical bytes"),
                },
              ]),
            ),
          }),
        ),
      );
      expect(Boolean(result.isError)).toBe(phase !== "success");
      expect(readonlyAttempts).toBeGreaterThan(0);
      expect(readonlySyncs).toBe(0);
      const rows = await store.rows("jobs");
      const record = rows
        .map((row) => JSON.parse(String(row.payload_json)))
        .find((row) => row.tool === "file_rename");
      if (phase === "success" || phase === "rollback") {
        const outputs = phase === "success" ? destinations : sources;
        for (let index = 0; index < outputs.length; index++) {
          const metadata = await fs.stat(outputs[index]!);
          expect(metadata.ino).toBe(original[index]!.ino);
          expect(metadata.mode & 0o777).toBe(original[index]!.mode & 0o777);
          expect(await fs.readFile(outputs[index]!, "utf8")).toBe(
            "identical bytes",
          );
        }
        expect(writableSyncs).toBeGreaterThan(0);
        expect(record.state).toBe(
          phase === "success" ? "succeeded" : "rolled-back",
        );
        expect(await fs.readdir(snapshotRoot)).toEqual([]);
      } else {
        expect(await fs.readFile(destinations[0]!, "utf8")).toBe(
          "external bytes",
        );
        expect(record.state).toBe("recovery-required");
        expect((await fs.readdir(snapshotRoot)).length).toBeGreaterThan(0);
      }
      for (const handle of handles)
        await expect(handle.stat()).rejects.toMatchObject({ code: "EBADF" });
    } finally {
      Object.defineProperty(process, "platform", platform);
      open.mockRestore();
      for (const file of [
        ...sources,
        ...destinations,
        destinations[0] + ".owned",
      ])
        await fs.chmod(file, 0o644).catch(() => undefined);
    }
  },
);

test("recovery preserves an inaccessible existing target and its recovery material", async () => {
  if (process.platform === "win32") return;
  const { root, workspace, lifecycle, snapshotRoot } = await fixture();
  const target = path.join(root, "inaccessible.bin");
  await fs.writeFile(target, "original", { mode: 0o640 });
  const snapshot = await withWorkspaceContext(workspace, () =>
    stageFileSnapshot(target),
  );
  const operationId = `job:v1:${sha256("inaccessible")}`;
  await lifecycle.journal.begin({
    operationId,
    workspace,
    tool: "file_chattr",
    files: [sourcePlan(target, snapshot, sha256("candidate"))],
  });
  await lifecycle.journal.transition(operationId, "recovery-required");
  await fs.writeFile(target, "candidate");
  await fs.chmod(target, 0);
  const actualOpen = fs.open;
  const open = spyOn(fs, "open").mockImplementation((async (
    ...args: Parameters<typeof fs.open>
  ) => {
    if (String(args[0]) === target) {
      throw Object.assign(new Error("target inaccessible"), { code: "EACCES" });
    }
    return actualOpen(...args);
  }) as typeof fs.open);
  try {
    await expect(lifecycle.recover()).rejects.toThrow(
      "mutation_recovery_required",
    );
    expect((await fs.stat(target)).mode & 0o777).toBe(0);
    expect((await lifecycle.journal.get(operationId))?.state).toBe(
      "recovery-required",
    );
    expect(await fs.readdir(snapshotRoot)).toContain(snapshot.sourceBlob.id);
  } finally {
    open.mockRestore();
    await fs.chmod(target, 0o640);
  }
  expect(await fs.readFile(target, "utf8")).toBe("candidate");
});

test("journal rejects invalid Base64 and inconsistent blob identities before persistence", async () => {
  const { root, workspace, lifecycle, store } = await fixture();
  const sourceSha256 = sha256("source");
  const blob = {
    id: `${process.pid}-${randomUUID()}`,
    sha256: sourceSha256,
    size: 6,
  };
  const file = {
    filePath: path.join(root, "source.bin"),
    sourceSha256,
    candidateSha256: null,
    sourceContentBase64: null,
  };
  for (const invalid of [
    { sourceContentBase64: "a" },
    { sourceContentBase64: "$$$$" },
    {
      sourceContentBase64: null,
      sourceBlob: { ...blob, sha256: sha256("other") },
    },
    { sourceContentBase64: "c291cmNl", sourceBlob: blob },
  ]) {
    await expect(
      lifecycle.journal.begin({
        operationId: `job:v1:${sha256(JSON.stringify(invalid))}`,
        workspace,
        tool: "file_delete",
        files: [{ ...file, ...invalid }],
      }),
    ).rejects.toThrow();
  }
  expect(await store.rows("jobs")).toEqual([]);
});

test("mutation identities exclude snapshot payloads", () => {
  const base = {
    candidateSha256: null,
    filePath: "/tmp/value",
    sourceSha256: sha256("source"),
  };
  const input = {
    files: [base],
    nonce: "one",
    storageDomainId: "domain",
    workspaceId: "workspace",
  };
  const enriched = {
    ...base,
    sourceContentBase64: "large source payload",
    sourceBlob: { id: "ignored" },
  };
  expect(mutationOperationId(input)).toBe(
    mutationOperationId({ ...input, files: [enriched] }),
  );
});
