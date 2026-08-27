import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { clearConfigCache, resolveConfig, withConfig } from "../src/config";
import { writeFileSafely } from "../src/patch/engine";
import {
  clearGitWorktreeCache,
  linkedWorktrees,
} from "../src/runtime/git-worktrees";
import { evaluatePolicy } from "../src/runtime/path-policy";
import {
  canonicalizePathSync,
  containingRoot,
  effectiveWorkspaceRoot,
  relativeRootFromPwd,
} from "../src/runtime/path-utils";
import {
  intelligenceRoot,
  resolveWorkspacePath,
  resolveWritablePath,
} from "../src/runtime/paths";

const created: string[] = [];
let previousPwd: string | undefined;

async function temporary(prefix: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  created.push(root);
  return root;
}

async function git(cwd: string, args: string[]) {
  const processHandle = Bun.spawn(["git", ...args], {
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
  const exitCode = await processHandle.exited;
  if (exitCode === 0) return;
  const stderr = await new Response(processHandle.stderr).text();
  throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
}

function v2Config(worktrees: "include" | "request" | "ignore") {
  return `version = 2

[workspace]
roots = ["."]
worktrees = "${worktrees}"

[formatting]
enabled = false

[safety]
require_hash = false

[[paths]]
id = "workspace"
path = "."
policies = { read = "allow", write = "allow", delete = "deny" }
follow_symlinks = false
includes = ["**/*"]
excludes = [".git/**"]
`;
}

async function repositoryWithWorktree() {
  const parent = await temporary("ast-mcp-worktree-parent-");
  const main = path.join(parent, "main");
  const worktree = path.join(parent, "worktree");
  await mkdir(main);
  await git(main, ["init", "-b", "main"]);
  await git(main, ["config", "user.email", "ast-mcp@example.com"]);
  await git(main, ["config", "user.name", "ast-mcp"]);
  await git(main, ["config", "commit.gpgsign", "false"]);
  await mkdir(path.join(main, "src"));
  await writeFile(
    path.join(main, "src/value.ts"),
    'export const value = "main";\n',
  );
  await git(main, ["add", "."]);
  await git(main, ["commit", "-m", "initial"]);
  await git(main, ["worktree", "add", "-b", "feature", worktree]);
  await writeFile(
    path.join(worktree, "src/value.ts"),
    'export const value = "worktree";\n',
  );
  return { main, worktree };
}

afterEach(async () => {
  if (previousPwd === undefined) delete process.env.PWD;
  else process.env.PWD = previousPwd;
  previousPwd = undefined;
  clearConfigCache();
  clearGitWorktreeCache();
  await Promise.all(
    created
      .splice(0)
      .map((folder) => rm(folder, { force: true, recursive: true })),
  );
});

test("discovers a normal repository from a .git directory", async () => {
  const root = await temporary("ast-mcp-gitdir-directory-");
  await mkdir(path.join(root, ".git"));
  expect(await linkedWorktrees(root)).toEqual([await realpath(root)]);
});

test("discovers main and linked worktrees from a .git file", async () => {
  const parent = await temporary("ast-mcp-gitdir-file-");
  const main = path.join(parent, "main");
  const worktree = path.join(parent, "linked");
  await mkdir(path.join(main, ".git", "worktrees", "feature"), {
    recursive: true,
  });
  await mkdir(worktree);
  await writeFile(
    path.join(worktree, ".git"),
    `gitdir: ${path.join(main, ".git", "worktrees", "feature")}\n`,
  );
  await writeFile(
    path.join(main, ".git", "worktrees", "feature", "commondir"),
    "../..\n",
  );
  await writeFile(
    path.join(main, ".git", "worktrees", "feature", "gitdir"),
    `${path.join(worktree, ".git")}\n`,
  );
  const discoveredFromMain = await linkedWorktrees(main);
  const discoveredFromWorktree = await linkedWorktrees(worktree);
  expect(discoveredFromMain).toEqual(
    expect.arrayContaining([await realpath(main), await realpath(worktree)]),
  );
  expect(discoveredFromWorktree).toEqual(discoveredFromMain);
});

test("resolves a relative gitdir pointer and caches discovery", async () => {
  const parent = await temporary("ast-mcp-gitdir-relative-");
  const main = path.join(parent, "main");
  const worktree = path.join(parent, "linked");
  await mkdir(path.join(main, ".git", "worktrees", "feature"), {
    recursive: true,
  });
  await mkdir(worktree);
  await writeFile(
    path.join(worktree, ".git"),
    "gitdir: ../main/.git/worktrees/feature\n",
  );
  await writeFile(
    path.join(main, ".git", "worktrees", "feature", "commondir"),
    `${path.join(main, ".git")}\n`,
  );
  await writeFile(
    path.join(main, ".git", "worktrees", "feature", "gitdir"),
    "../../../../linked/.git\n",
  );
  const first = await linkedWorktrees(worktree);
  const second = await linkedWorktrees(worktree);
  expect(first).toEqual(
    expect.arrayContaining([await realpath(main), await realpath(worktree)]),
  );
  expect(second).toEqual(first);
});

test("ignores unreadable gitdir files and missing worktree directories", async () => {
  const parent = await temporary("ast-mcp-gitdir-junk-");
  const main = path.join(parent, "main");
  await mkdir(path.join(main, ".git", "worktrees", "gone"), {
    recursive: true,
  });
  await writeFile(
    path.join(main, ".git", "worktrees", "gone", "gitdir"),
    `${path.join(parent, "missing", ".git")}\n`,
  );
  await writeFile(
    path.join(main, ".git", "worktrees", "gone", "commondir"),
    "../..\n",
  );
  await writeFile(path.join(main, ".git", "not-a-worktree"), "stale\n");
  expect(await linkedWorktrees(main)).toEqual([await realpath(main)]);
});

test("rejects gitdir pointers that do not round-trip to this repository", async () => {
  const parent = await temporary("ast-mcp-gitdir-pwn-");
  const main = path.join(parent, "main");
  const foreign = path.join(parent, "foreign");
  await mkdir(path.join(main, ".git", "worktrees", "pwn"), {
    recursive: true,
  });
  await mkdir(foreign);
  await writeFile(path.join(foreign, "secret.txt"), "nope\n");
  await writeFile(
    path.join(main, ".git", "worktrees", "pwn", "gitdir"),
    `${path.join(foreign, "secret.txt")}\n`,
  );
  expect(await linkedWorktrees(main)).toEqual([await realpath(main)]);
  await writeFile(path.join(foreign, ".git"), "gitdir: /tmp/elsewhere\n");
  await writeFile(
    path.join(main, ".git", "worktrees", "pwn", "gitdir"),
    `${path.join(foreign, ".git")}\n`,
  );
  expect(await linkedWorktrees(main)).toEqual([await realpath(main)]);
});

test("treats a .git file without a gitdir pointer as missing", async () => {
  const root = await temporary("ast-mcp-gitdir-empty-");
  await writeFile(path.join(root, ".git"), "# not a gitdir pointer\n");
  expect(await linkedWorktrees(root)).toEqual([]);
});

test("keeps the discovered work tree when commondir is not named .git", async () => {
  const parent = await temporary("ast-mcp-gitdir-store-");
  const store = path.join(parent, "store");
  const worktree = path.join(parent, "linked");
  await mkdir(path.join(store, "worktrees", "feature"), { recursive: true });
  await mkdir(worktree);
  await writeFile(
    path.join(worktree, ".git"),
    `gitdir: ${path.join(store, "worktrees", "feature")}\n`,
  );
  await writeFile(
    path.join(store, "worktrees", "feature", "commondir"),
    `${store}\n`,
  );
  await writeFile(
    path.join(store, "worktrees", "feature", "gitdir"),
    `${path.join(worktree, ".git")}\n`,
  );
  expect(await linkedWorktrees(worktree)).toEqual(
    expect.arrayContaining([await realpath(worktree)]),
  );
});

test("returns no worktrees when git metadata is missing", async () => {
  const root = await temporary("ast-mcp-gitdir-missing-");
  expect(await linkedWorktrees(root)).toEqual([]);
});

test("defaults workspace.worktrees to include without switching projectRoot", async () => {
  const root = await temporary("ast-mcp-worktrees-default-");
  await mkdir(path.join(root, ".git"));
  const config = await resolveConfig({ cwd: root, env: {} });
  expect(config.projectRoot).toBe(root);
  expect(config.workspace.worktrees).toBe("include");
  expect(config.workspace.roots).toEqual([root]);
  expect(config.provenance["workspace.worktrees"]).toBe("default");
});

test("include authorizes absolute worktree paths under a relative paths rule", async () => {
  const { main, worktree } = await repositoryWithWorktree();
  await writeFile(path.join(main, "ast-mcp.toml"), v2Config("include"));
  const worktreeFile = path.join(worktree, "notes.txt");
  await writeFile(worktreeFile, "from-worktree\n");
  const config = await resolveConfig({ cwd: main, env: {} });
  expect(config.projectRoot).toBe(main);
  expect(config.workspace.worktrees).toBe("include");
  expect(config.workspace.linkedWorktrees).toEqual(
    expect.arrayContaining([await realpath(main), await realpath(worktree)]),
  );
  expect(evaluatePolicy(config, worktreeFile, "write").policy).toBe("allow");
  await withConfig({ cwd: main, env: {} }, async () => {
    expect(await realpath(await resolveWorkspacePath(worktreeFile))).toBe(
      await realpath(worktreeFile),
    );
    expect(await realpath(await resolveWritablePath(worktreeFile))).toBe(
      await realpath(worktreeFile),
    );
    await writeFileSafely({
      content: "updated\n",
      filePath: worktreeFile,
    });
    expect(await Bun.file(worktreeFile).text()).toBe("updated\n");
  });
});

test("ignore keeps sibling worktree paths outside the host baseline", async () => {
  const { main, worktree } = await repositoryWithWorktree();
  await writeFile(path.join(main, "ast-mcp.toml"), v2Config("ignore"));
  const worktreeFile = path.join(worktree, "src/value.ts");
  const config = await resolveConfig({ cwd: main, env: {} });
  expect(config.workspace.worktrees).toBe("ignore");
  expect(evaluatePolicy(config, worktreeFile, "read").policy).toBe("deny");
  await expect(
    withConfig({ cwd: main, env: {} }, () =>
      resolveWorkspacePath(worktreeFile),
    ),
  ).rejects.toThrow(/denied|outside/);
});

test("request returns a worktree policy for sibling worktree files", async () => {
  const { main, worktree } = await repositoryWithWorktree();
  await writeFile(path.join(main, "ast-mcp.toml"), v2Config("request"));
  const worktreeFile = path.join(worktree, "src/value.ts");
  const mainFile = path.join(main, "src/value.ts");
  const config = await resolveConfig({ cwd: main, env: {} });
  const worktreeDecision = evaluatePolicy(config, worktreeFile, "write");
  expect(worktreeDecision.policy).toBe("request");
  expect(worktreeDecision.reason).toMatch(/worktree/i);
  expect(evaluatePolicy(config, mainFile, "write").policy).toBe("allow");
});

test("intelligence root follows the containing worktree", async () => {
  const { main, worktree } = await repositoryWithWorktree();
  await writeFile(path.join(main, "ast-mcp.toml"), v2Config("include"));
  const worktreeFile = path.join(worktree, "src/value.ts");
  const mainFile = path.join(main, "src/value.ts");
  await withConfig({ cwd: main, env: {} }, async () => {
    expect(await intelligenceRoot([worktreeFile])).toBe(
      await realpath(worktree),
    );
    expect(await intelligenceRoot([mainFile])).toBe(await realpath(main));
  });
});

test("relative paths resolve against PWD when it is a linked worktree", async () => {
  const { main, worktree } = await repositoryWithWorktree();
  await writeFile(path.join(main, "ast-mcp.toml"), v2Config("include"));
  previousPwd = process.env.PWD;
  process.env.PWD = worktree;
  await withConfig({ cwd: main, env: {} }, async () => {
    expect(await intelligenceRoot(["src/value.ts"])).toBe(
      await realpath(worktree),
    );
    const resolved = await resolveWorkspacePath("src/value.ts");
    expect(await realpath(resolved)).toBe(
      await realpath(path.join(worktree, "src/value.ts")),
    );
  });
});

test("walks past missing nested directories to the git boundary", async () => {
  const root = await temporary("ast-mcp-gitdir-nested-");
  await mkdir(path.join(root, ".git"));
  expect(await linkedWorktrees(path.join(root, "gone", "nested"))).toEqual([
    await realpath(root),
  ]);
});

test("path helpers canonicalize macOS tmp aliases", async () => {
  const root = await temporary("ast-mcp-path-helpers-");
  const nested = path.join(root, "nested", "file.txt");
  expect(containingRoot([root], nested)).toBe(canonicalizePathSync(root));
  expect(effectiveWorkspaceRoot(root, [root])).toBe(path.resolve(root));
  previousPwd = process.env.PWD;
  delete process.env.PWD;
  expect(relativeRootFromPwd([root])).toBeUndefined();
  process.env.PWD = root;
  expect(relativeRootFromPwd([root])).toBe(canonicalizePathSync(root));
  const blocked = path.join(root, "blocked");
  await mkdir(blocked);
  await writeFile(path.join(blocked, "file.txt"), "secret\n");
  await chmod(blocked, 0);
  try {
    expect(canonicalizePathSync(path.join(blocked, "file.txt"))).toContain(
      "file.txt",
    );
  } finally {
    await chmod(blocked, 0o755);
  }
});
