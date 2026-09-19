import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fsPromises from "node:fs/promises";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { withConfig } from "../src/config.ts";
import {
  createRepositoryId,
  createRevisionId,
  createStorageDomainId,
  createWorkspaceId,
} from "../src/intelligence/contracts/index.ts";
import { refreshMutationIntelligence } from "../src/intelligence/mutation/freshness.ts";
import {
  activeMutationLifecycle,
  configureMutationLifecycle,
  type MutationBatchPlan,
  type MutationFileCommit,
  type MutationLifecycle,
  type MutationRefreshResult,
  withMutationLifecycle,
} from "../src/intelligence/mutation/index.ts";
import { LanceMutationJournal } from "../src/intelligence/mutation/journal.ts";
import {
  acquireFileLock,
  clearMutationLockQueuesForTests,
  mutationLockPath,
  withFencedFileLock,
  withFencedFileLocks,
} from "../src/intelligence/mutation/locks.ts";
import {
  LanceMutationLifecycle,
  mutationOperationId,
  withLanceMutationLifecycle,
} from "../src/intelligence/mutation/service.ts";
import { LanceIntelligenceStore } from "../src/intelligence/storage/store.ts";
import {
  type WorkspaceHandle,
  WorkspaceRegistry,
  withWorkspaceContext,
} from "../src/intelligence/workspace/index.ts";
import { patchFiles } from "../src/patch/engine.ts";
import { applyFileChattr } from "../src/runtime/attributes.ts";
import { deleteFilesSafely } from "../src/runtime/file-delete.ts";
import { renameFilesSafely } from "../src/runtime/file-rename.ts";
import { sha256 } from "../src/runtime/hash.ts";

const roots: string[] = [];

async function temporary(prefix = "ast-mcp-mutation-"): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(async () => {
  delete process.env.AST_MCP_ROOTS;
  delete process.env.AST_MCP_ALLOW_EXTERNAL_ROOTS;
  configureMutationLifecycle(null);
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

class RecordingLifecycle implements MutationLifecycle {
  events: string[] = [];
  failFailureRecord = false;
  failRefresh = false;
  plans: MutationBatchPlan[] = [];

  async begin(plan: MutationBatchPlan) {
    this.plans.push(plan);
    this.events.push("begin");
  }
  async committed(_operationId: string, file: MutationFileCommit) {
    this.events.push(`commit:${path.basename(file.filePath)}`);
  }
  async complete(): Promise<MutationRefreshResult> {
    this.events.push("complete");
    if (this.failRefresh) throw new Error("refresh failed");
    return {
      dirtyOverlayId: null,
      generationId: null,
      indexedAt: "2026-09-10T00:00:00.000Z",
      parsedFiles: [],
      skippedFiles: [],
    };
  }
  async failed() {
    this.events.push("failed");
    if (this.failFailureRecord) throw new Error("journal failed");
  }
  async rolledBack() {
    this.events.push("rolled-back");
  }
}

async function git(root: string, ...args: string[]): Promise<string> {
  const process = Bun.spawn(["git", "-C", root, ...args], {
    env: { ...globalThis.process.env, GIT_CONFIG_NOSYSTEM: "1" },
    stderr: "pipe",
    stdout: "pipe",
  });
  const stdout = await new Response(process.stdout).text();
  const stderr = await new Response(process.stderr).text();
  if ((await process.exited) !== 0) throw new Error(stderr);
  return stdout.trim();
}

describe("mutation locks", () => {
  test("serializes locks and supports deterministic multi-lock order", async () => {
    const root = await temporary();
    const first = path.join(root, "a.ts");
    const second = path.join(root, "b.ts");
    const events: string[] = [];
    const one = withFencedFileLock(first, async (lease) => {
      events.push("one");
      await lease.fence();
      await Bun.sleep(20);
      events.push("one-done");
    });
    const two = withFencedFileLock(first, async () => {
      events.push("two");
    });
    await Promise.all([one, two]);
    expect(events).toEqual(["one", "one-done", "two"]);
    expect(
      await withFencedFileLocks([second, first, second], async (leases) => {
        await Promise.all(leases.map((lease) => lease.fence()));
        return leases.map((lease) => lease.lockPath);
      }),
    ).toHaveLength(2);
  });

  test("honors cancellation and deadlines", async () => {
    const root = await temporary();
    const file = path.join(root, "value.ts");
    const held = await acquireFileLock(file);
    const abort = new AbortController();
    abort.abort();
    await expect(
      acquireFileLock(file, { signal: abort.signal }),
    ).rejects.toMatchObject({
      code: "lock_aborted",
    });
    await expect(
      acquireFileLock(file, { deadline: Date.now() - 1 }),
    ).rejects.toMatchObject({ code: "lock_deadline" });
    await expect(
      acquireFileLock(file, { deadline: new Date(Date.now() - 1) }),
    ).rejects.toMatchObject({ code: "lock_deadline" });
    await held.release();
  });

  test("recovers expired owners and fences their stale leases", async () => {
    const root = await temporary();
    const file = path.join(root, "value.ts");
    let clock = 1_000;
    const first = await acquireFileLock(file, {
      leaseMs: 100,
      now: () => clock,
      ownerId: "first",
    });
    clock = 2_000;
    const second = await acquireFileLock(file, {
      leaseMs: 100,
      now: () => clock,
      ownerId: "second",
    });
    expect(second.epoch).toBeGreaterThan(first.epoch);
    await expect(first.fence()).rejects.toMatchObject({ code: "lock_fenced" });
    await first.release();
    await second.fence();
    await second.release();
    expect(await Bun.file(await mutationLockPath(file)).exists()).toBeFalse();
  });

  test("keeps identical relative paths in separate worktrees independent", async () => {
    const root = await temporary();
    const first = path.join(root, "worktree-a", "src", "same.ts");
    const second = path.join(root, "worktree-b", "src", "same.ts");
    await Promise.all([
      mkdir(path.dirname(first), { recursive: true }),
      mkdir(path.dirname(second), { recursive: true }),
    ]);
    let active = 0;
    let maximum = 0;
    let firstEntered!: () => void;
    let releaseFirst!: () => void;
    let secondEntered!: () => void;
    const firstEnteredPromise = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    const releaseFirstPromise = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const secondEnteredPromise = new Promise<void>((resolve) => {
      secondEntered = resolve;
    });
    const firstLock = withFencedFileLock(first, async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      firstEntered();
      await releaseFirstPromise;
      active -= 1;
    });
    await firstEnteredPromise;
    const secondLock = withFencedFileLock(second, async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      secondEntered();
      active -= 1;
    });
    try {
      await Promise.race([
        secondEnteredPromise,
        Bun.sleep(5_000).then(() => {
          throw new Error("independent worktree lock did not start");
        }),
      ]);
    } finally {
      releaseFirst();
    }
    await Promise.all([firstLock, secondLock]);
    expect(maximum).toBe(2);
  });
});

