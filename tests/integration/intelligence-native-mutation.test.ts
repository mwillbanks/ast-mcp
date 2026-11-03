import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createRepositoryId,
  createRevisionId,
  createStorageDomainId,
  createWorkspaceId,
} from "../../src/intelligence/contracts/index.ts";
import { refreshMutationIntelligence } from "../../src/intelligence/mutation/freshness.ts";
import { acquireFileLock } from "../../src/intelligence/mutation/locks.ts";
import {
  mutationTransactionLockPath,
  withLanceMutationLifecycle,
} from "../../src/intelligence/mutation/service.ts";
import { LanceIntelligenceStore } from "../../src/intelligence/storage/store.ts";
import {
  type WorkspaceHandle,
  withWorkspaceContext,
} from "../../src/intelligence/workspace/index.ts";
import { deferred } from "../support/mock-time.ts";
const roots: string[] = [];

async function temporary(prefix = "ast-mcp-mutation-"): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});
function fakeWorkspace(root: string, suffix: string): WorkspaceHandle {
  const storagePath = path.join(root, "index");
  const placement = { kind: "explicit" as const, path: storagePath };
  const storageDomainId = createStorageDomainId({
    engine: "lancedb",
    placement,
    pool: "shared",
    storagePath,
  });
  const commonGitDirectory = path.join(root, `.${suffix}.git`);
  const repositoryId = createRepositoryId({
    canonicalGitCommonDirectory: commonGitDirectory,
  });
  const revisionId = createRevisionId({
    repositoryId,
    resolvedCommitOid: "a".repeat(40),
    selector: { kind: "working" },
  });
  const workspaceId = createWorkspaceId({
    canonicalCheckoutRoot: root,
    configurationGeneration: 1,
    dirtyOverlayId: null,
    repositoryId,
    revisionId,
    storageDomainId,
  });
  return {
    canonicalRootAnchor: root,
    checkoutRoot: root,
    configurationGeneration: 1,
    dirtyOverlayId: null,
    git: {
      branch: "main",
      checkoutRoot: root,
      commonGitDirectory,
      gitDirectory: commonGitDirectory,
      headOid: "a".repeat(40),
      isGit: true,
      isLinkedWorktree: false,
      repositoryRoot: root,
    },
    openedAt: "2026-09-10T00:00:00.000Z",
    repositoryId,
    repositoryRoot: root,
    schemaVersion: "ast-mcp.intelligence.v1",
    selectedRevision: {
      readOnly: false,
      resolvedCommitOid: "a".repeat(40),
      revisionId,
      selector: { kind: "working" },
    },
    storageDomain: {
      domainId: storageDomainId,
      engine: "lancedb",
      placement,
      pool: "shared",
      schemaVersion: "ast-mcp.intelligence.v1",
      storagePath,
    },
    workspaceId,
    writeEligibility: { eligible: true },
  };
}

