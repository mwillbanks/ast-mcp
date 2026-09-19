import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { withConfig } from "../src/config.ts";
import {
  discoverGitWorkspace,
  gitDirtyOverlayId,
  gitWorkingState,
  parseGitPorcelainV1Z,
  readGitRevisionFile,
  runGitRaw,
  WorkspaceRegistry,
  withWorkspaceContext,
} from "../src/intelligence/workspace/index.ts";
import { hashFilesSafely, readFileSafely } from "../src/runtime/file-read.ts";
import { sha256 } from "../src/runtime/hash.ts";
import { resolveWritablePath } from "../src/runtime/paths.ts";
import { hermeticConfig } from "./support/hermetic-config.ts";

const created: string[] = [];

async function temporary(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  created.push(root);
  return root;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_EMAIL: "ast-mcp@example.com",
      GIT_AUTHOR_NAME: "ast-mcp",
      GIT_COMMITTER_EMAIL: "ast-mcp@example.com",
      GIT_COMMITTER_NAME: "ast-mcp",
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [code, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  if (code !== 0) throw new Error(stderr);
  return stdout.trim();
}

async function repository() {
  const root = await temporary("ast-mcp-workspace-revision-");
  await git(root, ["init", "-b", "main"]);
  await writeFile(path.join(root, "value.txt"), "base\n");
  await git(root, ["add", "value.txt"]);
  await git(root, ["commit", "-m", "base"]);
  const base = await git(root, ["rev-parse", "HEAD"]);
  await git(root, ["tag", "v1"]);
  await git(root, ["switch", "-c", "feature"]);
  await writeFile(path.join(root, "value.txt"), "feature\n");
  await git(root, ["commit", "-am", "feature"]);
  await git(root, ["switch", "main"]);
  await writeFile(path.join(root, "value.txt"), "staged\n");
  await git(root, ["add", "value.txt"]);
  await writeFile(path.join(root, "value.txt"), "working\n");
  return { base, root };
}

afterEach(async () => {
  await Promise.all(
    created.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

test("working, index, commit, branch, and tag selectors read exact bytes and hashes", async () => {
  const { base, root } = await repository();
  const registry = new WorkspaceRegistry();
  const selectors = [
    { expected: "working\n", kind: "working" as const },
    { expected: "staged\n", kind: "index" as const },
    { expected: "base\n", kind: "commit" as const, oid: base },
    { expected: "feature\n", kind: "branch" as const, name: "feature" },
    { expected: "base\n", kind: "tag" as const, name: "v1" },
  ];

  for (const { expected, ...revision } of selectors) {
    const workspace = await registry.open({
      configurationGeneration: 1,
      directory: root,
      revision,
    });
    await withConfig(hermeticConfig(root), () =>
      withWorkspaceContext(workspace, async () => {
        const result = await readFileSafely({
          filePath: "value.txt",
          mode: "text",
        });
        const [hash] = await hashFilesSafely(["value.txt"]);
        expect(result.content).toBe(expected);
        expect(result.sha256).toBe(sha256(expected));
        expect(hash?.sha256).toBe(sha256(expected));
        expect(workspace.dirtyOverlayId === null).toBe(
          revision.kind !== "working",
        );
        if (revision.kind === "working") {
          expect(await resolveWritablePath("value.txt", "write")).toBe(
            path.join(workspace.checkoutRoot, "value.txt"),
          );
        } else {
          await expect(
            resolveWritablePath("value.txt", "write"),
          ).rejects.toMatchObject({
            code: "workspace_read_only",
          });
          await expect(
            resolveWritablePath("value.txt", "delete"),
          ).rejects.toMatchObject({
            code: "workspace_read_only",
          });
        }
      }),
    );
  }
});

test("index identities detect staged and intent-to-add changes without moving HEAD", async () => {
  const { root } = await repository();
  await git(root, ["reset", "--hard"]);
  const registry = new WorkspaceRegistry();
  const openIndex = () =>
    registry.open({
      configurationGeneration: 1,
      directory: root,
      revision: { kind: "index" },
    });
  const head = await git(root, ["rev-parse", "HEAD"]);
  const initial = await openIndex();

  await writeFile(path.join(root, "value.txt"), "working-only\n");
  expect((await registry.get(initial.workspaceId)).workspaceId).toBe(
    initial.workspaceId,
  );
  await git(root, ["checkout", "--", "value.txt"]);

  await writeFile(path.join(root, "value.txt"), "staged-content\n");
  await git(root, ["add", "value.txt"]);
  await expect(registry.get(initial.workspaceId)).rejects.toMatchObject({
    code: "workspace_mismatch",
  });
  const contentChanged = await openIndex();
  expect(contentChanged.workspaceId).not.toBe(initial.workspaceId);

  await writeFile(path.join(root, "added.txt"), "added\n");
  await git(root, ["add", "added.txt"]);
  await expect(registry.get(contentChanged.workspaceId)).rejects.toMatchObject({
    code: "workspace_mismatch",
  });
  const added = await openIndex();

  await git(root, ["rm", "-f", "value.txt"]);
  await expect(registry.get(added.workspaceId)).rejects.toMatchObject({
    code: "workspace_mismatch",
  });
  const deleted = await openIndex();

  await git(root, ["mv", "added.txt", "renamed.txt"]);
  await expect(registry.get(deleted.workspaceId)).rejects.toMatchObject({
    code: "workspace_mismatch",
  });
  const renamed = await openIndex();

  await writeFile(path.join(root, "intent.txt"), "intent-one\n");
  await git(root, ["add", "--intent-to-add", "intent.txt"]);
  const intent = await openIndex();
  expect(intent.workspaceId).not.toBe(renamed.workspaceId);
  await writeFile(path.join(root, "intent.txt"), "intent-two\n");
  await expect(registry.get(intent.workspaceId)).rejects.toMatchObject({
    code: "workspace_mismatch",
  });
  const changedIntent = await openIndex();
  expect(changedIntent.workspaceId).not.toBe(intent.workspaceId);
  expect(await git(root, ["rev-parse", "HEAD"])).toBe(head);
});

test("refs resolve once and detached or dirty state remains explicit", async () => {
  const { base, root } = await repository();
  await writeFile(path.join(root, "untracked.txt"), "new\n");
  const registry = new WorkspaceRegistry();
  const working = await registry.open({
    configurationGeneration: 1,
    directory: root,
  });
  const status = await registry.status(working.workspaceId);
  expect(working.dirtyOverlayId).not.toBeNull();
  await writeFile(path.join(root, "untracked.txt"), "changed\n");
  await expect(registry.status(working.workspaceId)).rejects.toMatchObject({
    code: "workspace_mismatch",
  });
  const changed = await registry.open({
    configurationGeneration: 1,
    directory: root,
  });
  expect(changed.dirtyOverlayId).not.toBe(working.dirtyOverlayId);
  expect(changed.workspaceId).not.toBe(working.workspaceId);
  expect(status.selected?.workingState).toEqual({
    deleted: false,
    dirty: true,
    staged: true,
    untracked: true,
  });
  await rm(path.join(root, "value.txt"));
  await expect(registry.status(changed.workspaceId)).rejects.toMatchObject({
    code: "workspace_mismatch",
  });
  const deletedWorkspace = await registry.open({
    configurationGeneration: 1,
    directory: root,
  });
  const deleted = await registry.status(deletedWorkspace.workspaceId);
  expect(deleted.selected?.workingState.deleted).toBe(true);

  await git(root, ["reset", "--hard", base]);
  await git(root, ["checkout", "--detach", base]);
  const detached = await registry.open({
    configurationGeneration: 1,
    directory: root,
  });
  expect(detached.git.branch).toBeNull();
  expect(detached.git.headOid).toBe(base);
  await git(root, ["switch", "feature"]);
  const switched = await registry.open({
    configurationGeneration: 1,
    directory: root,
  });
  expect(switched.selectedRevision.resolvedCommitOid).not.toBe(base);
  expect(switched.workspaceId).not.toBe(detached.workspaceId);
});

test("revision file reads reject invalid boundaries and unavailable Git state", async () => {
  const { base, root } = await repository();
  const registry = new WorkspaceRegistry();
  const working = await registry.open({
    configurationGeneration: 1,
    directory: root,
  });
  const historical = await registry.open({
    configurationGeneration: 1,
    directory: root,
    revision: { kind: "commit", oid: base },
  });

  await expect(
    readGitRevisionFile(
      working.git,
      working.selectedRevision,
      path.join(root, "value.txt"),
    ),
  ).rejects.toMatchObject({ code: "workspace_revision_invalid" });
  await expect(
    readGitRevisionFile(historical.git, historical.selectedRevision, root),
  ).rejects.toMatchObject({ code: "workspace_mismatch" });
  await expect(
    readGitRevisionFile(
      historical.git,
      historical.selectedRevision,
      path.join(historical.checkoutRoot, "missing.txt"),
    ),
  ).rejects.toMatchObject({ code: "workspace_revision_invalid" });

  const staleGit = await discoverGitWorkspace(root);
  await rm(path.join(root, ".git"), { force: true, recursive: true });
  await expect(
    gitDirtyOverlayId(
      staleGit,
      working.repositoryId,
      working.selectedRevision.revisionId,
    ),
  ).rejects.toMatchObject({ code: "workspace_git_failure" });
  await expect(gitWorkingState(staleGit)).rejects.toMatchObject({
    code: "workspace_git_failure",
  });
});

test("historical Git reads accept directories beginning with two dots", async () => {
  const root = await temporary("ast-mcp-workspace-dot-prefix-");
  await git(root, ["init", "-b", "main"]);
  const filePath = path.join(root, "..cache", "note.txt");
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, "kept\n");
  await git(root, ["add", "--", "..cache/note.txt"]);
  await git(root, ["commit", "-m", "add dot-prefixed directory"]);
  const oid = await git(root, ["rev-parse", "HEAD"]);
  const workspace = await new WorkspaceRegistry().open({
    configurationGeneration: 1,
    directory: root,
    revision: { kind: "commit", oid },
  });
  const content = await readGitRevisionFile(
    workspace.git,
    workspace.selectedRevision,
    path.join(workspace.checkoutRoot, "..cache", "note.txt"),
  );
  expect(Buffer.from(content).toString("utf8")).toBe("kept\n");
});

test("invalid refs and historical selectors on non-Git roots fail closed", async () => {
  const root = await temporary("ast-mcp-workspace-nongit-");
  const registry = new WorkspaceRegistry();
  await expect(
    registry.open({
      configurationGeneration: 1,
      directory: root,
      revision: { kind: "branch", name: "missing" },
    }),
  ).rejects.toMatchObject({ code: "workspace_revision_invalid" });

  await git(root, ["init", "-b", "main"]);
  for (const revision of [
    { kind: "branch" as const, name: "main~1" },
    { kind: "branch" as const, name: "main@{1}" },
    { kind: "branch" as const, name: "feature^" },
    { kind: "branch" as const, name: "-main" },
    { kind: "tag" as const, name: "v1^{}" },
    { kind: "tag" as const, name: "missing" },
  ]) {
    await expect(
      registry.open({
        configurationGeneration: 1,
        directory: root,
        revision,
      }),
    ).rejects.toMatchObject({ code: "workspace_revision_invalid" });
  }
});

test("Git subprocesses force-kill commands that ignore graceful termination", async () => {
  const originalSpawn = Bun.spawn;
  const signals: Array<number | NodeJS.Signals | undefined> = [];
  let exitCode: number | null = null;
  let finish!: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    finish = resolve;
  });
  const child = {
    get exitCode() {
      return exitCode;
    },
    exited,
    kill(signal?: number | NodeJS.Signals) {
      signals.push(signal);
      if (
        signal === "SIGKILL" ||
        (process.platform === "win32" && signal === undefined)
      ) {
        exitCode = 137;
        finish(exitCode);
      }
    },
    pid: 123,
    stderr: new Blob().stream(),
    stdout: new Blob().stream(),
  };
  Bun.spawn = (() => child) as unknown as typeof Bun.spawn;
  try {
    const controller = new AbortController();
    const pending = runGitRaw(
      "/unused",
      ["status"],
      controller.signal,
      () => {},
    );
    controller.abort();
    expect(await pending).toMatchObject({ code: 137 });
    expect(signals).toEqual(
      process.platform === "win32" ? [undefined] : ["SIGTERM", "SIGKILL"],
    );
  } finally {
    Bun.spawn = originalSpawn;
  }
});

test("Git subprocesses ignore repository and configuration environment overrides", async () => {
  const { base, root } = await repository();
  const other = await temporary("ast-mcp-workspace-hostile-git-");
  await git(other, ["init", "-b", "hostile"]);
  await writeFile(path.join(other, "value.txt"), "hostile\n");
  await git(other, ["add", "value.txt"]);
  await git(other, ["commit", "-m", "hostile"]);
  const alternateIndex = path.join(other, ".git", "index");
  const baselineIdentity = await discoverGitWorkspace(root);
  const baselineRegistry = new WorkspaceRegistry();
  const baselineHistorical = await baselineRegistry.open({
    configurationGeneration: 1,
    directory: root,
    revision: { kind: "commit", oid: base },
  });
  const baselineOverlay = await gitDirtyOverlayId(
    baselineIdentity,
    baselineHistorical.repositoryId,
    baselineHistorical.selectedRevision.revisionId,
  );
  const names = {
    GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(other, ".git", "objects"),
    GIT_CEILING_DIRECTORIES: root,
    GIT_COMMON_DIR: path.join(other, ".git"),
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_GLOBAL: path.join(other, "hostile-global.gitconfig"),
    GIT_CONFIG_KEY_0: "core.bare",
    GIT_CONFIG_SYSTEM: path.join(other, "hostile-system.gitconfig"),
    GIT_CONFIG_VALUE_0: "true",
    GIT_DIR: path.join(other, ".git"),
    GIT_DISCOVERY_ACROSS_FILESYSTEM: "0",
    GIT_INDEX_FILE: alternateIndex,
    GIT_NAMESPACE: "hostile",
    GIT_OBJECT_DIRECTORY: path.join(other, ".git", "objects"),
    GIT_SHALLOW_FILE: path.join(other, ".git", "shallow"),
    GIT_WORK_TREE: other,
  };
  const previous = Object.fromEntries(
    Object.keys(names).map((name) => [name, process.env[name]]),
  );
  Object.assign(process.env, names);
  try {
    const identity = await discoverGitWorkspace(root);
    expect(identity.checkoutRoot).toBe(await realpath(root));
    expect(identity.branch).toBe("main");
    const registry = new WorkspaceRegistry();
    const index = await registry.open({
      configurationGeneration: 1,
      directory: root,
      revision: { kind: "index" },
    });
    expect(
      Buffer.from(
        await readGitRevisionFile(
          index.git,
          index.selectedRevision,
          path.join(identity.checkoutRoot, "value.txt"),
        ),
      ).toString("utf8"),
    ).toBe("staged\n");
    const historical = await registry.open({
      configurationGeneration: 1,
      directory: root,
      revision: { kind: "commit", oid: base },
    });
    expect(historical.selectedRevision.resolvedCommitOid).toBe(base);
    expect(
      await gitDirtyOverlayId(
        identity,
        historical.repositoryId,
        historical.selectedRevision.revisionId,
      ),
    ).toBe(baselineOverlay);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("porcelain rename and copy records retain destination and source paths", async () => {
  expect(parseGitPorcelainV1Z("R  destination.ts\0source.ts\0")).toEqual([
    { code: "R ", path: "destination.ts", sourcePath: "source.ts" },
  ]);
  expect(parseGitPorcelainV1Z("C  copy.ts\0source.ts\0")).toEqual([
    { code: "C ", path: "copy.ts", sourcePath: "source.ts" },
  ]);

  const { root } = await repository();
  await git(root, ["reset", "--hard"]);
  await writeFile(path.join(root, "source-a.txt"), "same\n");
  await writeFile(path.join(root, "source-b.txt"), "same\n");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "rename sources"]);
  const identity = await discoverGitWorkspace(root);
  const registry = new WorkspaceRegistry();
  const clean = await registry.open({
    configurationGeneration: 1,
    directory: root,
  });
  await git(root, ["mv", "source-a.txt", "destination.txt"]);
  const fromA = await gitDirtyOverlayId(
    identity,
    clean.repositoryId,
    clean.selectedRevision.revisionId,
  );
  await git(root, ["reset", "--hard"]);
  await git(root, ["mv", "source-b.txt", "destination.txt"]);
  const fromB = await gitDirtyOverlayId(
    identity,
    clean.repositoryId,
    clean.selectedRevision.revisionId,
  );
  expect(fromA).not.toBe(fromB);
});