describe("guarded patch integration", () => {
  test("journals commits and reports refresh before returning", async () => {
    const root = await temporary();
    process.env.AST_MCP_ROOTS = root;
    process.env.AST_MCP_ALLOW_EXTERNAL_ROOTS = "1";
    const file = path.join(root, "notes.txt");
    await writeFile(file, "before\n");
    const sourceMode = (await stat(file)).mode;
    const lifecycle = new RecordingLifecycle();
    configureMutationLifecycle(lifecycle);
    const result = await patchFiles({
      [file]: {
        aiderBlocks: [{ replace: "after", search: "before" }],
        expectedSha256: sha256("before\n"),
        patchStrategy: "aider_block",
      },
    });
    expect(await readFile(file, "utf8")).toBe("after\n");
    expect(lifecycle.events).toEqual(["begin", "commit:notes.txt", "complete"]);
    expect(lifecycle.plans[0]?.files[0]).toMatchObject({
      candidateSha256: sha256("after\n"),
      sourceMode,
      sourceSha256: sha256("before\n"),
    });
    expect(result.intelligenceRefresh).toBeDefined();
  });

  test("rolls back file replacements when refresh fails", async () => {
    const root = await temporary();
    process.env.AST_MCP_ROOTS = root;
    process.env.AST_MCP_ALLOW_EXTERNAL_ROOTS = "1";
    const file = path.join(root, "notes.txt");
    await writeFile(file, "before\n");
    const originalMode = (await stat(file)).mode & 0o777;
    const lifecycle = new RecordingLifecycle();
    lifecycle.failFailureRecord = true;
    lifecycle.failRefresh = true;
    configureMutationLifecycle(lifecycle);
    await expect(
      patchFiles({
        [file]: {
          aiderBlocks: [{ replace: "after", search: "before" }],
          expectedSha256: sha256("before\n"),
          patchStrategy: "aider_block",
        },
      }),
    ).rejects.toThrow("refresh failed");
    expect(await readFile(file, "utf8")).toBe("before\n");
    expect((await stat(file)).mode & 0o777).toBe(originalMode);
    expect(lifecycle.events).toEqual([
      "begin",
      "commit:notes.txt",
      "complete",
      "failed",
      "rolled-back",
    ]);
  }, 120_000);

  test("binds preview receipts to workspace and revision identity", async () => {
    const temporaryRoot = await temporary();
    const root = await realpath(temporaryRoot);
    process.env.AST_MCP_ROOTS = root;
    process.env.AST_MCP_ALLOW_EXTERNAL_ROOTS = "1";
    const file = path.join(root, "notes.txt");
    await writeFile(file, "before\n");
    const first = fakeWorkspace(root, "a");
    const second = fakeWorkspace(root, "b");
    const config = {
      cwd: root,
      env: {
        AST_MCP_ALLOW_EXTERNAL_ROOTS: "1",
        AST_MCP_ROOTS: root,
      },
    };
    const preview = await withConfig(config, () =>
      withWorkspaceContext(first, () =>
        patchFiles({
          [file]: {
            aiderBlocks: [{ replace: "after", search: "before" }],
            expectedSha256: sha256("before\n"),
            patchStrategy: "aider_block",
            preview: true,
          },
        }),
      ),
    );
    const receipt = (preview.files as Record<string, Record<string, unknown>>)[
      file
    ]?.previewReceipt as string;
    await expect(
      withConfig(config, () =>
        withWorkspaceContext(second, () =>
          patchFiles({
            [file]: {
              expectedSha256: sha256("before\n"),
              previewReceipt: receipt,
            },
          }),
        ),
      ),
    ).rejects.toThrow("different workspace or revision");
    expect(await readFile(file, "utf8")).toBe("before\n");
  });
});

