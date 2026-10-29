import { afterEach, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
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
    expect(await lifecycle.journal.unfinished(workspace.workspaceId)).toEqual(
      [],
    );
    expect(await fs.readdir(snapshotRoot)).toEqual([]);
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
