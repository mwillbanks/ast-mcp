import { afterEach, expect, spyOn, test } from "bun:test";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { install, update } from "../../src/installer";
import { createServicePlan } from "../../src/installer/service";
import { httpEndpoint } from "../../src/installer/transport";
import {
  commandForPlatform,
  executableNames,
  resolveLocalBinaryAlias,
} from "../../src/runtime/binary-resolution";
import {
  checkInstall,
  mcpStdioCommand,
  runCheckInstallCli,
  smokeMcpStdio,
  stdioArgsMatch,
} from "../../templates/skills/ast-mcp/scripts/check-install";
import {
  createMockTime,
  deferred,
  settleWithMockTime,
} from "../support/mock-time";

test("Windows checker matches alias casing without relaxing CMD arguments", () => {
  const alias = String.raw`C:\Users\RUNNER~1\AppData\ast-mcp.CMD`;
  const expected = commandForPlatform(alias, ["mcp"], "win32").args;
  const configured = [...expected];
  configured[4] = expected[4]?.replace(".CMD", ".cmd") as string;
  expect(stdioArgsMatch(configured, expected, "win32")).toBeTrue();
  expect(stdioArgsMatch(configured, expected, "linux")).toBeFalse();
  expect(
    stdioArgsMatch(["/d", "/v:on", ...configured.slice(2)], expected, "win32"),
  ).toBeFalse();
  expect(
    stdioArgsMatch(
      [...configured.slice(0, 4), configured[4]?.replace(" mcp", " MCP")],
      expected,
      "win32",
    ),
  ).toBeFalse();
  expect(
    stdioArgsMatch(
      [...configured.slice(0, 4), `${configured[4]} & del file`],
      expected,
      "win32",
    ),
  ).toBeFalse();
});

const created: string[] = [];
afterEach(async () => {
  await Promise.all(
    created
      .splice(0)
      .map((folder) => rm(folder, { force: true, recursive: true })),
  );
});

type FixtureResponses = Record<string, unknown> | null;

function replyCore(
  stream: ReadableStreamDefaultController<Uint8Array>,
  line: string,
  responses: Record<string, unknown>,
) {
  const request = JSON.parse(line) as { id?: number; method: string };
  if (request.id !== undefined && request.id >= 1 && request.id <= 3)
    stream.enqueue(
      new TextEncoder().encode(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: responses[request.method],
        }) + "\n",
      ),
    );
  return request.id === 4;
}

function workingResponses(root: string): FixtureResponses {
  return {
    initialize: {
      capabilities: { tools: {} },
      protocolVersion: "2025-06-18",
      serverInfo: { name: "ast-mcp", version: "1" },
    },
    "tools/call": {
      structuredContent: {
        data: {
          workspace: {
            canonicalRootAnchor: root,
            checkoutRoot: root,
            workspaceId:
              "workspace:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          },
        },
        ok: true,
      },
    },
    "tools/list": {
      tools: [
        "file_read",
        "file_hash",
        "file_patch",
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
    },
  };
}

test.skipIf(process.platform === "win32")(
  "optional diagnostics cannot hide an unconfirmed process termination",
  async () => {
    const time = createMockTime();
    const root = os.tmpdir();
    const responses = workingResponses(root)!;
    (responses["tools/list"] as { tools: { name: string }[] }).tools.push({
      name: "diagnostics",
    });
    const requested = deferred();
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const child = {
      exitCode: null,
      pid: 99,
      exited: new Promise<number>(() => {}),
      stdin: {
        write(line: string) {
          if (replyCore(stream, line, responses)) requested.resolve();
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
      kill: spyOn({ kill(_signal?: string) {} }, "kill"),
    };
    const spawn = spyOn(Bun, "spawn").mockImplementation(() => child as never);
    const kill = spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("No process group"), { code: "ESRCH" });
    });
    try {
      const pending = smokeMcpStdio("fixture", root, 100);
      await requested.promise;
      await expect(settleWithMockTime(time, pending)).rejects.toThrow(
        "did not terminate",
      );
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    } finally {
      spawn.mockRestore();
      kill.mockRestore();
      child.kill.mockRestore();
    }
  },
  10_000,
);

test("optional diagnostic read and write failures propagate through the shared transport boundary", async () => {
  const time = createMockTime();
  const root = os.tmpdir();
  const responses = workingResponses(root)!;
  (responses["tools/list"] as { tools: { name: string }[] }).tools.push({
    name: "diagnostics",
  });
  for (const mode of [
    "write",
    "flush",
    "read",
    "eof",
    "flush-timeout",
  ] as const) {
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    let optional = false;
    const requested = deferred();
    const child = {
      exitCode: 0,
      exited: Promise.resolve(0),
      stdin: {
        write(line: string) {
          if (!replyCore(stream, line, responses)) return;
          optional = true;
          requested.resolve();
          if (mode === "write") throw new Error("private write details");
          if (mode === "read") stream.error(new Error("private read details"));
          if (mode === "eof") stream.close();
        },
        async flush() {
          if (optional && mode === "flush-timeout") await new Promise(() => {});
          if (optional && mode === "flush")
            throw new Error("private flush details");
        },
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
    const spawn = spyOn(Bun, "spawn").mockImplementation(() => child as never);
    const kill = spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("No mock process group"), {
        code: "ESRCH",
      });
    });
    try {
      const pending = smokeMcpStdio(
        "fixture",
        root,
        mode === "flush-timeout" ? 50 : 500,
      );
      void pending.catch(() => {});
      await requested.promise;
      if (mode === "flush-timeout") {
        expect(await settleWithMockTime(time, pending)).toMatchObject({
          initialized: true,
          selectedWorkspace: true,
        });
        continue;
      }
      const expected =
        mode === "eof"
          ? "ended before responding"
          : mode === "read"
            ? "read failed"
            : "write failed";
      await expect(settleWithMockTime(time, pending)).rejects.toThrow(expected);
    } finally {
      kill.mockRestore();
      spawn.mockRestore();
    }
  }
});