describe("destructive mutation lifecycle", () => {
  test("rolls back deletes when freshness publication fails", async () => {
    const root = await realpath(await temporary());
    process.env.AST_MCP_ROOTS = root;
    process.env.AST_MCP_ALLOW_EXTERNAL_ROOTS = "1";
    const file = path.join(root, "nested", "value.txt");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "value\n");
    await chmod(file, 0o640);
    const originalMetadata = await stat(file);
    const workspace = fakeWorkspace(root, "delete");
    const lifecycle = new RecordingLifecycle();
    lifecycle.failRefresh = true;
    configureMutationLifecycle(lifecycle);
    await expect(
      withConfig(
        {
          cwd: root,
          env: {
            AST_MCP_ALLOW_EXTERNAL_ROOTS: "1",
            AST_MCP_ROOTS: root,
          },
        },
        () =>
          withWorkspaceContext(workspace, () =>
            deleteFilesSafely({
              [file]: { expectedSha256: sha256("value\n") },
            }),
          ),
      ),
    ).rejects.toThrow("refresh failed");
    expect(await readFile(file, "utf8")).toBe("value\n");
    const restoredMetadata = await stat(file);
    if (process.platform !== "win32")
      expect(restoredMetadata.mode & 0o777).toBe(0o640);
    if (process.platform !== "win32") {
      expect(restoredMetadata.uid).toBe(originalMetadata.uid);
      expect(restoredMetadata.gid).toBe(originalMetadata.gid);
    }
    expect(lifecycle.events).toContain("rolled-back");
  });

  test("retains durable recovery when delete ownership rollback fails", async () => {
    if (process.platform === "win32") return;
    const root = await realpath(await temporary());
    process.env.AST_MCP_ROOTS = root;
    process.env.AST_MCP_ALLOW_EXTERNAL_ROOTS = "1";
    const file = path.join(root, "ownership.txt");
    await writeFile(file, "value\n");
    await chmod(file, 0o640);
    const workspace = fakeWorkspace(root, "delete-owner-failure");
    const store = await LanceIntelligenceStore.open(workspace.storageDomain);
    const lifecycle = new LanceMutationLifecycle(store, workspace, async () => {
      throw new Error("refresh failed");
    });
    configureMutationLifecycle(lifecycle);
    const chown = spyOn(fsPromises, "chown").mockRejectedValueOnce(
      new Error("ownership restore denied"),
    );
    try {
      await expect(
        withConfig(
          {
            cwd: root,
            env: {
              AST_MCP_ALLOW_EXTERNAL_ROOTS: "1",
              AST_MCP_ROOTS: root,
            },
          },
          () =>
            withWorkspaceContext(workspace, () =>
              deleteFilesSafely({
                [file]: { expectedSha256: sha256("value\n") },
              }),
            ),
        ),
      ).rejects.toThrow("rollback requires recovery");
      expect(await readFile(file, "utf8")).toBe("value\n");
      const unfinished = await lifecycle.journal.unfinished(
        workspace.workspaceId,
      );
      expect(unfinished).toHaveLength(1);
      expect(unfinished[0]?.tool).toBe("file_delete");
      expect(unfinished[0]?.state).toBe("failed");
      if (unfinished[0])
        await lifecycle.journal.transition(
          unfinished[0].operationId,
          "rolled-back",
        );
    } finally {
      chown.mockRestore();
      await store.shutdownCoordinator();
    }
  });

  test("rolls back renames when freshness publication fails", async () => {
    const root = await realpath(await temporary());
    process.env.AST_MCP_ROOTS = root;
    process.env.AST_MCP_ALLOW_EXTERNAL_ROOTS = "1";
    const source = path.join(root, "source.txt");
    const destination = path.join(root, "destination.txt");
    await writeFile(source, "value\n");
    const workspace = fakeWorkspace(root, "rename");
    const lifecycle = new RecordingLifecycle();
    lifecycle.failRefresh = true;
    configureMutationLifecycle(lifecycle);
    await expect(
      withConfig(
        {
          cwd: root,
          env: {
            AST_MCP_ALLOW_EXTERNAL_ROOTS: "1",
            AST_MCP_ROOTS: root,
          },
        },
        () =>
          withWorkspaceContext(workspace, () =>
            renameFilesSafely({
              [source]: {
                destination,
                expectedSha256: sha256("value\n"),
              },
            }),
          ),
      ),
    ).rejects.toThrow("refresh failed");
    expect(await readFile(source, "utf8")).toBe("value\n");
    expect(await Bun.file(destination).exists()).toBeFalse();
    expect(lifecycle.events).toContain("rolled-back");
  });
});

