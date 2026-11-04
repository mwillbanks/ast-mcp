import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { smokeMcpStdio } from "../../templates/skills/ast-mcp/scripts/check-install";
import { createMockTime, deferred } from "../support/mock-time";

const created: string[] = [];
afterEach(async () => {
  await Promise.all(
    created.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

async function fixture() {
  const base = await mkdtemp(
    path.join(os.tmpdir(), "ast-mcp-workspace-check-"),
  );
  created.push(base);
  const main = path.join(base, "main");
  const linked = path.join(base, "linked");
  const plain = path.join(base, "plain");
  const common = path.join(main, ".git");
  const separate = path.join(base, "separate-git");
  await Promise.all(
    [common, linked, plain, separate].map((root) =>
      mkdir(root, { recursive: true }),
    ),
  );
  await writeFile(path.join(linked, ".git"), "gitdir: fixture");
  return { base, main, linked, plain, common, separate };
}

function protocolChild(workspace: Record<string, unknown>, ok = true) {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  return {
    exitCode: 0,
    exited: Promise.resolve(0),
    stdin: {
      write(line: string) {
        const request = JSON.parse(line);
        if (request.id === undefined) return;
        const result =
          request.method === "initialize"
            ? { serverInfo: { version: "1" } }
            : request.method === "tools/list"
              ? {
                  tools: [
                    "graph_diff",
                    "graph_explain",
                    "graph_path",
                    "graph_query",
                    "index",
                    "index_status",
                    "retrieve",
                    "workspace_open",
                    "workspace_status",
                  ].map((name) => ({ name })),
                }
              : { structuredContent: { ok, data: { workspace } } };
        stream.enqueue(
          new TextEncoder().encode(
            JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n",
          ),
        );
      },
      flush: async () => {},
      end() {},
    },
    stdout: new ReadableStream<Uint8Array>({
      start(controller) {
        stream = controller;
      },
    }),
    stderr: new ReadableStream({
      start(controller) {
        controller.close();
      },
    }),
  };
}

function gitChild(output: string, code = 0) {
  return {
    exitCode: code,
    exited: Promise.resolve(code),
    stdout: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(output));
        controller.close();
      },
    }),
  };
}

function selected(checkoutRoot: unknown, canonicalRootAnchor: unknown) {
  return {
    checkoutRoot,
    canonicalRootAnchor,
    workspaceId: "workspace:v1:fixture",
  };
}

async function smoke(
  root: string,
  workspace: Record<string, unknown>,
  git?: object | Error,
  ok = true,
  drive?: (time: ReturnType<typeof createMockTime>) => Promise<void>,
) {
  const time = createMockTime();
  const started = deferred();
  const spawn = spyOn(Bun, "spawn")
    .mockReturnValueOnce(protocolChild(workspace, ok) as never)
    .mockImplementationOnce(() => {
      started.resolve();
      if (git instanceof Error) throw git;
      if (!git) throw new Error("Unexpected Git invocation");
      return git as never;
    });
  try {
    const pending = smokeMcpStdio("fixture", root, 100);
    void pending.catch(() => {});
    if (drive) {
      await started.promise;
      await drive(time);
    }
    const result = await pending;
    return { result, calls: spawn.mock.calls };
  } finally {
    spawn.mockRestore();
    time.dispose();
  }
}

test("checker derives main and linked anchors while preserving non-Git roots", async () => {
  const paths = await fixture();
  for (const [root, anchor, common] of [
    [paths.main, paths.main, paths.common],
    [paths.linked, paths.main, paths.common],
    [paths.linked, paths.linked, paths.separate],
    [paths.plain, paths.plain, undefined],
  ]) {
    const { result, calls } = await smoke(
      root!,
      selected(root, anchor),
      common ? gitChild(common + "\n") : undefined,
    );
    expect(result.selectedWorkspace).toBeTrue();
    expect(calls.length).toBe(common ? 2 : 1);
    if (common)
      expect(calls[1]?.[0]).toEqual([
        "git",
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ]);
  }
});

