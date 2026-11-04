import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";

import type { McpServer, ServerContext } from "@modelcontextprotocol/server";

import { withConfig } from "../../src/config";
import { install } from "../../src/installer";
import { withWorkspaceContext } from "../../src/intelligence/workspace/context";
import {
  runGitRaw,
  withWorkspaceGitContext,
} from "../../src/intelligence/workspace/git";
import { WorkspaceRegistry } from "../../src/intelligence/workspace/registry";
import registerNativeCodeIntelligenceTools from "../../src/tools/code-intelligence";
import {
  checkInstall,
  smokeMcpStdio,
} from "../../templates/skills/ast-mcp/scripts/check-install";
import { hermeticConfig } from "../support/hermetic-config";
import { removeTempDirectory } from "../support/temp-directory";
import { spawnLiveProcess } from "./support/live-process";

const cli = path.resolve(import.meta.dir, "../../bin/ast-mcp.ts");
const selectedContent =
  "linked checkout\nsecond line remains outside the read\n";
const workspaceConfig = `version = 2
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
`;
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

/** Run fixture Git independently of inherited repository overrides. */
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

/** Expose the source CLI through a package-manager alias without registry I/O. */
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
  return executable;
}

/** Own a configured repository and two detached checkouts for each test. */
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
    await writeFile(path.join(repository, "ast-mcp.toml"), workspaceConfig);
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

/** Verify public workspace identity and bounded file access through a real server. */
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
  /** Correlate each request with its next protocol response. */
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
  /** Reject protocol failures before inspecting a public tool result. */
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

