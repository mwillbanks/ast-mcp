import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { configureMutationLifecycle } from "../../src/intelligence/mutation/lifecycle.ts";
import {
  WorkspaceRegistry,
  withWorkspaceContext,
} from "../../src/intelligence/workspace/index.ts";
import {
  applyFileChattr,
  readFileChattrSnapshot,
} from "../../src/runtime/attributes.ts";
import { deleteFilesSafely } from "../../src/runtime/file-delete.ts";
import { sha256, sha256File } from "../../src/runtime/hash.ts";
import {
  ensurePrivateLockDirectory,
  systemAccount,
} from "../../src/runtime/private-lock-directory.ts";
import {
  copySnapshotBlob,
  publishSnapshotNoReplace,
  closeSnapshotHandles,
  FileSnapshotCollection,
  openSnapshotBlob,
  removeSnapshotBlob,
  restoreSnapshotBlob,
  snapshotNamespace,
  stageFileSnapshot,
  sweepSnapshotBlobs,
  type StagedFileSnapshot,
} from "../../src/runtime/snapshot-blob.ts";

const roots: string[] = [];
const snapshots: StagedFileSnapshot[] = [];
const previousRoots = process.env.AST_MCP_ROOTS;
const previousExternal = process.env.AST_MCP_ALLOW_EXTERNAL_ROOTS;
afterEach(async () => {
  for (const snapshot of snapshots.splice(0))
    await removeSnapshotBlob(snapshot.sourceBlob, snapshot.namespace).catch(
      () => undefined,
    );
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
  if (previousRoots === undefined) delete process.env.AST_MCP_ROOTS;
  else process.env.AST_MCP_ROOTS = previousRoots;
  if (previousExternal === undefined)
    delete process.env.AST_MCP_ALLOW_EXTERNAL_ROOTS;
  else process.env.AST_MCP_ALLOW_EXTERNAL_ROOTS = previousExternal;
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ast-mcp-blob-"));
  roots.push(root);
  const workspace = await new WorkspaceRegistry().open({
    configurationGeneration: 1,
    directory: root,
    storage: { kind: "explicit", path: path.join(root, "index") },
  });
  return { root: workspace.checkoutRoot, workspace };
}

async function blobPath(snapshot: StagedFileSnapshot) {
  return path.join(
    await ensurePrivateLockDirectory(await systemAccount()),
    "snapshots",
    snapshot.namespace,
    snapshot.sourceBlob.id,
    `${snapshot.sha256}.blob`,
  );
}

async function publicationFixture() {
  const { root } = await fixture();
  const source = path.join(root, "publication-staged.bin");
  const destination = path.join(root, "publication-target.bin");
  const bytes = Buffer.alloc(2 * 1024 * 1024 + 17, 0xa7);
  await fs.writeFile(source, bytes, { mode: 0o640 });
  const handle = await fs.open(source, "r");
  return {
    root,
    source,
    destination,
    bytes,
    handle,
    expected: { sha256: sha256(bytes), size: bytes.length },
  };
}

test.each(["EXDEV", "ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EPERM"])(
  "snapshot rollback preserves verified binary bytes without hard links: %s",
  async (code) => {
    const { root, workspace } = await fixture();
    const source = path.join(root, "unsupported-link.bin");
    const bytes = Buffer.alloc(2 * 1024 * 1024 + 17, 0xe3);
    await fs.writeFile(source, bytes, { mode: 0o640 });
    const snapshot = await withWorkspaceContext(workspace, () =>
      stageFileSnapshot(source),
    );
    snapshots.push(snapshot);
    await fs.unlink(source);
    const link = spyOn(fs, "link").mockRejectedValue(
      Object.assign(new Error("unsupported link"), { code }),
    );
    try {
      await restoreSnapshotBlob(snapshot, source, async () => {});
      expect(await sha256File(source)).toBe(snapshot.sha256);
      expect((await fs.stat(source)).mode & 0o777).toBe(snapshot.mode & 0o777);
      expect(await sha256File(await blobPath(snapshot))).toBe(snapshot.sha256);
      expect(
        (await fs.readdir(root)).some((entry) => entry.includes(".rollback-")),
      ).toBeFalse();
    } finally {
      link.mockRestore();
    }
  },
);

test.each(["EACCES", "EEXIST", "EIO"])(
  "snapshot publication preserves genuine hard-link failures: %s",
  async (code) => {
    const { source, destination, handle, expected } =
      await publicationFixture();
    const failure = Object.assign(new Error("direct link failure"), { code });
    const link = spyOn(fs, "link").mockRejectedValue(failure);
    try {
      await expect(
        publishSnapshotNoReplace(
          source,
          destination,
          handle,
          expected,
          async () => {},
        ),
      ).rejects.toBe(failure);
      expect(await Bun.file(destination).exists()).toBeFalse();
      expect(await sha256File(source)).toBe(expected.sha256);
    } finally {
      link.mockRestore();
      await handle.close();
    }
  },
);

test.each(["existing", "racing", "denied"] as const)(
  "exclusive fallback preserves destinations and original diagnostics: %s",
  async (kind) => {
    const { source, destination, handle, expected } =
      await publicationFixture();
    const original = Object.assign(new Error("link privilege unavailable"), {
      code: "EPERM",
    });
    const denied = Object.assign(new Error("exclusive create denied"), {
      code: "EACCES",
    });
    const link = spyOn(fs, "link").mockRejectedValue(original);
    const actualOpen = fs.open;
    if (kind === "existing") await fs.writeFile(destination, "existing");
    const open = spyOn(fs, "open").mockImplementation((async (
      ...args: Parameters<typeof fs.open>
    ) => {
      if (String(args[0]) === destination) {
        if (kind === "racing") await fs.writeFile(destination, "racer");
        if (kind === "denied") throw denied;
      }
      return actualOpen(...args);
    }) as typeof fs.open);
    try {
      const failure = await publishSnapshotNoReplace(
        source,
        destination,
        handle,
        expected,
        async () => {},
      ).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(AggregateError);
      const errors = (failure as AggregateError).errors;
      expect(errors[0]).toBe(original);
      expect(errors[1]).toMatchObject({
        code: kind === "denied" ? "EACCES" : "EEXIST",
      });
      if (kind === "denied")
        expect(await Bun.file(destination).exists()).toBeFalse();
      else
        expect(await fs.readFile(destination, "utf8")).toBe(
          kind === "existing" ? "existing" : "racer",
        );
      expect(await handle.stat()).toMatchObject({ size: expected.size });
    } finally {
      open.mockRestore();
      link.mockRestore();
      await handle.close();
    }
  },
);

test.each([
  "write",
  "hash",
  "chmod",
  "sync",
  "metadata-sync",
  "stat",
  "stat-persistent",
  "write-close",
  "write-unlink",
  "aborted",
  "replaced",
] as const)(
  "exclusive publication cleans only owned material after %s failure",
  async (kind) => {
    const { source, destination, handle, expected } =
      await publicationFixture();
    const original = Object.assign(new Error("unsupported link"), {
      code: "ENOTSUP",
    });
    const link = spyOn(fs, "link").mockRejectedValue(original);
    const controller = new AbortController();
    const actualOpen = fs.open;
    const actualUnlink = fs.unlink;
    let closed = false;
    let writes = 0;
    let replacementInjected = false;
    let ownedIdentity: { dev: number; ino: number } | undefined;
    let replacementIdentity: { dev: number; ino: number } | undefined;
    const open = spyOn(fs, "open").mockImplementation((async (
      ...args: Parameters<typeof fs.open>
    ) => {
      const output = await actualOpen(...args);
      if (String(args[0]) !== destination) return output;
      const close = output.close.bind(output);
      spyOn(output, "close").mockImplementation(async () => {
        await close();
        closed = true;
        if (kind === "write-close") throw new Error("close failed");
      });
      if (kind === "stat" || kind === "stat-persistent") {
        const stat = output.stat.bind(output);
        let calls = 0;
        spyOn(output, "stat").mockImplementation((async (
          ...statArgs: Parameters<typeof output.stat>
        ) => {
          if (++calls === 1 || kind === "stat-persistent")
            throw new Error("identity unavailable");
          return stat(...statArgs);
        }) as typeof output.stat);
      }
      const write = output.write.bind(output);
      spyOn(output, "write").mockImplementation((async (
        ...writeArgs: Parameters<typeof output.write>
      ) => {
        writes++;
        if (kind.startsWith("write")) throw new Error("copy failed");
        if (kind === "aborted")
          controller.abort(new Error("publication cancelled"));
        if (kind === "replaced" && !replacementInjected) {
          const held = await output.stat();
          ownedIdentity = { dev: held.dev, ino: held.ino };
          await fs.rename(destination, destination + ".owned");
          await fs.writeFile(destination, "replacement");
          const replacement = await fs.lstat(destination);
          replacementIdentity = { dev: replacement.dev, ino: replacement.ino };
          replacementInjected = true;
        }
        const result = await write(...writeArgs);
        if (kind === "hash") await output.writeFile("corrupt");
        return result;
      }) as typeof output.write);
      if (kind === "chmod")
        spyOn(output, "chmod").mockRejectedValue(new Error("chmod failed"));
      if (kind === "sync" || kind === "metadata-sync") {
        const sync = output.sync.bind(output);
        let calls = 0;
        spyOn(output, "sync").mockImplementation(async () => {
          if (++calls === (kind === "sync" ? 1 : 2))
            throw new Error("sync failed");
          return sync();
        });
      }
      return output;
    }) as typeof fs.open);
    const unlink = spyOn(fs, "unlink").mockImplementation(async (...args) => {
      if (kind === "write-unlink" && String(args[0]) === destination)
        throw new Error("cleanup unlink failed");
      return actualUnlink(...args);
    });
    try {
      const failure = await publishSnapshotNoReplace(
        source,
        destination,
        handle,
        expected,
        async () => {},
        { signal: controller.signal },
      ).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(AggregateError);
      expect(closed).toBeTrue();
      if (kind === "replaced") expect(replacementInjected).toBeTrue();
      if (["stat-persistent", "write-unlink", "replaced"].includes(kind)) {
        expect(await Bun.file(destination).exists()).toBeTrue();
        if (kind === "replaced") {
          expect(writes).toBeGreaterThan(1);
          expect(ownedIdentity).toBeDefined();
          expect(replacementIdentity).toBeDefined();
          expect(replacementIdentity).not.toEqual(ownedIdentity);
          expect(await fs.lstat(destination)).toMatchObject(
            replacementIdentity!,
          );
          expect(await fs.readFile(destination, "utf8")).toBe("replacement");
          expect(await fs.lstat(destination + ".owned")).toMatchObject(
            ownedIdentity!,
          );
          expect(await sha256File(destination + ".owned")).toBe(
            expected.sha256,
          );
        }
      } else expect(await Bun.file(destination).exists()).toBeFalse();
      expect(await sha256File(source)).toBe(expected.sha256);
      expect(await handle.stat()).toMatchObject({ size: expected.size });
      if (kind === "write-close" || kind === "write-unlink")
        expect((failure as AggregateError).errors.length).toBeGreaterThan(2);
    } finally {
      open.mockRestore();
      unlink.mockRestore();
      link.mockRestore();
      await handle.close();
    }
  },
);

test("staged binary snapshots stream verified bytes and preserve metadata", async () => {
  const { root, workspace } = await fixture();
  const source = path.join(root, "source.bin");
  const bytes = Buffer.alloc(8 * 1024 * 1024, 0xa5);
  bytes[0] = 0;
  bytes[1] = 255;
  await fs.writeFile(source, bytes, { mode: 0o640 });
  const snapshot = await withWorkspaceContext(workspace, () =>
    stageFileSnapshot(source),
  );
  snapshots.push(snapshot);
  expect(snapshot.sourceBlob.size).toBe(bytes.length);
  expect(snapshot.sha256).toBe(sha256(bytes));
  expect("content" in snapshot).toBeFalse();
  const handle = await openSnapshotBlob(
    snapshot.sourceBlob,
    snapshot.namespace,
  );
  const copy = path.join(root, "copy.bin");
  try {
    await copySnapshotBlob(handle, copy, snapshot.sourceBlob);
  } finally {
    await handle.close();
  }
  expect(await sha256File(copy)).toBe(snapshot.sha256);
  const restored = path.join(root, "restored.bin");
  await restoreSnapshotBlob(snapshot, restored, async () => {});
  expect(await sha256File(restored)).toBe(snapshot.sha256);
  expect((await fs.stat(restored)).mode & 0o777).toBe(snapshot.mode & 0o777);
});

test("snapshot capture rejects cancellation and symlink sources", async () => {
  const { root, workspace } = await fixture();
  const source = path.join(root, "source.bin");
  await fs.writeFile(source, "preserved");
  const controller = new AbortController();
  controller.abort(new Error("cancelled capture"));
  await expect(
    withWorkspaceContext(workspace, () =>
      stageFileSnapshot(source, controller.signal),
    ),
  ).rejects.toThrow("cancelled capture");
  const linked = path.join(root, "linked.bin");
  await fs.symlink(source, linked);
  await expect(
    withWorkspaceContext(workspace, () => stageFileSnapshot(linked)),
  ).rejects.toThrow();
  expect(await fs.readFile(source, "utf8")).toBe("preserved");
});

test("blob verification rejects tampering and symlinks", async () => {
  const { root, workspace } = await fixture();
  const source = path.join(root, "source.bin");
  await fs.writeFile(source, "original");
  const snapshot = await withWorkspaceContext(workspace, () =>
    stageFileSnapshot(source),
  );
  snapshots.push(snapshot);
  const stored = await blobPath(snapshot);
  await fs.writeFile(stored, "tampered");
  await expect(
    openSnapshotBlob(snapshot.sourceBlob, snapshot.namespace),
  ).rejects.toThrow("mutation_recovery_material_mismatch");
  await fs.unlink(stored);
  await fs.symlink(source, stored);
  const actualOpen = fs.open;
  let followed: Awaited<ReturnType<typeof fs.open>> | undefined;
  const open = spyOn(fs, "open").mockImplementation((async (
    ...args: Parameters<typeof fs.open>
  ) => {
    if (String(args[0]) === stored) {
      // Emulate platforms where O_NOFOLLOW does not reject the link.
      followed = await actualOpen(stored, "r");
      return followed;
    }
    return actualOpen(...args);
  }) as typeof fs.open);
  try {
    await expect(
      openSnapshotBlob(snapshot.sourceBlob, snapshot.namespace).then(
        async (handle) => {
          await handle.close();
        },
      ),
    ).rejects.toThrow("mutation_snapshot_material_unsafe");
    expect(followed).toBeDefined();
    await expect(followed!.stat()).rejects.toMatchObject({ code: "EBADF" });
  } finally {
    open.mockRestore();
    await followed?.close().catch(() => undefined);
  }
  expect(await fs.readFile(source, "utf8")).toBe("original");
});

test("failed streaming restore leaves no partial target or temporary", async () => {
  const { root, workspace } = await fixture();
  const source = path.join(root, "source.bin");
  await fs.writeFile(source, Buffer.alloc(2 * 1024 * 1024, 7));
  const snapshot = await withWorkspaceContext(workspace, () =>
    stageFileSnapshot(source),
  );
  snapshots.push(snapshot);
  const target = path.join(root, "target.bin");
  const actualOpen = fs.open;
  const open = spyOn(fs, "open").mockImplementation((async (
    ...args: Parameters<typeof fs.open>
  ) => {
    const handle = await actualOpen(...args);
    if (String(args[0]).includes(".rollback-")) {
      spyOn(handle, "write").mockRejectedValue(new Error("snapshot disk full"));
    }
    return handle;
  }) as typeof fs.open);
  try {
    await expect(
      restoreSnapshotBlob(snapshot, target, async () => {}),
    ).rejects.toThrow("snapshot disk full");
    expect(await Bun.file(target).exists()).toBeFalse();
    expect(
      (await fs.readdir(root)).filter((name) => name.includes(".rollback-")),
    ).toEqual([]);
    const handle = await openSnapshotBlob(
      snapshot.sourceBlob,
      snapshot.namespace,
    );
    await handle.close();
  } finally {
    open.mockRestore();
  }
});

test("all staged snapshots verify before the first deletion", async () => {
  const { root, workspace } = await fixture();
  await fs.writeFile(path.join(root, "ast-mcp.toml"), "version = 1\n");
  process.env.AST_MCP_ROOTS = root;
  process.env.AST_MCP_ALLOW_EXTERNAL_ROOTS = "1";
  const first = path.join(root, "first.bin"),
    second = path.join(root, "second.bin");
  await fs.writeFile(first, "first");
  await fs.writeFile(second, "second");
  const reset = configureMutationLifecycle({
    async begin(plan) {
      const file = plan.files[1]!;
      const stored = path.join(
        await ensurePrivateLockDirectory(await systemAccount()),
        "snapshots",
        snapshotNamespace(workspace),
        file.sourceBlob!.id,
        `${file.sourceSha256}.blob`,
      );
      await fs.writeFile(stored, "broken");
    },
    async committed() {},
    async complete() {
      return null;
    },
    async failed() {},
    async rolledBack() {},
  });
  try {
    await expect(
      withWorkspaceContext(workspace, () =>
        deleteFilesSafely({
          [first]: { expectedSha256: sha256("first") },
          [second]: { expectedSha256: sha256("second") },
        }),
      ),
    ).rejects.toThrow();
    expect(await fs.readFile(first, "utf8")).toBe("first");
    expect(await fs.readFile(second, "utf8")).toBe("second");
  } finally {
    reset();
  }
});

test("snapshot garbage collection preserves active and retained captures", async () => {
  const { root, workspace } = await fixture();
  const source = path.join(root, "source.bin");
  await fs.writeFile(source, "original");
  const snapshot = await withWorkspaceContext(workspace, () =>
    stageFileSnapshot(source),
  );
  snapshots.push(snapshot);
  expect(await sweepSnapshotBlobs(snapshot.namespace, new Set())).toBe(0);
  const collection = new FileSnapshotCollection();
  collection.set(source, snapshot);
  collection.disposable = false;
  await collection[Symbol.asyncDispose]();
  expect(
    await sweepSnapshotBlobs(
      snapshot.namespace,
      new Set([snapshot.sourceBlob.id]),
    ),
  ).toBe(0);
  expect(await sweepSnapshotBlobs(snapshot.namespace, new Set())).toBe(1);
  expect(await fs.stat(await blobPath(snapshot)).catch(() => null)).toBeNull();
});
test("snapshot fsync failure leaves source bytes and no staged material", async () => {
  const { root, workspace } = await fixture();
  const source = path.join(root, "source.bin");
  await fs.writeFile(source, "original");
  const actualOpen = fs.open;
  const open = spyOn(fs, "open").mockImplementation((async (
    ...args: Parameters<typeof fs.open>
  ) => {
    const handle = await actualOpen(...args);
    if (path.basename(String(args[0])) === "pending")
      spyOn(handle, "sync").mockRejectedValue(
        new Error("snapshot sync failed"),
      );
    return handle;
  }) as typeof fs.open);
  try {
    await expect(
      withWorkspaceContext(workspace, () => stageFileSnapshot(source)),
    ).rejects.toThrow("snapshot sync failed");
    expect(await fs.readFile(source, "utf8")).toBe("original");
    const directory = path.join(
      await ensurePrivateLockDirectory(await systemAccount()),
      "snapshots",
      snapshotNamespace(workspace),
    );
    expect(await fs.readdir(directory)).toEqual([]);
  } finally {
    open.mockRestore();
  }
});

for (const [failingHandle, failWrite] of [
  ["source", false],
  ["destination", false],
  ["source", true],
  ["destination", true],
] as const) {
  test(`capture cleanup survives ${failingHandle} close failure, write failure=${failWrite}`, async () => {
    const { root, workspace } = await fixture();
    const source = path.join(root, "close-source.bin");
    await fs.writeFile(source, "preserved");
    const actualOpen = fs.open;
    const closed = new Set<string>();
    const primary = new Error("capture write failed");
    const cleanup = new Error("capture close failed");
    const open = spyOn(fs, "open").mockImplementation((async (
      ...args: Parameters<typeof fs.open>
    ) => {
      const handle = await actualOpen(...args);
      const kind =
        String(args[0]) === source
          ? "source"
          : path.basename(String(args[0])) === "pending"
            ? "destination"
            : null;
      if (kind) {
        const close = handle.close.bind(handle);
        spyOn(handle, "close").mockImplementation(async () => {
          await close();
          closed.add(kind);
          if (kind === failingHandle) throw cleanup;
        });
        if (kind === "destination" && failWrite)
          spyOn(handle, "write").mockRejectedValue(primary);
      }
      return handle;
    }) as typeof fs.open);
    try {
      const error = await withWorkspaceContext(workspace, () =>
        stageFileSnapshot(source),
      ).catch((error) => error);
      expect(error).toBeInstanceOf(AggregateError);
      if (failWrite) expect(error.errors).toContain(primary);
      expect(error.errors).toContain(cleanup);
      expect([...closed].sort()).toEqual(["destination", "source"]);
      expect(await fs.readFile(source, "utf8")).toBe("preserved");
      const directory = path.join(
        await ensurePrivateLockDirectory(await systemAccount()),
        "snapshots",
        snapshotNamespace(workspace),
      );
      expect(await fs.readdir(directory)).toEqual([]);
    } finally {
      open.mockRestore();
    }
  });
}

test.each(["file", "symlink"] as const)(
  "failed copy preserves a %s replacing its temporary inode",
  async (replacement) => {
    const { root, workspace } = await fixture();
    const source = path.join(root, "source.bin");
    const destination = path.join(root, "copy.bin");
    await fs.writeFile(source, "preserved");
    const snapshot = await withWorkspaceContext(workspace, () =>
      stageFileSnapshot(source),
    );
    snapshots.push(snapshot);
    const input = await openSnapshotBlob(
      snapshot.sourceBlob,
      snapshot.namespace,
    );
    const actualOpen = fs.open;
    const primary = new Error("copy write failed");
    let output: Awaited<ReturnType<typeof fs.open>> | undefined;
    const open = spyOn(fs, "open").mockImplementation((async (
      ...args: Parameters<typeof fs.open>
    ) => {
      const handle = await actualOpen(...args);
      if (String(args[0]) === destination) {
        output = handle;
        spyOn(handle, "write").mockImplementation(async () => {
          await fs.rename(destination, destination + ".owned");
          if (replacement === "file")
            await fs.writeFile(destination, "replacement");
          else await fs.symlink(source, destination);
          throw primary;
        });
      }
      return handle;
    }) as typeof fs.open);
    try {
      const error = await copySnapshotBlob(
        input,
        destination,
        snapshot.sourceBlob,
      ).catch((error) => error);
      expect(error).toBeInstanceOf(AggregateError);
      expect(error.errors).toContain(primary);
      expect(
        error.errors.some(
          (error: { code?: string }) =>
            error.code === "mutation_snapshot_temporary_replaced",
        ),
      ).toBeTrue();
      expect(await fs.readFile(destination, "utf8")).toBe(
        replacement === "file" ? "replacement" : "preserved",
      );
      expect((await fs.lstat(destination)).isSymbolicLink()).toBe(
        replacement === "symlink",
      );
      await expect(output!.stat()).rejects.toMatchObject({ code: "EBADF" });
    } finally {
      open.mockRestore();
      await input.close();
    }
  },
);

for (const failWrite of [false, true]) {
  test(`copy close failure removes owned output, write failure=${failWrite}`, async () => {
    const { root, workspace } = await fixture();
    const source = path.join(root, "copy-source.bin");
    const destination = path.join(root, "copy-output.bin");
    await fs.writeFile(source, "preserved");
    const snapshot = await withWorkspaceContext(workspace, () =>
      stageFileSnapshot(source),
    );
    snapshots.push(snapshot);
    const input = await openSnapshotBlob(
      snapshot.sourceBlob,
      snapshot.namespace,
    );
    const primary = new Error("copy write failed");
    const cleanup = new Error("copy close failed");
    const actualOpen = fs.open;
    let closed = false;
    const open = spyOn(fs, "open").mockImplementation((async (
      ...args: Parameters<typeof fs.open>
    ) => {
      const handle = await actualOpen(...args);
      if (String(args[0]) === destination) {
        const close = handle.close.bind(handle);
        spyOn(handle, "close").mockImplementation(async () => {
          await close();
          closed = true;
          throw cleanup;
        });
        if (failWrite) spyOn(handle, "write").mockRejectedValue(primary);
      }
      return handle;
    }) as typeof fs.open);
    try {
      const error = await copySnapshotBlob(
        input,
        destination,
        snapshot.sourceBlob,
      ).catch((error) => error);
      expect(error).toBeInstanceOf(AggregateError);
      expect(error.errors).toContain(cleanup);
      if (failWrite) expect(error.errors).toContain(primary);
      expect(closed).toBeTrue();
      expect(await Bun.file(destination).exists()).toBeFalse();
      expect((await input.stat()).size).toBe(snapshot.sourceBlob.size);
    } finally {
      open.mockRestore();
      await input.close();
    }
  });
}

test.each(["transient", "persistent", "replacement"] as const)(
  "failed copy retries descriptor identity once and preserves unknown paths: %s",
  async (phase) => {
    const { root, workspace } = await fixture();
    const source = path.join(root, "identity-source.bin"),
      destination = path.join(root, "identity-copy.bin");
    await fs.writeFile(source, "preserved");
    const snapshot = await withWorkspaceContext(workspace, () =>
      stageFileSnapshot(source),
    );
    snapshots.push(snapshot);
    const input = await openSnapshotBlob(
      snapshot.sourceBlob,
      snapshot.namespace,
    );
    const primary = new Error("initial identity failed"),
      retry = new Error("identity retry failed");
    const actualOpen = fs.open;
    let output: Awaited<ReturnType<typeof fs.open>> | undefined;
    let calls = 0;
    const open = spyOn(fs, "open").mockImplementation((async (
      ...args: Parameters<typeof fs.open>
    ) => {
      const handle = await actualOpen(...args);
      if (String(args[0]) === destination) {
        output = handle;
        const stat = handle.stat.bind(handle);
        spyOn(handle, "stat").mockImplementation((async () => {
          calls++;
          if (calls === 1) {
            if (phase === "replacement") {
              await fs.rename(destination, destination + ".owned");
              await fs.writeFile(destination, "replacement");
            }
            throw primary;
          }
          if (phase === "persistent") throw retry;
          return stat();
        }) as typeof handle.stat);
      }
      return handle;
    }) as typeof fs.open);
    try {
      const error = await copySnapshotBlob(
        input,
        destination,
        snapshot.sourceBlob,
      ).catch((error) => error);
      expect(calls).toBe(2);
      if (phase === "transient") expect(error).toBe(primary);
      else {
        expect(error).toBeInstanceOf(AggregateError);
        expect(error.errors).toContain(primary);
        if (phase === "persistent") expect(error.errors).toContain(retry);
        else
          expect(
            error.errors.some((item: Error) =>
              item.message.includes("mutation_snapshot_temporary_replaced"),
            ),
          ).toBeTrue();
      }
      if (phase === "transient")
        expect(await Bun.file(destination).exists()).toBeFalse();
      else
        expect(await fs.readFile(destination, "utf8")).toBe(
          phase === "replacement" ? "replacement" : "",
        );
      await expect(
        output!.read(Buffer.alloc(1), 0, 1, 0),
      ).rejects.toMatchObject({ code: "EBADF" });
      expect((await input.stat()).size).toBe(snapshot.sourceBlob.size);
    } finally {
      open.mockRestore();
      await input.close();
    }
  },
);

test.each([false, true])(
  "failed copy persists temporary removal and preserves sync errors: %s",
  async (fails) => {
    if (process.platform === "win32") return;
    const { root, workspace } = await fixture();
    const source = path.join(root, "copy-sync-source.bin"),
      destination = path.join(root, "copy-sync-output.bin");
    await fs.writeFile(source, "preserved");
    const snapshot = await withWorkspaceContext(workspace, () =>
      stageFileSnapshot(source),
    );
    snapshots.push(snapshot);
    const input = await openSnapshotBlob(
      snapshot.sourceBlob,
      snapshot.namespace,
    );
    const primary = new Error("copy write failed"),
      cleanup = new Error("copy cleanup sync failed");
    const actualOpen = fs.open,
      actualUnlink = fs.unlink;
    const events: string[] = [];
    const open = spyOn(fs, "open").mockImplementation((async (
      ...args: Parameters<typeof fs.open>
    ) => {
      const handle = await actualOpen(...args);
      if (String(args[0]) === destination)
        spyOn(handle, "write").mockRejectedValue(primary);
      if (String(args[0]) === root) {
        const sync = handle.sync.bind(handle);
        spyOn(handle, "sync").mockImplementation(async () => {
          events.push("sync");
          if (fails) throw cleanup;
          await sync();
        });
      }
      return handle;
    }) as typeof fs.open);
    const unlink = spyOn(fs, "unlink").mockImplementation(async (file) => {
      if (String(file) === destination) events.push("unlink");
      return actualUnlink(file);
    });
    try {
      const error = await copySnapshotBlob(
        input,
        destination,
        snapshot.sourceBlob,
      ).catch((error) => error);
      if (fails) {
        expect(error).toBeInstanceOf(AggregateError);
        expect(error.errors).toEqual([primary, cleanup]);
      } else expect(error).toBe(primary);
      expect(events).toEqual(["unlink", "sync"]);
      expect(await Bun.file(destination).exists()).toBeFalse();
    } finally {
      open.mockRestore();
      unlink.mockRestore();
      await input.close();
    }
  },
);

test.each([false, true])(
  "failed restore syncs temporary removal, sync failure=%s",
  async (fails) => {
    if (process.platform === "win32") return; // Directory fsync is unavailable on Windows.
    const { root, workspace } = await fixture();
    const source = path.join(root, "sync-source.bin");
    await fs.writeFile(source, "preserved");
    const snapshot = await withWorkspaceContext(workspace, () =>
      stageFileSnapshot(source),
    );
    snapshots.push(snapshot);
    const actualOpen = fs.open,
      actualUnlink = fs.unlink;
    const events: string[] = [];
    const primary = new Error("restore fence failed");
    const open = spyOn(fs, "open").mockImplementation((async (
      ...args: Parameters<typeof fs.open>
    ) => {
      const handle = await actualOpen(...args);
      if (String(args[0]) === root) {
        const sync = handle.sync.bind(handle);
        spyOn(handle, "sync").mockImplementation(async () => {
          events.push("sync");
          if (fails) throw new Error("cleanup sync failed");
          await sync();
        });
      }
      return handle;
    }) as typeof fs.open);
    const unlink = spyOn(fs, "unlink").mockImplementation(async (file) => {
      if (String(file).includes(".rollback-")) events.push("unlink");
      return actualUnlink(file);
    });
    let fences = 0;
    try {
      const error = await restoreSnapshotBlob(
        snapshot,
        path.join(root, "restore.bin"),
        async () => {
          if (++fences === 2) throw primary;
        },
      ).catch((error) => error);
      if (fails) {
        expect(error).toBeInstanceOf(AggregateError);
        expect(error.errors).toContain(primary);
      } else expect(error).toBe(primary);
      expect(events).toEqual(["unlink", "sync"]);
      expect(
        (await fs.readdir(root)).some((name) => name.includes(".rollback-")),
      ).toBeFalse();
      const input = await openSnapshotBlob(
        snapshot.sourceBlob,
        snapshot.namespace,
      );
      await input.close();
    } finally {
      open.mockRestore();
      unlink.mockRestore();
    }
  },
);

for (const [failingHandle, failFence] of [
  ["source", false],
  ["source", true],
  ["metadata", true],
] as const) {
  test(`restore cleanup survives ${failingHandle} close failure, fence failure=${failFence}`, async () => {
    const { root, workspace } = await fixture();
    const source = path.join(root, "restore-source.bin");
    const destination = path.join(root, "restore-output.bin");
    await fs.writeFile(source, "preserved");
    const snapshot = await withWorkspaceContext(workspace, () =>
      stageFileSnapshot(source),
    );
    snapshots.push(snapshot);
    const stored = await blobPath(snapshot);
    const primary = new Error("restore fence failed");
    const cleanup = new Error("restore close failed");
    const actualOpen = fs.open;
    const closed = new Set<string>();
    const open = spyOn(fs, "open").mockImplementation((async (
      ...args: Parameters<typeof fs.open>
    ) => {
      const handle = await actualOpen(...args);
      const kind =
        String(args[0]) === stored
          ? "source"
          : String(args[0]).includes(".rollback-") && args[1] !== "wx"
            ? "metadata"
            : null;
      if (kind) {
        const close = handle.close.bind(handle);
        spyOn(handle, "close").mockImplementation(async () => {
          await close();
          closed.add(kind);
          if (kind === failingHandle) throw cleanup;
        });
      }
      return handle;
    }) as typeof fs.open);
    let fences = 0;
    try {
      const error = await restoreSnapshotBlob(
        snapshot,
        destination,
        async () => {
          if (++fences === 2 && failFence) throw primary;
        },
      ).catch((error) => error);
      if (failFence) {
        expect(error).toBeInstanceOf(AggregateError);
        expect(error.errors).toContain(primary);
        expect(error.errors).toContain(cleanup);
      } else {
        expect(error).toBe(cleanup);
        expect(await sha256File(destination)).toBe(snapshot.sha256);
      }
      expect([...closed].sort()).toEqual(["metadata", "source"]);
      expect(await Bun.file(destination).exists()).toBe(!failFence);
      expect(
        (await fs.readdir(root)).filter((name) => name.includes(".rollback-")),
      ).toEqual([]);
      expect(await sha256File(stored)).toBe(snapshot.sha256);
    } finally {
      open.mockRestore();
    }
  });
}

test("attribute snapshot preserves open and cleanup failures", async () => {
  const { root, workspace } = await fixture();
  const source = path.join(root, "chattr-open-cleanup.bin");
  await fs.writeFile(source, "preserved");
  const primary = new Error("retained open failed"),
    cleanup = new Error("snapshot cleanup failed");
  const actualOpen = fs.open,
    actualUnlink = fs.unlink;
  let opens = 0;
  const open = spyOn(fs, "open").mockImplementation((async (
    ...args: Parameters<typeof fs.open>
  ) => {
    if (String(args[0]) === source && ++opens === 2) throw primary;
    return actualOpen(...args);
  }) as typeof fs.open);
  const unlink = spyOn(fs, "unlink").mockImplementation(async (file) => {
    if (String(file).endsWith(".blob")) throw cleanup;
    return actualUnlink(file);
  });
  try {
    const error = await withWorkspaceContext(workspace, () =>
      readFileChattrSnapshot(source),
    ).catch((error) => error);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors).toEqual([primary, cleanup]);
    expect(await fs.readFile(source, "utf8")).toBe("preserved");
  } finally {
    open.mockRestore();
    unlink.mockRestore();
    await sweepSnapshotBlobs(snapshotNamespace(workspace), new Set());
  }
});

