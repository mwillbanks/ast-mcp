import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { install } from "../../src/installer";
import {
  checkInstall,
  smokeMcpStdio,
} from "../../templates/skills/ast-mcp/scripts/check-install";
import { removeTempDirectory } from "../support/temp-directory";
import { spawnLiveProcess } from "./support/live-process";

const cli = path.resolve(import.meta.dir, "../../bin/ast-mcp.ts");
const selectedContent =
  "linked checkout\nsecond line remains outside the read\n";
const tools = [
  "graph_diff",
  "graph_explain",
  "graph_path",
  "graph_query",
  "index",
  "index_status",
  "retrieve",
  "workspace_open",
  "workspace_status",
];

async function git(directory: string, args: string[]) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
  );
  const live = spawnLiveProcess("git", ["-C", directory, ...args], { env });
  try {
    expect(await live.waitForExit(), live.diagnostics()).toBe(0);
  } finally {
    await live.stop();
  }
}

async function alias(directory: string) {
  await mkdir(directory, { recursive: true });
  const script = path.join(directory, "ast-mcp-fixture.ts");
  await writeFile(
    script,
    `globalThis.fetch = (async () => Response.json({ version: "0.7.1" })) as typeof fetch;
await import(${JSON.stringify(cli)});
`,
  );
  const executable = path.join(
    directory,
    process.platform === "win32" ? "ast-mcp.cmd" : "ast-mcp",
  );
  await writeFile(
    executable,
    process.platform === "win32"
      ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
      : `#!/usr/bin/env bun\nawait import(${JSON.stringify(script)});\n`,
  );
  await chmod(executable, 0o755);
}

async function withWorktree(
  run: (fixture: {
    home: string;
    repository: string;
    worktree: string;
    sibling: string;
  }) => Promise<void>,
) {
  const owned = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "ast-mcp-check-worktree-")),
  );
  try {
    const repository = path.join(owned, "repository");
    const worktree = path.join(owned, "worktree");
    const sibling = path.join(owned, "sibling");
    const home = path.join(owned, "home");
    await mkdir(repository);
    await mkdir(home);
    await writeFile(
      path.join(repository, "ast-mcp.toml"),
      `version = 2
[workspace]
roots = ["."]
worktrees = "include"
[telemetry]
enabled = false
[safety.hook]
enabled = true
[[paths]]
id = "workspace"
path = "."
policies = { read = "allow", write = "allow", delete = "deny" }
excludes = [".git/**"]
`,
    );
    await writeFile(path.join(repository, "value.txt"), "main checkout\n");
    await git(repository, ["init", "-q"]);
    await git(repository, ["add", "ast-mcp.toml", "value.txt"]);
    await git(repository, [
      "-c",
      "user.name=AST MCP Test",
      "-c",
      "user.email=ast-mcp@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "fixture",
    ]);
    await git(repository, ["worktree", "add", "--detach", worktree]);
    await git(repository, ["worktree", "add", "--detach", sibling]);
    await writeFile(path.join(worktree, "value.txt"), selectedContent);
    await alias(path.join(worktree, "node_modules/.bin"));
    await alias(path.join(home, ".bun/bin"));
    await run({ home, repository, sibling, worktree });
  } finally {
    await removeTempDirectory(owned);
  }
}