test("checker isolates Git identity from ambient repository overrides", async () => {
  const paths = await fixture();
  const overrides = {
    GIT_DIR: paths.separate,
    GIT_COMMON_DIR: paths.separate,
    GIT_WORK_TREE: paths.main,
    GIT_CONFIG_GLOBAL: path.join(paths.base, "private-config"),
    GIT_OPTIONAL_LOCKS: "1",
    GIT_CUSTOM_OVERRIDE: "private",
    AST_MCP_CHECKER_ENV_PROOF: "preserved",
  };
  const original = Object.fromEntries(
    Object.keys(overrides).map((name) => [name, process.env[name]]),
  );
  try {
    Object.assign(process.env, overrides);
    const { result, calls } = await smoke(
      paths.linked,
      selected(paths.linked, paths.main),
      gitChild(paths.common + "\n"),
    );
    const options = (calls[1] as unknown[])[1] as {
      env: Record<string, string>;
    };
    expect(result.selectedWorkspace).toBeTrue();
    expect(
      Object.keys(options.env).filter((name) => name.startsWith("GIT_")),
    ).toEqual(["GIT_OPTIONAL_LOCKS"]);
    expect(options.env.GIT_OPTIONAL_LOCKS).toBe("0");
    expect(options.env.AST_MCP_CHECKER_ENV_PROOF).toBe("preserved");
    expect(process.env.GIT_OPTIONAL_LOCKS).toBe("1");
  } finally {
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("checker rejects checkout substitution even when the shared anchor is correct", async () => {
  const paths = await fixture();
  const message = await smoke(
    paths.linked,
    selected(paths.main, paths.main),
  ).then(
    () => "",
    (error: Error) => error.message,
  );
  expect(message).toContain(
    "checkoutRoot expected selected checkout; observed different path",
  );
  expect(message).not.toContain(paths.base);
});

test("checker names invalid fields without revealing workspace paths", async () => {
  const paths = await fixture();
  for (const [workspace, field, ok] of [
    [selected(paths.linked, paths.linked), "canonicalRootAnchor", true],
    [selected(paths.linked, undefined), "canonicalRootAnchor", true],
    [selected(undefined, paths.main), "checkoutRoot", true],
    [
      { ...selected(paths.linked, paths.main), workspaceId: 1 },
      "workspaceId",
      true,
    ],
    [selected(paths.linked, paths.main), "workspace_open", false],
  ] as const) {
    const message = await smoke(
      paths.linked,
      workspace,
      gitChild(paths.common + "\n"),
      ok,
    ).then(
      () => "",
      (error: Error) => error.message,
    );
    expect(message).toContain(field);
    expect(message).not.toContain(paths.base);
    if (field === "canonicalRootAnchor")
      expect(message).toContain("expected shared repository anchor");
  }
});

test("checker fails closed for unavailable and invalid Git identity", async () => {
  const paths = await fixture();
  for (const git of [
    new Error("private Git executable failure"),
    gitChild("private Git error", 1),
    gitChild("relative/path\n"),
    gitChild(paths.common + "\n" + paths.separate),
    gitChild("x".repeat(128 * 1024 + 1)),
    gitChild(path.join(paths.base, "missing")),
  ]) {
    const message = await smoke(
      paths.linked,
      selected(paths.linked, paths.main),
      git,
    ).then(
      () => "",
      (error: Error) => error.message,
    );
    expect(message).toContain("canonicalRootAnchor could not derive");
    expect(message).not.toContain("private");
    expect(message).not.toContain(paths.base);
  }
});

test("checker bounds and terminates stalled Git identity discovery", async () => {
  const paths = await fixture();
  const ended = deferred<number>();
  let output!: ReadableStreamDefaultController<Uint8Array>;
  const git = {
    exitCode: null as number | null,
    exited: ended.promise,
    stdout: new ReadableStream<Uint8Array>({
      start(controller) {
        output = controller;
      },
    }),
    kill: spyOn({ kill(_signal: string) {} }, "kill").mockImplementation(() => {
      git.exitCode = 137;
      output.close();
      ended.resolve(137);
    }),
  };
  try {
    await expect(
      smoke(
        paths.linked,
        selected(paths.linked, paths.main),
        git,
        true,
        (time) => time.advanceBy(100),
      ),
    ).rejects.toThrow("canonicalRootAnchor could not derive");
    expect(git.kill).toHaveBeenCalledWith("SIGKILL");
  } finally {
    git.kill.mockRestore();
  }
});