describe("LanceDB mutation journal and freshness", () => {
  test("persists journal transitions and recovers unfinished records", async () => {
    const root = await temporary();
    await mkdir(path.join(root, ".git"));
    const workspace = fakeWorkspace(root, "c");
    const store = await LanceIntelligenceStore.open(workspace.storageDomain);
    const operationId = mutationOperationId({
      files: [],
      nonce: "one",
      storageDomainId: workspace.storageDomain.domainId,
      workspaceId: workspace.workspaceId,
    });
    const journal = new LanceMutationJournal(
      store,
      () => new Date("2026-09-10T00:00:00.000Z"),
    );
    const firstFile = path.join(root, "first.ts");
    const secondFile = path.join(root, "second.ts");
    await journal.begin({
      files: [
        {
          candidateSha256: "b".repeat(64),
          filePath: firstFile,
          sourceSha256: "a".repeat(64),
        },
        {
          candidateSha256: "d".repeat(64),
          filePath: secondFile,
          sourceSha256: "c".repeat(64),
        },
      ],
      operationId,
      tool: "file_patch",
      workspace,
    });
    await journal.committed(operationId, {
      filePath: firstFile,
      sha256: "e".repeat(64),
    });
    expect((await journal.get(operationId))?.files).toMatchObject([
      { committedSha256: "e".repeat(64) },
      { committedSha256: null },
    ]);
    await journal.transition(operationId, "failed", "rollback_failed");
    expect(await journal.unfinished(workspace.workspaceId)).toHaveLength(1);
    expect(
      await journal.recover(workspace.workspaceId, async () => {}),
    ).toEqual([operationId]);
    const recovered = await journal.get(operationId);
    expect(recovered?.state).toBe("recovered");
    await store.putRows(
      "jobs",
      [
        {
          attempt: recovered?.attempt ?? 0,
          created_at: recovered?.createdAt ?? "",
          error_code: null,
          idempotency_key: operationId,
          job_id: operationId,
          payload_json: JSON.stringify({ ...recovered, unexpected: true }),
          revision_id: workspace.selectedRevision.revisionId,
          state: "succeeded",
          storage_domain_id: workspace.storageDomain.domainId,
          type: "index-source",
          updated_at: recovered?.updatedAt ?? "",
          workspace_id: workspace.workspaceId,
        },
      ],
      { immutable: false },
    );
    await expect(journal.get(operationId)).rejects.toThrow(
      "mutation_journal_malformed",
    );
    await store.shutdownCoordinator();
  });

  test("durable recovery refuses a journal path through an escaping link", async () => {
    const root = await temporary();
    const outside = await temporary();
    await mkdir(path.join(root, ".git"));
    const alias = path.join(root, "alias");
    await symlink(
      outside,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    const externalFile = path.join(outside, "created.bin");
    await writeFile(externalFile, "candidate\n");
    const workspace = fakeWorkspace(root, "escaping-recovery");
    const store = await LanceIntelligenceStore.open(workspace.storageDomain);
    const lifecycle = new LanceMutationLifecycle(store, workspace);
    const operationId = mutationOperationId({
      files: [],
      nonce: "escaping-recovery",
      storageDomainId: workspace.storageDomain.domainId,
      workspaceId: workspace.workspaceId,
    });
    await lifecycle.journal.begin({
      files: [
        {
          candidateSha256: sha256("candidate\n"),
          filePath: path.join(alias, "created.bin"),
          sourceContentBase64: null,
          sourceSha256: null,
        },
      ],
      operationId,
      tool: "file_write",
      workspace,
    });
    await lifecycle.journal.transition(operationId, "recovery-required");
    await expect(lifecycle.recover()).rejects.toThrow(
      "mutation_recovery_required",
    );
    expect(await readFile(externalFile, "utf8")).toBe("candidate\n");
    expect((await lifecycle.journal.get(operationId))?.state).toBe(
      "recovery-required",
    );
    await store.shutdownCoordinator();
  });

  test.skipIf(process.platform !== "win32")(
    "Windows durable recovery rejects unsupported owner metadata before changing bytes",
    async () => {
      const root = await temporary();
      await mkdir(path.join(root, ".git"));
      const file = path.join(root, "value.bin");
      await writeFile(file, "candidate\n");
      const workspace = fakeWorkspace(root, "unsupported-owner");
      const store = await LanceIntelligenceStore.open(workspace.storageDomain);
      const lifecycle = new LanceMutationLifecycle(store, workspace);
      const operationId = mutationOperationId({
        files: [],
        nonce: "unsupported-owner",
        storageDomainId: workspace.storageDomain.domainId,
        workspaceId: workspace.workspaceId,
      });
      await lifecycle.journal.begin({
        files: [
          {
            candidateSha256: sha256("candidate\n"),
            filePath: file,
            sourceContentBase64: Buffer.from("source\n").toString("base64"),
            sourceGid: 0,
            sourceMode: 0o444,
            sourceSha256: sha256("source\n"),
            sourceUid: 0,
          },
        ],
        operationId,
        tool: "file_patch",
        workspace,
      });
      await lifecycle.journal.transition(operationId, "recovery-required");
      await expect(lifecycle.recover()).rejects.toThrow(
        "mutation_recovery_required",
      );
      expect(await readFile(file, "utf8")).toBe("candidate\n");
      await store.shutdownCoordinator();
    },
  );

  test("mode failure restores attributes without an ownership call", async () => {
    const root = await temporary();
    const file = path.join(root, "mode.txt");
    await writeFile(file, "value\n");
    const beforeMode = (await stat(file)).mode & 0o777;
    const chownSpy = spyOn(fsPromises, "chown").mockRejectedValue(
      new Error("ownership unsupported"),
    );
    const chmodSpy = spyOn(fsPromises, "chmod").mockRejectedValueOnce(
      new Error("mode denied"),
    );
    try {
      await expect(applyFileChattr(file, { chmod: 0o444 })).rejects.toThrow(
        "mode denied",
      );
      expect(chownSpy).not.toHaveBeenCalled();
      expect((await stat(file)).mode & 0o777).toBe(beforeMode);
    } finally {
      chmodSpy.mockRestore();
      chownSpy.mockRestore();
    }
  });

  test("lifecycle rejects coordinate drift and persists successful refresh", async () => {
    const root = await temporary();
    await mkdir(path.join(root, ".git"));
    const workspace = fakeWorkspace(root, "d");
    const store = await LanceIntelligenceStore.open(workspace.storageDomain);
    const refresh: typeof refreshMutationIntelligence = async () => ({
      dirtyOverlayId: null,
      generationId: null,
      indexedAt: "2026-09-10T00:00:00.000Z",
      parsedFiles: [],
      skippedFiles: [],
    });
    const lifecycle = new LanceMutationLifecycle(store, workspace, refresh);
    const operationId = mutationOperationId({
      files: [],
      nonce: "two",
      storageDomainId: workspace.storageDomain.domainId,
      workspaceId: workspace.workspaceId,
    });
    await expect(
      lifecycle.begin({
        files: [],
        operationId,
        tool: "file_patch",
        workspace: fakeWorkspace(root, "e"),
      }),
    ).rejects.toThrow("mutation_workspace_mismatch");
    await lifecycle.begin({
      files: [],
      operationId,
      tool: "file_patch",
      workspace,
    });
    await lifecycle.committed(operationId, {
      filePath: path.join(root, "value.ts"),
      sha256: "f".repeat(64),
    });
    expect(
      await lifecycle.complete(operationId, [
        {
          filePath: path.join(root, "value.ts"),
          sha256: "f".repeat(64),
        },
      ]),
    ).toMatchObject({ indexedAt: "2026-09-10T00:00:00.000Z" });
    expect((await lifecycle.journal.get(operationId))?.state).toBe("succeeded");
    await store.shutdownCoordinator();
  });

  test("refreshes overlay, syntax facts, and graph rows immediately", async () => {
    const root = await temporary();
    await git(root, "init");
    await git(root, "config", "user.email", "test@example.com");
    await git(root, "config", "user.name", "Test");
    const file = path.join(root, "value.ts");
    const stableFile = path.join(root, "stable.ts");
    const unsupportedFile = path.join(root, "notes.unsupported");
    const documents = new Map([
      ["notes.md", "# Notes\n\nSee [value](./value.ts).\n"],
      ["notes.txt", "Plain text notes.\n"],
      ["notes.rtf", "{\\rtf1\\ansi Rich text notes.}"],
      ["notes.json", '{"title":"JSON notes"}\n'],
      ["notes.jsonc", '{\n  // comment\n  "title": "JSONC notes"\n}\n'],
      ["notes.yaml", "title: YAML notes\n"],
      ["notes.toml", 'title = "TOML notes"\n'],
      ["notes.xml", "<notes><title>XML notes</title></notes>\n"],
      ["notes.html", "<h1>HTML notes</h1>\n"],
      ["notes.mdx", "# MDX notes\n\n<Component />\n"],
    ]);
    await writeFile(file, "export const value = 1;\n");
    await writeFile(stableFile, "export const stable = true;\n");
    await writeFile(unsupportedFile, "plain text\n");
    await Promise.all(
      [...documents].map(([name, content]) =>
        writeFile(path.join(root, name), content),
      ),
    );
    await git(
      root,
      "add",
      "value.ts",
      "stable.ts",
      "notes.unsupported",
      ...documents.keys(),
    );
    await git(root, "commit", "-m", "initial");
    const storagePath = path.join(root, ".index");
    const registry = new WorkspaceRegistry();
    const workspace = await registry.open({
      configurationGeneration: 1,
      directory: root,
      storage: { kind: "explicit", path: storagePath },
    });
    const store = await LanceIntelligenceStore.open(workspace.storageDomain, {
      leaseDurationMs: 60_000,
    });
    await writeFile(
      file,
      "export const value = helper();\nfunction helper() { return 2; }\n",
    );
    const result = await withWorkspaceContext(workspace, () =>
      refreshMutationIntelligence({
        now: () => new Date("2026-09-10T00:00:00.000Z"),
        store,
        workspace,
      }),
    );
    expect(result.dirtyOverlayId).toStartWith("dirty-overlay:v1:");
    expect(result.generationId).toStartWith("generation:v1:");
    const expectedParsedFiles = [
      ...documents.keys(),
      "stable.ts",
      "value.ts",
    ].sort();
    expect(result.parsedFiles).toEqual(expectedParsedFiles);
    expect(await store.count("syntax_facts")).toBe(documents.size + 2);
    expect(await store.count("chunks")).toBeGreaterThan(0);
    expect(await store.count("relationships")).toBeGreaterThan(0);
    expect(await store.count("graph_nodes")).toBeGreaterThan(1);
    expect(await store.count("dirty_overlays")).toBe(1);
    const published = (await store.rows("publications"))[0];
    expect(published?.state).toBe("published");
    const manifest = (await store.rows("revision_manifests")).find(
      (row) => row.artifact_id === published?.manifest_artifact_id,
    );
    const manifestEntries = (
      JSON.parse(String(manifest?.payload_json)) as {
        entries: Array<{ resolvedRelationshipsArtifactId: string | null }>;
      }
    ).entries;
    expect(manifestEntries).toHaveLength(expectedParsedFiles.length);
    expect(
      manifestEntries.every(
        ({ resolvedRelationshipsArtifactId }) =>
          resolvedRelationshipsArtifactId?.startsWith(
            "resolved-relationships:v1:",
          ) === true,
      ),
    ).toBeTrue();
    expect(
      new Set(
        (
          JSON.parse(String(published?.payload_json)) as {
            requiredTables: string[];
          }
        ).requiredTables,
      ),
    ).toEqual(
      new Set([
        "artifacts",
        "syntax_facts",
        "chunks",
        "relationships",
        "dirty_overlays",
        "revision_manifests",
        "graph_nodes",
        "graph_occurrences",
        "graph_edges",
        "graph_evidence",
        "revision_membership",
      ]),
    );

    await writeFile(
      file,
      "export const value = helper();\nfunction helper() { return 3; }\n",
    );
    const finalizePublication = store.finalizePublication.bind(store);
    store.finalizePublication = async () => {
      throw new Error("finalize failed");
    };
    await expect(
      withWorkspaceContext(workspace, () =>
        refreshMutationIntelligence({ store, workspace }),
      ),
    ).rejects.toThrow("finalize failed");
    expect(
      (await store.rows("publications")).map((row) => row.state).sort(),
    ).toEqual(["abandoned", "published"]);
    store.finalizePublication = finalizePublication;

    const readPaths: string[] = [];
    const skipped = await withWorkspaceContext(workspace, () =>
      refreshMutationIntelligence({
        readSource: async (filePath) => {
          readPaths.push(filePath);
          return readFile(filePath, "utf8");
        },
        store,
        workspace,
      }),
    );
    expect(skipped.generationId).toStartWith("generation:v1:");
    expect(skipped.parsedFiles).toEqual(expectedParsedFiles);
    expect(skipped.skippedFiles).toContain("notes.unsupported");
    expect(readPaths).not.toContain(unsupportedFile);

    const aborted = new AbortController();
    aborted.abort();
    await expect(
      withWorkspaceContext(workspace, () =>
        refreshMutationIntelligence({
          signal: aborted.signal,
          store,
          workspace,
        }),
      ),
    ).rejects.toThrow("intelligence_refresh_aborted");

    const publicationCount = await store.count("publications");
    const duringRefresh = new AbortController();
    let reads = 0;
    await expect(
      withWorkspaceContext(workspace, () =>
        refreshMutationIntelligence({
          readSource: async (filePath) => {
            reads += 1;
            duringRefresh.abort();
            return readFile(filePath, "utf8");
          },
          signal: duringRefresh.signal,
          store,
          workspace,
        }),
      ),
    ).rejects.toThrow("intelligence_refresh_aborted");
    expect(reads).toBe(1);
    expect(await store.count("publications")).toBe(publicationCount);
    await store.shutdownCoordinator();
  });

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
      await writeFile(
        fakeGit,
        "#!/bin/sh\ntrap '' TERM\nwhile :; do :; done\n",
      );
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
    const startedAt = performance.now();
    const pending = withWorkspaceContext(workspace, () =>
      refreshMutationIntelligence({
        signal: controller.signal,
        store,
        workspace,
      }),
    );
    setTimeout(() => controller.abort(), 20);
    try {
      await expect(pending).rejects.toThrow("intelligence_refresh_aborted");
      expect(performance.now() - startedAt).toBeLessThan(1_000);
      expect(await store.count("publications")).toBe(0);
    } finally {
      Bun.spawn = originalSpawn;
      process.env.PATH = originalPath;
      await store.shutdownCoordinator();
    }
  });
});