/** Serve controlled workspace identities without changing the real server. */
function forgedServer(
  checkoutRoot: string,
  canonicalRootAnchor: string,
  descendantScript?: string,
) {
  const workspace = {
    checkoutRoot,
    canonicalRootAnchor,
    workspaceId: `workspace:v1:${"a".repeat(64)}`,
  };
  return `const workspace = ${JSON.stringify(workspace)};
const tools = ${JSON.stringify(tools)}.map(name => ({ name }));
const descendantScript = ${JSON.stringify(descendantScript ?? null)};
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
    if (descendantScript && request.method === "tools/call") {
      const ready = Promise.withResolvers();
      const child = Bun.spawn([process.execPath, descendantScript], {
        stdin: "ignore", stdout: "inherit", stderr: "inherit",
        ipc(message) { if (message === "ready") ready.resolve(); },
      });
      child.unref();
      await ready.promise;
    }
    console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
    if (descendantScript && request.method === "tools/call") process.exit(0);
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
      CODEX_HOME: process.env.CODEX_HOME,
    };
    try {
      process.env.CODEX_HOME = path.join(home, ".codex");
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

test("bare Git pointer uses the selected directory as its workspace anchor", async () => {
  const owned = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "ast-mcp-check-bare-pointer-")),
  );
  try {
    const parent = path.join(owned, "bare-parent");
    const checkout = path.join(owned, "checkout");
    await mkdir(parent);
    await mkdir(checkout);
    await git(parent, ["init", "--bare", "-q", ".git"]);
    await writeFile(
      path.join(checkout, ".git"),
      `gitdir: ${path.join(parent, ".git")}\n`,
    );
    await writeFile(path.join(checkout, "ast-mcp.toml"), workspaceConfig);
    await writeFile(path.join(checkout, "value.txt"), selectedContent);
    const executable = await alias(path.join(checkout, "node_modules/.bin"));
    await readSelectedCheckout(checkout, checkout);
    expect(
      (await smokeMcpStdio(executable, checkout)).selectedWorkspace,
    ).toBeTrue();
  } finally {
    await removeTempDirectory(owned);
  }
}, 30_000);

/** Bound readiness and teardown events without polling or elapsed-time assertions. */
async function boundedProcessEvent<T>(
  pending: Promise<T>,
  description: string,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(description)), 5_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Prepare indexed public map execution before replacing the fixture Git binary. */
async function nativeInventory(root: string, signal: AbortSignal) {
  await writeFile(path.join(root, "value.ts"), "export const value = 1;\n");
  await git(root, ["init", "-q"]);
  await git(root, ["add", "value.ts"]);
  const workspace = await new WorkspaceRegistry().open({
    configurationGeneration: 1,
    directory: root,
    revision: { kind: "index" },
  });
  const handlers = new Map<
    string,
    (input: Record<string, unknown>, context: ServerContext) => Promise<unknown>
  >();
  registerNativeCodeIntelligenceTools(
    {
      /** Capture the public handler without starting another MCP transport. */
      registerTool(name: string, _definition: unknown, handler: never) {
        handlers.set(name, handler);
      },
    } as unknown as McpServer,
    async (_args, operation) => withConfig(hermeticConfig(root), operation),
  );
  return () =>
    withWorkspaceContext(workspace, () =>
      handlers.get("map")!({ root, glob: "**/*.ts", timeout_ms: 10_000 }, {
        mcpReq: { signal },
      } as ServerContext),
    );
}

test
  .skipIf(process.platform === "win32")
  .each(["checker-git", "source-git", "mcp", "native"] as const)(
  "%s cleanup terminates descendants after the launcher exits",
  async (mode) => {
    const owned = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "ast-mcp-check-git-child-")),
    );
    const originalPath = process.env.PATH;
    const ready = Promise.withResolvers<number>();
    const closed = Promise.withResolvers<void>();
    let connection: Socket | undefined;
    let childPid: number | undefined;
    let pending: Promise<unknown> | undefined;
    const server = createServer((socket) => {
      connection = socket;
      let buffered = "";
      socket.on("data", (chunk) => {
        buffered += chunk.toString();
        if (!buffered.includes("\n")) return;
        const pid = Number(buffered.trim());
        if (!Number.isSafeInteger(pid) || pid <= 0) {
          ready.reject(new Error("Invalid descendant PID"));
          return;
        }
        childPid = pid;
        ready.resolve(pid);
      });
      socket.on("close", () => closed.resolve());
    });
    try {
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Readiness server has no TCP address");
      const bin = path.join(owned, "bin");
      const root = path.join(owned, "checkout");
      await mkdir(bin);
      await mkdir(root);
      const abort = new AbortController();
      const native =
        mode === "native"
          ? await nativeInventory(root, abort.signal)
          : undefined;
      if (mode !== "mcp" && mode !== "native")
        await mkdir(path.join(root, ".git"));
      const childScript = path.join(owned, "child.ts");
      await writeFile(
        childScript,
        `import { connect } from "node:net";
const socket = connect(${address.port}, "127.0.0.1", () => {
  socket.write(String(process.pid) + "\\n");
  process.send?.("ready");
});
`,
      );
      const launcher = path.join(bin, "git");
      await writeFile(
        launcher,
        `#!/usr/bin/env bun
Bun.spawn([process.execPath, ${JSON.stringify(childScript)}], {
  stdin: "ignore", stdout: "inherit", stderr: "inherit",
}).unref();
process.exit(0);
`,
      );
      await chmod(launcher, 0o755);
      process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ""}`;
      const operation =
        mode === "native"
          ? native!()
          : mode === "source-git"
            ? withWorkspaceGitContext({ timeoutMs: 2_000 }, () =>
                runGitRaw(root, ["rev-parse", "--is-inside-work-tree"]),
              )
            : smokeMcpStdio(process.execPath, root, 2_000, [
                "-e",
                forgedServer(
                  root,
                  root,
                  mode === "mcp" ? childScript : undefined,
                ),
              ]);
      pending = operation.then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
      await boundedProcessEvent(ready.promise, "Descendant did not start");
      if (mode === "native") abort.abort(new Error("caller cancelled"));
      const outcome = await boundedProcessEvent(
        pending,
        "Operation did not settle after its deadline",
      );
      if (mode === "mcp")
        expect(outcome).toMatchObject({
          result: { initialized: true, selectedWorkspace: true },
        });
      else if (mode === "native")
        expect(outcome).toMatchObject({
          result: {
            isError: true,
            structuredContent: { error: { code: "aborted" } },
          },
        });
      else
        expect(outcome).toMatchObject({
          error: {
            message: expect.stringContaining(
              mode === "source-git"
                ? "Git operation deadline expired"
                : "canonicalRootAnchor",
            ),
          },
        });
      await boundedProcessEvent(closed.promise, "Descendant survived cleanup");
      const inspection = spawnLiveProcess("ps", [
        "-p",
        String(childPid),
        "-o",
        "stat=",
      ]);
      try {
        const exitCode = await inspection.waitForExit();
        if (exitCode === 0)
          expect(inspection.diagnostics()).toMatch(/stdout:\s*Z/u);
        else expect(exitCode).toBe(1);
      } finally {
        await inspection.stop();
      }
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      if (childPid !== undefined) {
        try {
          process.kill(childPid, "SIGKILL");
        } catch {}
      }
      connection?.destroy();
      await pending;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await removeTempDirectory(owned);
    }
  },
  15_000,
);