test("resolves native Windows aliases before POSIX shims", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "ast-mcp resolve & alias-"),
  );
  created.push(root);
  const directory = path.join(root, "node_modules/.bin");
  const windowsName = executableNames("ast-mcp", "win32").find((name) =>
    name.toLowerCase().endsWith(".cmd"),
  );
  if (!windowsName) throw new Error("Windows command alias is unavailable");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "ast-mcp"), "posix shim");
  await writeFile(path.join(directory, windowsName), "windows shim");

  expect(executableNames("ast-mcp", "win32").at(-1)).toBe("ast-mcp");
  expect(resolveLocalBinaryAlias("ast-mcp", root, "win32")).toBe(
    path.join(directory, windowsName),
  );
  const windowsAlias = path.join(directory, windowsName);
  expect(mcpStdioCommand(windowsAlias, "win32")).toEqual([
    process.env.ComSpec ?? "cmd.exe",
    "/d",
    "/v:off",
    "/s",
    "/c",
    `call "${windowsAlias}" mcp`,
  ]);
});

test("checker rejects invalid arguments and CLI emits JSON", async () => {
  await expect(checkInstall(["--unknown"])).rejects.toThrow("Unknown argument");
  await expect(checkInstall(["--scope", "wrong"])).rejects.toThrow("Invalid");
  const missing = await checkInstall([
    "--scope",
    "local",
    "--target",
    "codex",
    "--root",
    "/tmp/missing-ast-mcp",
  ]);
  expect(missing.operation).toBe("install");
  expect(missing.recommendedCommand).toBe(missing.installCommand);
  expect(missing.installCommand).not.toContain("bun pm trust dprint");
  expect(missing.installCommand).toContain(
    "./node_modules/.bin/ast-mcp install",
  );
  expect(missing.updateCommand).toContain("./node_modules/.bin/ast-mcp update");
  expect(missing.uninstallCommand).toContain(
    "./node_modules/.bin/ast-mcp uninstall",
  );
  expect(JSON.stringify(missing)).not.toContain("bunx");
  const write = spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    await runCheckInstallCli([
      "--scope",
      "local",
      "--target",
      "codex",
      "--root",
      "/tmp/missing-ast-mcp",
    ]);
    expect(write).toHaveBeenCalledTimes(1);
  } finally {
    write.mockRestore();
  }
});

test.skipIf(process.platform === "win32")(
  "checker bounds cleanup when an unresponsive child ignores termination",
  async () => {
    const encoder = new TextEncoder();
    const ended = deferred();
    const child = {
      exitCode: null,
      pid: 99,
      exited: new Promise<number>(() => {}),
      stdin: {
        write() {},
        flush: async () => {},
        end() {
          ended.resolve();
        },
      },
      stdout: new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode("invalid\n"));
          controller.close();
        },
      }),
      stderr: new ReadableStream({
        start(controller) {
          controller.close();
        },
      }),
      kill: spyOn({ kill(_signal?: string) {} }, "kill"),
    };
    const spawn = spyOn(Bun, "spawn").mockImplementation(() => child as never);
    const kill = spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("No process group"), { code: "ESRCH" });
    });
    const time = createMockTime();
    try {
      const pending = smokeMcpStdio("fixture", os.tmpdir(), 200);
      void pending.catch(() => {});
      await ended.promise;
      await expect(settleWithMockTime(time, pending)).rejects.toThrow();
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
      expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual([
        "SIGTERM",
        "SIGKILL",
      ]);
    } finally {
      spawn.mockRestore();
      kill.mockRestore();
      child.kill.mockRestore();
    }
  },
);

test("checker validates HTTP and service option combinations", async () => {
  await expect(
    checkInstall(["--transport", "stdio", "--service"]),
  ).rejects.toThrow("--service requires");
  await expect(checkInstall(["--port", "0"])).rejects.toThrow("Invalid --port");
  const result = await checkInstall([
    "--transport",
    "http",
    "--host",
    "0.0.0.0",
    "--port",
    "4567",
    "--target",
    "copilot",
  ]);
  expect(result.url).toBe("http://127.0.0.1:4567/mcp");
  expect(result.transport).toBe("http");
});