describe("mutation recovery edges", () => {
  test("fails closed for malformed locks and handles empty batches", async () => {
    const root = await temporary();
    const file = path.join(root, "missing", "value.ts");
    const lock = await mutationLockPath(file);
    await writeFile(lock, "not-json");
    await expect(acquireFileLock(file)).rejects.toMatchObject({
      code: "lock_record_malformed",
      retryable: false,
    });
    expect(await Bun.file(lock).exists()).toBeTrue();
    await writeFile(lock, JSON.stringify({ createdAt: 1 }));
    await expect(acquireFileLock(file)).rejects.toMatchObject({
      code: "lock_record_malformed",
    });
    await rm(lock);
    await writeFile(lock, "");
    const initialized = await acquireFileLock(file, { pollMs: 5 });
    expect(JSON.parse(await readFile(lock, "utf8"))).toMatchObject({
      token: initialized.token,
    });
    await initialized.release();
    expect(await Bun.file(lock).exists()).toBeFalse();
    await writeFile(lock, "stale");
    await withFencedFileLocks([lock], async (leases) => {
      expect(leases).toHaveLength(0);
      await rm(lock);
    });
    expect(await Bun.file(lock).exists()).toBeFalse();
    expect(await Bun.file(`${lock}.ast-mcp.lock`).exists()).toBeFalse();
    expect(await mutationLockPath(path.join(root, ".hidden"))).toBe(
      path.join(root, ".hidden.ast-mcp.lock"),
    );
    const pending = `${lock}.pending-orphan`;
    await writeFile(pending, "orphan");
    const expired = new Date(Date.now() - 120_000);
    await utimes(pending, expired, expired);
    const cleanupLease = await acquireFileLock(file);
    await cleanupLease.release();
    expect(await Bun.file(pending).exists()).toBeFalse();

    const stolen = await acquireFileLock(file);
    const replacement = {
      ...JSON.parse(await readFile(lock, "utf8")),
      token: "replacement-owner",
    };
    await writeFile(lock, JSON.stringify(replacement));
    await stolen.release();
    expect(JSON.parse(await readFile(lock, "utf8"))).toMatchObject({
      token: "replacement-owner",
    });
    await rm(lock);

    expect(await withFencedFileLocks([], async (leases) => leases.length)).toBe(
      0,
    );
    clearMutationLockQueuesForTests();
  });

  test("propagates lock filesystem failures and renewal races", async () => {
    const root = await temporary();
    const file = path.join(root, "value.ts");
    const lock = await mutationLockPath(file);
    const denied = Object.assign(new Error("lock filesystem denied"), {
      code: "EACCES",
    });

    const readdir = spyOn(fsPromises, "readdir").mockRejectedValueOnce(denied);
    try {
      await expect(acquireFileLock(file)).rejects.toThrow(
        "lock filesystem denied",
      );
    } finally {
      readdir.mockRestore();
    }

    await writeFile(lock, "record");
    const read = spyOn(Bun, "file").mockImplementationOnce((() => ({
      text: async () => {
        throw denied;
      },
    })) as unknown as typeof Bun.file);
    try {
      await expect(acquireFileLock(file)).rejects.toThrow(
        "lock filesystem denied",
      );
    } finally {
      read.mockRestore();
    }
    await rm(lock);

    const releaseFailure = await acquireFileLock(file);
    const renameFailure = spyOn(fsPromises, "rename").mockRejectedValueOnce(
      denied,
    );
    try {
      await expect(releaseFailure.release()).rejects.toThrow(
        "lock filesystem denied",
      );
    } finally {
      renameFailure.mockRestore();
    }
    await rm(lock, { force: true });

    const raced = await acquireFileLock(file);
    const actualRename = fsPromises.rename.bind(fsPromises);
    const renameRace = spyOn(fsPromises, "rename").mockImplementation(
      async (oldPath, newPath) => {
        await actualRename(oldPath, newPath);
        if (
          oldPath.toString() === raced.lockPath &&
          newPath.toString().includes(".stale-")
        ) {
          const active = JSON.parse(await readFile(newPath, "utf8"));
          await writeFile(
            raced.lockPath,
            JSON.stringify({ ...active, token: "racing-owner" }),
          );
        }
      },
    );
    try {
      await expect(raced.renew()).rejects.toMatchObject({
        code: "lock_fenced",
      });
    } finally {
      renameRace.mockRestore();
    }
    await raced.release();
    await rm(lock, { force: true });
  });

  test("renews active leases and fences expired renewal", async () => {
    const root = await temporary();
    const file = path.join(root, "value.ts");
    await withFencedFileLock(
      file,
      async (lease) => {
        const initialExpiry = lease.expiresAt;
        await Bun.sleep(600);
        expect(lease.expiresAt).toBeGreaterThan(initialExpiry);
        await lease.fence();
      },
      { leaseMs: 1_500 },
    );

    let clock = 1_000;
    const expired = await acquireFileLock(file, {
      leaseMs: 100,
      now: () => clock,
    });
    clock = 1_101;
    await expect(expired.renew()).rejects.toMatchObject({
      code: "lock_fenced",
    });
    await expired.release();
    await expect(expired.renew()).rejects.toMatchObject({
      code: "lock_fenced",
    });
  });

  test("cancels while waiting on an active owner", async () => {
    const root = await temporary();
    const file = path.join(root, "value.ts");
    let clock = 1_000;
    const held = await acquireFileLock(file, {
      leaseMs: 100,
      now: () => clock,
    });
    clock = 1_050;
    expect(held.expiresAt).toBe(1_100);
    await held.renew();
    expect(held.expiresAt).toBe(1_150);
    const abort = new AbortController();
    const waiting = acquireFileLock(file, {
      now: () => clock,
      pollMs: 50,
      signal: abort.signal,
    });
    setTimeout(() => abort.abort(), 5);
    await expect(waiting).rejects.toMatchObject({ code: "lock_aborted" });
    await held.release();
  });

  test("records lifecycle failure paths and unknown operations", async () => {
    const root = await temporary();
    await mkdir(path.join(root, ".git"));
    const workspace = fakeWorkspace(root, "f");
    const store = await LanceIntelligenceStore.open(workspace.storageDomain);
    const failure = Object.assign(new Error("index failed"), {
      code: "index_failed",
    });
    const lifecycle = new LanceMutationLifecycle(store, workspace, async () => {
      throw failure;
    });
    const operationId = mutationOperationId({
      files: [],
      nonce: "failure",
      storageDomainId: workspace.storageDomain.domainId,
      workspaceId: workspace.workspaceId,
    });
    await expect(
      lifecycle.committed(`job:v1:${"a".repeat(64)}`, {
        filePath: path.join(root, "none"),
        sha256: "a".repeat(64),
      }),
    ).rejects.toThrow("mutation_operation_unknown");
    await expect(
      lifecycle.complete(`job:v1:${"a".repeat(64)}`, []),
    ).rejects.toThrow("mutation_operation_unknown");
    await lifecycle.begin({
      files: [],
      operationId,
      tool: "file_patch",
      workspace,
    });
    await expect(lifecycle.complete(operationId, [])).rejects.toThrow(
      "index failed",
    );
    expect((await lifecycle.journal.get(operationId))?.state).toBe(
      "recovery-required",
    );
    await lifecycle.failed(operationId, failure);
    await lifecycle.rolledBack(operationId);
    const literalOperationId = mutationOperationId({
      files: [],
      nonce: "literal-failure",
      storageDomainId: workspace.storageDomain.domainId,
      workspaceId: workspace.workspaceId,
    });
    await lifecycle.begin({
      files: [],
      operationId: literalOperationId,
      tool: "file_patch",
      workspace,
    });
    await lifecycle.failed(literalOperationId, "literal");
    await lifecycle.rolledBack(literalOperationId);
    expect((await lifecycle.journal.get(operationId))?.state).toBe(
      "rolled-back",
    );
    await store.shutdownCoordinator();
  });

  test("restores and verifies durable interrupted mutation material", async () => {
    const root = await temporary();
    await mkdir(path.join(root, ".git"));
    const workspace = fakeWorkspace(root, "durable-recovery");
    const store = await LanceIntelligenceStore.open(workspace.storageDomain);
    const lifecycle = new LanceMutationLifecycle(store, workspace);
    const restoredPath = path.join(root, "restored.bin");
    const removedPath = path.join(root, "created.bin");
    const source = Buffer.from([0, 255, 1, 2]);
    const candidate = Buffer.from([3, 254, 4, 5]);
    await writeFile(restoredPath, candidate);
    await writeFile(removedPath, candidate);
    await chmod(restoredPath, 0o600);
    const originalOwner = await stat(restoredPath);
    const ownershipSupported =
      process.platform !== "win32" &&
      process.getuid !== undefined &&
      process.getgid !== undefined;
    const sourceMode = process.platform === "win32" ? 0o444 : 0o640;
    const operationId = mutationOperationId({
      files: [],
      nonce: "durable-recovery",
      storageDomainId: workspace.storageDomain.domainId,
      workspaceId: workspace.workspaceId,
    });
    await lifecycle.journal.begin({
      files: [
        {
          candidateSha256: sha256(candidate),
          filePath: restoredPath,
          sourceContentBase64: source.toString("base64"),
          sourceGid: ownershipSupported ? originalOwner.gid : null,
          sourceMode,
          sourceSha256: sha256(source),
          sourceUid: ownershipSupported ? originalOwner.uid : null,
        },
        {
          candidateSha256: sha256(candidate),
          filePath: removedPath,
          sourceContentBase64: null,
          sourceGid: null,
          sourceMode: null,
          sourceSha256: null,
          sourceUid: null,
        },
      ],
      operationId,
      tool: "file_patch",
      workspace,
    });
    await lifecycle.journal.committed(operationId, {
      filePath: restoredPath,
      sha256: sha256(candidate),
    });
    await lifecycle.journal.committed(operationId, {
      filePath: removedPath,
      sha256: sha256(candidate),
    });
    await lifecycle.journal.transition(operationId, "recovery-required");
    await lifecycle.recover();
    expect(await readFile(restoredPath)).toEqual(source);
    const restoredMetadata = await stat(restoredPath);
    if (process.platform === "win32")
      expect(restoredMetadata.mode & 0o222).toBe(0);
    else expect(restoredMetadata.mode & 0o777).toBe(sourceMode);
    if (ownershipSupported) {
      expect(restoredMetadata.uid).toBe(originalOwner.uid);
      expect(restoredMetadata.gid).toBe(originalOwner.gid);
    }
    expect(await Bun.file(removedPath).exists()).toBeFalse();
    expect((await lifecycle.journal.get(operationId))?.state).toBe("recovered");

    const partialOperationId = mutationOperationId({
      files: [],
      nonce: "durable-attribute-partial",
      storageDomainId: workspace.storageDomain.domainId,
      workspaceId: workspace.workspaceId,
    });
    await lifecycle.journal.begin({
      files: [
        {
          candidateSha256: sha256(source),
          filePath: restoredPath,
          sourceContentBase64: source.toString("base64"),
          sourceGid: ownershipSupported ? originalOwner.gid : null,
          sourceMode,
          sourceSha256: sha256(source),
          sourceUid: ownershipSupported ? originalOwner.uid : null,
        },
      ],
      operationId: partialOperationId,
      tool: "file_chattr",
      workspace,
    });
    await lifecycle.journal.committed(partialOperationId, {
      filePath: restoredPath,
      sha256: sha256(source),
    });
    await chmod(restoredPath, 0o600);
    await lifecycle.journal.transition(partialOperationId, "failed");
    await lifecycle.recover();
    const recoveredAttributes = await stat(restoredPath);
    if (process.platform === "win32")
      expect(recoveredAttributes.mode & 0o222).toBe(0);
    else expect(recoveredAttributes.mode & 0o777).toBe(sourceMode);
    if (ownershipSupported) {
      expect(recoveredAttributes.uid).toBe(originalOwner.uid);
      expect(recoveredAttributes.gid).toBe(originalOwner.gid);
    }
    expect((await lifecycle.journal.get(partialOperationId))?.state).toBe(
      "recovered",
    );

    const mismatchOperationId = mutationOperationId({
      files: [],
      nonce: "durable-recovery-mismatch",
      storageDomainId: workspace.storageDomain.domainId,
      workspaceId: workspace.workspaceId,
    });
    await chmod(restoredPath, 0o600);
    await writeFile(restoredPath, "unrecognized concurrent bytes");
    await lifecycle.journal.begin({
      files: [
        {
          candidateSha256: sha256(candidate),
          filePath: restoredPath,
          sourceContentBase64: source.toString("base64"),
          sourceMode,
          sourceSha256: sha256(source),
        },
      ],
      operationId: mismatchOperationId,
      tool: "file_patch",
      workspace,
    });
    await lifecycle.journal.committed(mismatchOperationId, {
      filePath: restoredPath,
      sha256: sha256(candidate),
    });
    await expect(lifecycle.recover()).rejects.toThrow(
      "mutation_recovery_required",
    );
    expect((await lifecycle.journal.get(mismatchOperationId))?.state).toBe(
      "recovery-required",
    );
    expect(await readFile(restoredPath, "utf8")).toBe(
      "unrecognized concurrent bytes",
    );
    await lifecycle.journal.transition(mismatchOperationId, "rolled-back");
    await store.shutdownCoordinator();
  });

  test("installs a Lance lifecycle for each workspace request", async () => {
    expect(
      await withLanceMutationLifecycle(async () => "without-workspace"),
    ).toBe("without-workspace");
    const root = await temporary();
    await mkdir(path.join(root, ".git"));
    const workspace = fakeWorkspace(root, "request");
    expect(
      await withWorkspaceContext(workspace, () =>
        withLanceMutationLifecycle(
          async () =>
            activeMutationLifecycle() instanceof LanceMutationLifecycle,
        ),
      ),
    ).toBeTrue();
    expect(activeMutationLifecycle()).toBeNull();

    const configured = new RecordingLifecycle();
    configureMutationLifecycle(configured);
    expect(
      await withWorkspaceContext(workspace, () =>
        withLanceMutationLifecycle(async () => activeMutationLifecycle()),
      ),
    ).toBe(configured);
    configureMutationLifecycle(null);
  });

  test("isolates concurrent request lifecycles", async () => {
    const first = new RecordingLifecycle();
    const second = new RecordingLifecycle();
    const seen = await Promise.all([
      withMutationLifecycle(first, async () => {
        await Bun.sleep(5);
        return activeMutationLifecycle();
      }),
      withMutationLifecycle(second, async () => activeMutationLifecycle()),
    ]);
    expect(seen).toEqual([first, second]);
    expect(activeMutationLifecycle()).toBeNull();
  });

  test("keeps lifecycle restoration scoped", () => {
    const first = new RecordingLifecycle();
    const second = new RecordingLifecycle();
    const restore = configureMutationLifecycle(first);
    expect(activeMutationLifecycle()).toBe(first);
    configureMutationLifecycle(second);
    restore();
    expect(activeMutationLifecycle()).toBe(second);
    configureMutationLifecycle(null);
    expect(activeMutationLifecycle()).toBeNull();
  });
});