test("chattr retained-open failure reclaims its completed snapshot", async () => {
  const { root, workspace } = await fixture();
  const source = path.join(root, "chattr-open.bin");
  await fs.writeFile(source, "preserved");
  const actualOpen = fs.open;
  let sourceOpens = 0;
  const open = spyOn(fs, "open").mockImplementation((async (
    ...args: Parameters<typeof fs.open>
  ) => {
    if (String(args[0]) === source && ++sourceOpens === 2)
      throw new Error("retained open failed");
    return actualOpen(...args);
  }) as typeof fs.open);
  try {
    await expect(
      withWorkspaceContext(workspace, () => readFileChattrSnapshot(source)),
    ).rejects.toThrow("retained open failed");
    const directory = path.join(
      await ensurePrivateLockDirectory(await systemAccount()),
      "snapshots",
      snapshotNamespace(workspace),
    );
    expect(await fs.readdir(directory)).toEqual([]);
    expect(await fs.readFile(source, "utf8")).toBe("preserved");
  } finally {
    open.mockRestore();
  }
});

test("guarded attributes open their own descriptor and reject growth during hashing", async () => {
  const { root, workspace } = await fixture();
  const source = path.join(root, "chattr-growth.bin");
  await fs.writeFile(source, "preserved", { mode: 0o640 });
  const snapshot = await withWorkspaceContext(workspace, () =>
    stageFileSnapshot(source),
  );
  snapshots.push(snapshot);
  await applyFileChattr(source, { chmod: 0o600 }, undefined, snapshot);
  const actualOpen = fs.open;
  const open = spyOn(fs, "open").mockImplementation((async (
    ...args: Parameters<typeof fs.open>
  ) => {
    const handle = await actualOpen(...args);
    if (String(args[0]) === source) {
      const read = handle.read.bind(handle);
      let appended = false;
      spyOn(handle, "read").mockImplementation((async (
        ...readArgs: Parameters<typeof handle.read>
      ) => {
        if (!appended) {
          appended = true;
          await fs.appendFile(source, "extra");
        }
        return read(...readArgs);
      }) as typeof handle.read);
    }
    return handle;
  }) as typeof fs.open);
  try {
    await expect(
      applyFileChattr(source, { chmod: 0o644 }, undefined, snapshot),
    ).rejects.toMatchObject({ code: "stale_or_missing_hash" });
    expect(await fs.readFile(source, "utf8")).toBe("preservedextra");
    if (process.platform !== "win32")
      expect((await fs.stat(source)).mode & 0o777).toBe(0o600);
  } finally {
    open.mockRestore();
  }
});