test("aborting revision discovery kills a non-terminating Git process", async () => {
  const root = await temporary("ast-mcp-abort-git-");
  const originalPath = process.env.PATH;
  const originalSpawn = Bun.spawn;
  if (process.platform === "win32") {
    let finish!: (code: number) => void;
    const exited = new Promise<number>((resolve) => {
      finish = resolve;
    });
    const child = {
      exitCode: null,
      exited,
      kill: () => finish(137),
      pid: 123,
      stderr: new Blob().stream(),
      stdout: new Blob().stream(),
    };
    Bun.spawn = (() => child) as unknown as typeof Bun.spawn;
  } else {
    const bin = path.join(root, "bin");
    await mkdir(bin);
    const fakeGit = path.join(bin, "git");
    await writeFile(fakeGit, "#!/bin/sh\ntrap '' TERM\nwhile :; do :; done\n");
    await chmod(fakeGit, 0o755);
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ""}`;
  }
  const base = fakeWorkspace(root, "abort-git");
  const workspace = {
    ...base,
    selectedRevision: {
      ...base.selectedRevision,
      readOnly: true,
      selector: { kind: "commit" as const, oid: "a".repeat(40) },
    },
  };
  const store = await LanceIntelligenceStore.open(workspace.storageDomain);
  const controller = new AbortController();
  const spawned = deferred<void>();
  const dispatch = Bun.spawn;
  Bun.spawn = ((...args: Parameters<typeof Bun.spawn>) => {
    const child = dispatch(...args);
    spawned.resolve();
    return child;
  }) as typeof Bun.spawn;
  const pending = withWorkspaceContext(workspace, () =>
    refreshMutationIntelligence({
      signal: controller.signal,
      store,
      workspace,
    }),
  );
  await spawned.promise;
  controller.abort();
  try {
    await expect(pending).rejects.toThrow("intelligence_refresh_aborted");
    expect(await store.count("publications")).toBe(0);
  } finally {
    Bun.spawn = originalSpawn;
    process.env.PATH = originalPath;
    await store.shutdownCoordinator();
  }
});

test("shares a bounded transaction lock across processes and workspace identities", async () => {
  const root = await temporary();
  const workspace = fakeWorkspace(root, "parent");
  const otherWorkspace = fakeWorkspace(root, "child");
  const service = new URL(
    "../../src/intelligence/mutation/service.ts",
    import.meta.url,
  ).href;
  const context = new URL(
    "../../src/intelligence/workspace/context.ts",
    import.meta.url,
  ).href;
  await withWorkspaceContext(workspace, () =>
    withLanceMutationLifecycle(async () => {
      const script = `
          import { withLanceMutationLifecycle } from ${JSON.stringify(service)};
          import { withWorkspaceContext } from ${JSON.stringify(context)};
          await withWorkspaceContext(${JSON.stringify(otherWorkspace)}, () =>
            withLanceMutationLifecycle(async () => console.log("entered"), {
              deadline: Date.now() + 100
            })
          ).catch(error => console.log(error.code));
        `;
      const child = Bun.spawn([process.execPath, "--eval", script], {
        stderr: "pipe",
        stdout: "pipe",
      });
      const [output, errors, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(errors).toBe("");
      expect(exit).toBe(0);
      expect(output.trim()).toBe("lock_deadline");
    }),
  );
});

test("crashed file owners are recovered before their metadata expires", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-file-crash-"));
  const target = path.join(root, "target");
  const modulePath = Bun.fileURLToPath(
    new URL("../../src/intelligence/mutation/locks.ts", import.meta.url),
  );
  const child = Bun.spawn(
    [
      process.execPath,
      "--eval",
      `
    import { acquireFileLock } from ${JSON.stringify(modulePath)};
    await acquireFileLock(${JSON.stringify(target)}, { leaseMs: 60_000 });
    console.log("ready");
    await new Promise(resolve => process.stdin.once("data", resolve));
  `,
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    const reader = child.stdout.getReader();
    const ready = await reader.read();
    reader.releaseLock();
    expect(new TextDecoder().decode(ready.value).trim()).toBe("ready");
    child.kill("SIGKILL");
    await child.exited;
    const successor = await acquireFileLock(target, {
      deadline: Date.now() + 1000,
    });
    try {
      expect(successor.epoch).toBeGreaterThan(1);
      await successor.fence();
    } finally {
      await successor.release();
    }
  } finally {
    clearTimeout(timer);
    child.kill("SIGKILL");
    await child.exited;
    await rm(root, { recursive: true, force: true });
  }
});

test("checkout locks remain shared across temporary and home environment overrides", async () => {
  const checkout = await temporary();
  const lockPath = await mutationTransactionLockPath(checkout);
  const owner = await acquireFileLock(lockPath, { leaseMs: 30_000 });
  const childTemporary = await temporary();
  const modulePath = Bun.fileURLToPath(
    new URL("../../src/intelligence/mutation/service.ts", import.meta.url),
  );
  const locksPath = Bun.fileURLToPath(
    new URL("../../src/intelligence/mutation/locks.ts", import.meta.url),
  );
  const script = `
    import { mutationTransactionLockPath } from ${JSON.stringify(modulePath)};
    import { acquireFileLock } from ${JSON.stringify(locksPath)};
    const target = await mutationTransactionLockPath(${JSON.stringify(checkout)});
    if (target !== ${JSON.stringify(lockPath)}) throw new Error("split checkout lock namespace");
    try {
      const lease = await acquireFileLock(target, { deadline: Date.now() + 100 });
      await lease.release();
      process.exit(2);
    } catch (error) {
      console.log(error.code);
      process.exit(error.code === "lock_deadline" ? 0 : 3);
    }
  `;
  try {
    const child = Bun.spawn([process.execPath, "-e", script], {
      env: {
        ...process.env,
        HOME: childTemporary,
        TMPDIR: childTemporary,
        TMP: childTemporary,
        TEMP: childTemporary,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(stderr).toBe("");
    expect(stdout.trim()).toBe("lock_deadline");
    expect(exit).toBe(0);
    await owner.fence();
  } finally {
    await owner.release();
  }
});