async function readSelectedCheckout(repository: string, worktree: string) {
  const live = spawnLiveProcess(process.execPath, [cli, "mcp"], {
    cwd: worktree,
    env: {
      ...process.env,
      AST_MCP_PROJECT_ROOT: worktree,
      AST_MCP_ROOTS: worktree,
    },
  });
  let id = 0;
  async function request(method: string, params: unknown = {}) {
    const requestId = ++id;
    live.process.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }) + "\n",
    );
    const response = JSON.parse(await live.readStdoutLine());
    expect(response.id).toBe(requestId);
    expect(response.error).toBeUndefined();
    return response.result;
  }
  async function tool<T>(name: string, args: unknown): Promise<T> {
    const result = await request("tools/call", { name, arguments: args });
    expect(result.isError, JSON.stringify(result.content)).not.toBeTrue();
    expect(result.structuredContent.ok).toBeTrue();
    return result.structuredContent.data as T;
  }
  try {
    await request("initialize", {
      capabilities: {},
      clientInfo: { name: "worktree-checker-test", version: "1" },
      protocolVersion: "2025-06-18",
    });
    live.process.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {},
      }) + "\n",
    );
    const opened = await tool<{
      workspace: {
        workspaceId: string;
        checkoutRoot: string;
        canonicalRootAnchor: string;
      };
    }>("workspace_open", { directory: worktree });
    expect(opened.workspace.checkoutRoot).toBe(worktree);
    expect(opened.workspace.canonicalRootAnchor).toBe(repository);
    expect(opened.workspace.checkoutRoot).not.toBe(
      opened.workspace.canonicalRootAnchor,
    );
    const workspaceId = opened.workspace.workspaceId;
    const read = await tool<{
      files: Array<{ content: string; hasMore: boolean }>;
    }>("file_read", {
      workspaceId,
      files: [
        {
          filePath: "value.txt",
          mode: "text",
          range: { start: 0, end: 1 },
          maxBytes: 128,
        },
      ],
    });
    expect(read.files[0]?.content).toBe("linked checkout\n");
    expect(read.files[0]?.hasMore).toBeTrue();
    const hashes = await tool<{ files: Array<{ sha256: string }> }>(
      "file_hash",
      { workspaceId, filePaths: ["value.txt"] },
    );
    expect(hashes.files[0]?.sha256).toBe(
      createHash("sha256").update(selectedContent).digest("hex"),
    );
    live.process.stdin.end();
    expect(await live.waitForExit()).toBe(0);
  } finally {
    await live.stop();
  }
}

function forgedServer(checkoutRoot: string, canonicalRootAnchor: string) {
  const workspace = {
    checkoutRoot,
    canonicalRootAnchor,
    workspaceId: `workspace:v1:${"a".repeat(64)}`,
  };
  return `const workspace = ${JSON.stringify(workspace)};
const tools = ${JSON.stringify(tools)}.map(name => ({ name }));
let buffered = "";
for await (const chunk of Bun.stdin.stream()) {
  buffered += new TextDecoder().decode(chunk);
  let newline;
  while ((newline = buffered.indexOf("\\n")) >= 0) {
    const line = buffered.slice(0, newline);
    buffered = buffered.slice(newline + 1);
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    if (request.id === undefined) continue;
    const result = request.method === "initialize"
      ? { capabilities: {}, protocolVersion: "2025-06-18", serverInfo: { name: "fixture", version: "1" } }
      : request.method === "tools/list"
        ? { tools }
        : { structuredContent: { ok: true, data: { workspace } } };
    console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
  }
}
`;
}

test("managed Codex checks ignore unrelated Git environment and read linked checkout bytes", async () => {
  await withWorktree(async ({ home, repository, worktree }) => {
    const unrelated = path.join(path.dirname(repository), "unrelated");
    await mkdir(unrelated);
    await git(unrelated, ["init", "-q"]);
    const original = {
      GIT_DIR: process.env.GIT_DIR,
      GIT_COMMON_DIR: process.env.GIT_COMMON_DIR,
    };
    try {
      process.env.GIT_DIR = path.join(unrelated, ".git");
      process.env.GIT_COMMON_DIR = path.join(unrelated, ".git");
      await readSelectedCheckout(repository, worktree);
      for (const scope of ["local", "global"] as const) {
        await install({ home, root: worktree, scope, targets: ["codex"] });
        const result = await checkInstall(
          ["--scope", scope, "--target", "codex", "--root", worktree],
          home,
          {
            fetch: (async () =>
              Response.json({ version: "0.7.1" })) as unknown as typeof fetch,
          },
        );
        expect(result).toMatchObject({
          installed: true,
          checks: { mcp: true },
          smoke: { initialized: true, selectedWorkspace: true },
          smokeError: null,
        });
      }
    } finally {
      for (const [name, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
}, 30_000);

test("linked checkout smoke rejects a sibling with the shared anchor and a forged anchor", async () => {
  await withWorktree(async ({ repository, sibling, worktree }) => {
    for (const [checkoutRoot, canonicalRootAnchor, field] of [
      [sibling, repository, "checkoutRoot"],
      [worktree, sibling, "canonicalRootAnchor"],
    ] as const) {
      await expect(
        smokeMcpStdio(process.execPath, worktree, 5_000, [
          "-e",
          forgedServer(checkoutRoot, canonicalRootAnchor),
        ]),
      ).rejects.toThrow(field);
    }
  });
}, 30_000);