test("snapshot references reject unsafe identities and bounded material sizes", async () => {
  const { root, workspace } = await fixture();
  const source = path.join(root, "unsafe.bin");
  await fs.writeFile(source, "preserved");
  const snapshot = await withWorkspaceContext(workspace, () =>
    stageFileSnapshot(source),
  );
  snapshots.push(snapshot);
  await expect(
    openSnapshotBlob(
      { ...snapshot.sourceBlob, id: "../escape" },
      snapshot.namespace,
    ),
  ).rejects.toThrow("mutation_snapshot_reference_invalid");
  await expect(
    openSnapshotBlob(snapshot.sourceBlob, "../escape"),
  ).rejects.toThrow("mutation_snapshot_namespace_invalid");
  await expect(
    openSnapshotBlob(
      { ...snapshot.sourceBlob, size: snapshot.sourceBlob.size + 1 },
      snapshot.namespace,
    ),
  ).rejects.toThrow("mutation_snapshot_material_unsafe");
  const stored = await blobPath(snapshot);
  if (process.platform !== "win32") {
    await fs.chmod(path.dirname(stored), 0o755);
    await expect(
      openSnapshotBlob(snapshot.sourceBlob, snapshot.namespace),
    ).rejects.toThrow("mutation_snapshot_directory_unsafe");
    await fs.chmod(path.dirname(stored), 0o700);
    await fs.chmod(stored, 0o644);
    await expect(
      openSnapshotBlob(snapshot.sourceBlob, snapshot.namespace),
    ).rejects.toThrow("mutation_snapshot_material_unsafe");
    await fs.chmod(stored, 0o600);
  }
  expect(await sha256File(stored)).toBe(snapshot.sha256);
});

test("collection cleanup tolerates unlink failure and later explicit cleanup succeeds", async () => {
  const { root, workspace } = await fixture();
  const source = path.join(root, "cleanup.bin");
  await fs.writeFile(source, "preserved");
  const snapshot = await withWorkspaceContext(workspace, () =>
    stageFileSnapshot(source),
  );
  snapshots.push(snapshot);
  const stored = await blobPath(snapshot);
  const collection = new FileSnapshotCollection();
  collection.set(source, snapshot);
  const actualUnlink = fs.unlink;
  const unlink = spyOn(fs, "unlink").mockImplementation(async (file) => {
    if (String(file) === stored)
      throw Object.assign(new Error("unlink denied"), { code: "EACCES" });
    return actualUnlink(file);
  });
  try {
    await collection[Symbol.asyncDispose]();
    expect(await sha256File(stored)).toBe(snapshot.sha256);
  } finally {
    unlink.mockRestore();
  }
  await removeSnapshotBlob(snapshot.sourceBlob, snapshot.namespace);
  await removeSnapshotBlob(snapshot.sourceBlob, snapshot.namespace);
  expect(await Bun.file(stored).exists()).toBeFalse();
});

test("descriptor cleanup closes every owned handle after one close fails", async () => {
  const { root } = await fixture();
  const source = path.join(root, "close.bin");
  await fs.writeFile(source, "preserved");
  const first = await fs.open(source, "r"),
    second = await fs.open(source, "r");
  const actualClose = first.close.bind(first);
  const close = spyOn(first, "close").mockImplementation(async () => {
    await actualClose();
    throw new Error("close failure");
  });
  try {
    await expect(closeSnapshotHandles([first, second])).rejects.toThrow(
      "Snapshot descriptor cleanup failed",
    );
    await expect(second.stat()).rejects.toMatchObject({ code: "EBADF" });
    expect(await fs.readFile(source, "utf8")).toBe("preserved");
  } finally {
    close.mockRestore();
    await Promise.allSettled([first.close(), second.close()]);
  }
});

test("snapshot garbage collection removes dead process crash orphans", async () => {
  const { root, workspace } = await fixture();
  const source = path.join(root, "source.bin");
  await fs.writeFile(source, "original");
  const snapshot = await withWorkspaceContext(workspace, () =>
    stageFileSnapshot(source),
  );
  const collection = new FileSnapshotCollection();
  collection.set(source, snapshot);
  collection.disposable = false;
  await collection[Symbol.asyncDispose]();
  const directory = path.dirname(await blobPath(snapshot));
  const id = `99999999-${snapshot.sourceBlob.id.slice(snapshot.sourceBlob.id.indexOf("-") + 1)}`;
  const orphan = path.join(path.dirname(directory), id);
  await fs.rename(directory, orphan);
  await fs.utimes(orphan, new Date(0), new Date(0));
  expect(await sweepSnapshotBlobs(snapshot.namespace, new Set([id]))).toBe(0);
  expect(await sweepSnapshotBlobs(snapshot.namespace, new Set())).toBe(1);
  expect(await fs.stat(orphan).catch(() => null)).toBeNull();
});
