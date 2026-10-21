import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import { InMemoryTransport, inputRequired } from "@modelcontextprotocol/server";

import {
  clearConfigCache,
  globalTelemetryEnabled,
  globalConfigPath,
  resolveConfig,
  withResolvedConfig,
  type ResolvedConfig,
} from "../../src/config";
import { configRegistry } from "../../src/config/registry";
import { applyAiderBlockCascade } from "../../src/helpers/aider";
import { WorkspaceError } from "../../src/intelligence/workspace/errors";
import { InputRequiredSignal } from "../../src/runtime/approval";
import {
  applyConfigCore,
  applyConfigPaths,
} from "../../src/runtime/config-write";
import { FormatterError } from "../../src/runtime/format";
import { verifyExpectedHash } from "../../src/runtime/policy";
import {
  installProcessFailureHandlers,
  type FailureHost,
} from "../../src/runtime/signals";
import { Telemetry, telemetryFailure } from "../../src/runtime/telemetry";
import { createServer } from "../../src/server";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
  clearConfigCache();
  configRegistry.invalidate();
});
async function project(enabled = true) {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "ast-mcp-telemetry-integration-"),
  );
  directories.push(root);
  const cwd = path.join(root, "project");
  const home = path.join(root, "home");
  await mkdir(cwd, { recursive: true });
  const env = {
    APPDATA: path.join(home, "AppData", "Roaming"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
  };
  const globalPath = globalConfigPath({ home, env });
  await mkdir(path.dirname(globalPath), { recursive: true });
  await writeFile(globalPath, "version = 2\n[telemetry]\nenabled = true\n");
  await writeFile(
    path.join(cwd, "ast-mcp.toml"),
    "version = 2\n[telemetry]\nenabled = " +
      enabled +
      '\n[mcp.configuration]\nrequire_approval = false\n[[paths]]\nid = "project"\npath = "."\npolicies = {read = "allow", write = "allow", delete = "allow"}\n',
  );
  await writeFile(path.join(cwd, "example.txt"), "private source content");
  return { root, cwd, home, env, globalPath };
}
function capture() {
  const packets: Array<{
    batch: Array<{
      event: string;
      properties: Record<string, unknown>;
      distinct_id: string;
    }>;
  }> = [];
  return {
    packets,
    fetch: async (_url: string, options: RequestInit) => {
      packets.push(JSON.parse(options.body as string));
      return new Response('{"status":1}');
    },
  };
}

test("hermetic global opt-out preserves explicit legacy and v2 policy semantics", async () => {
  for (const version of [1, 2] as const) {
    const cwd = await mkdtemp(
      path.join(os.tmpdir(), "ast-mcp-telemetry-policy-"),
    );
    directories.push(cwd);
    await writeFile(path.join(cwd, "ast-mcp.toml"), `version = ${version}\n`);
    const config = await resolveConfig({ cwd });
    expect(config.version).toBe(version);
    expect(config.safety.allowTempDirectory).toBe(version === 1);
    expect(config.telemetry).toEqual({ enabled: false, globalEnabled: false });
  }
});

test("SDK inherited environment preserves global opt-out in child processes", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `
import { resolveConfig, globalTelemetryEnabled } from ${JSON.stringify(path.resolve("src/config/index.ts"))};
import { Telemetry } from ${JSON.stringify(path.resolve("src/runtime/telemetry.ts"))};
let initialized = 0;
let transmitted = 0;
const telemetry = new Telemetry({
  loadSdk: async () => { initialized++; throw new Error("SDK must stay disabled"); },
  fetch: async () => { transmitted++; throw new Error("Network must stay disabled"); },
});
const config = await resolveConfig();
await telemetry.run("config_status", async () => { telemetry.select(config); });
await telemetry.close();
console.log(JSON.stringify({ enabled: await globalTelemetryEnabled(), initialized, transmitted }));
`,
    ],
    { env: getDefaultEnvironment(), stdout: "pipe", stderr: "pipe" },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(exitCode).toBe(0);
  expect(stderr).toBe("");
  expect(JSON.parse(stdout)).toEqual({
    enabled: false,
    initialized: 0,
    transmitted: 0,
  });
});

test("global opt-out parser reads isolated malformed global source and fails closed", async () => {
  const options = await project();
  expect(await globalTelemetryEnabled(options)).toBe(true);
  await writeFile(
    options.globalPath,
    "version = 2\n[telemetry]\nenabled = false\n",
  );
  expect(await globalTelemetryEnabled(options)).toBe(false);
  await writeFile(
    options.globalPath,
    "version = 2\n[telemetry]\nenabled = 'invalid'\n",
  );
  expect(await globalTelemetryEnabled(options)).toBe(false);
  await rm(options.globalPath);
  expect(await globalTelemetryEnabled(options)).toBe(true);
});

test("config_core persists opt-out while preserving adjacent sections and global ceiling", async () => {
  const options = await project();
  const config = await resolveConfig(options);
  const result = await withResolvedConfig(config, () =>
    applyConfigCore({ telemetry: { enabled: false } }),
  );
  expect(result.changed).toEqual(["telemetry"]);
  const source = await readFile(path.join(options.cwd, "ast-mcp.toml"), "utf8");
  expect(Bun.TOML.parse(source)).toMatchObject({
    telemetry: { enabled: false },
    paths: [{ id: "project" }],
  });
  expect((await resolveConfig(options)).telemetry.enabled).toBe(false);
});

test("actual approval, formatter, stale hash, Aider, and workspace conflicts remain operational", async () => {
  const errors: unknown[] = [
    new FormatterError("formatter_unavailable", "/private/executable"),
    new FormatterError("formatter_rejected", "source content"),
    new FormatterError("formatter_cleanup_failed", "private stage"),
    new WorkspaceError("workspace_read_only", "private revision"),
    new InputRequiredSignal(inputRequired({ requestState: "approval" })),
  ];
  expect((errors[0] as FormatterError).retryable).toBe(false);
  expect((errors[0] as FormatterError).suggestedNextCall).toBe("config_status");
  try {
    verifyExpectedHash("private", "actual");
  } catch (error) {
    errors.push(error);
  }
  try {
    applyAiderBlockCascade("same\nsame\n", "same", "new");
  } catch (error) {
    errors.push(error);
  }
  for (const error of errors)
    expect(telemetryFailure(error).outcome).toBe("operational_error");
  expect(errors).toHaveLength(7);
  for (const code of [
    "workspace_required",
    "intelligence_budget_exceeded",
    "reference_verification_failed",
    "patch_strategy_arguments",
    "preview_receipt_unknown",
    "preview_receipt_file_mismatch",
    "preview_receipt_session_mismatch",
    "preview_receipt_workspace_changed",
    "preview_receipt_configuration_changed",
    "preview_receipt_integrity",
    "preview_receipt_limit",
    "command_timeout",
    "command_invalid_output",
  ])
    expect(telemetryFailure({ code }).outcome).toBe("operational_error");
});

test("actual configuration recovery errors produce operational outcomes without exceptions", async () => {
  const options = await project();
  const config = await resolveConfig(options);
  const sink = capture();
  const telemetry = new Telemetry({
    globalEnabled: async () => true,
    fetch: sink.fetch,
  });
  const cases = [
    {
      code: "configuration_missing",
      operation: () =>
        withResolvedConfig(
          { ...config, sources: { ...config.sources, project: undefined } },
          () => applyConfigCore({ telemetry: { enabled: false } }),
        ),
    },
    {
      code: "configuration_empty_patch",
      operation: () => withResolvedConfig(config, () => applyConfigCore({})),
    },
    {
      code: "configuration_path_duplicate",
      operation: () =>
        withResolvedConfig(config, () =>
          applyConfigPaths({
            operations: [
              {
                op: "add",
                rule: {
                  id: "project",
                  path: ".",
                  policies: { read: "allow", write: "allow" },
                },
              },
            ],
          }),
        ),
    },
  ];
  for (const item of cases) {
    await expect(
      telemetry.run("config_core", async () => {
        telemetry.select(config);
        return item.operation();
      }),
    ).rejects.toMatchObject({ code: item.code });
  }
  await telemetry.close();
  const events = sink.packets.flatMap((packet) => packet.batch);
  expect(events).toHaveLength(3);
  expect(
    events.every(
      (event) =>
        event.event === "$mcp_tool_call" &&
        event.properties.outcome === "operational_error",
    ),
  ).toBe(true);
  expect(events.map((event) => event.properties.error_code).sort()).toEqual(
    cases.map((item) => item.code).sort(),
  );
});

test("throw undefined/null/string each remains an unexpected failure with sanitized exception", async () => {
  const sink = capture();
  const telemetry = new Telemetry({
    globalEnabled: async () => true,
    fetch: sink.fetch,
  });
  for (const error of [undefined, null, "private error string"]) {
    let caught = false;
    try {
      await telemetry.run("unknown", async () => {
        telemetry.select({
          telemetry: { enabled: true, globalEnabled: true },
        } as ResolvedConfig);
        throw error;
      });
    } catch (received) {
      caught = true;
      expect(received).toBe(error);
    }
    expect(caught).toBe(true);
  }
  await telemetry.close();
  const events = sink.packets.flatMap((packet) => packet.batch);
  expect(events.filter((event) => event.event === "$exception")).toHaveLength(
    3,
  );
  expect(
    events.filter(
      (event) =>
        event.event === "$mcp_tool_call" &&
        event.properties.outcome === "unexpected_error",
    ),
  ).toHaveLength(3);
  expect(JSON.stringify(events)).not.toContain("private error string");
});

test("stdio startup fatal fallback obeys resolved policy and remains within cleanup deadline", async () => {
  for (const enabled of [true, false]) {
    const options = await project(enabled);
    const sink = capture();
    const telemetry = new Telemetry({
      globalEnabled: async () => true,
      startupConfig: () => resolveConfig(options),
      fetch: sink.fetch,
    });
    telemetry.reportException(new Error("private startup failure"), true);
    await telemetry.close();
    const events = sink.packets.flatMap((packet) => packet.batch);
    expect(events.filter((event) => event.event === "$exception")).toHaveLength(
      enabled ? 1 : 0,
    );
  }
  const sink = capture();
  const unavailable = new Telemetry({
    startupConfig: async () => {
      throw new Error("ambiguous project");
    },
    fetch: sink.fetch,
  });
  unavailable.reportException(new Error("private failure"), true);
  await unavailable.close();
  expect(sink.packets).toHaveLength(0);
  const missing = new Telemetry({ maxPending: 0, fetch: sink.fetch });
  missing.reportException(new Error("saturated"), true);
  await missing.close();
  const disabled = new Telemetry({ fetch: sink.fetch });
  disabled.reportException(new Error("disabled startup"), true);
  await disabled.close();
  expect(sink.packets).toHaveLength(0);
});

for (const enabled of [true, false])
  test(`real MCP calls obey project telemetry ${enabled} and recover after operational failure`, async () => {
    const options = await project(enabled);
    const sink = capture();
    const previousXdg = process.env.XDG_CONFIG_HOME;
    const previousAppData = process.env.APPDATA;
    process.env.XDG_CONFIG_HOME = options.env.XDG_CONFIG_HOME;
    process.env.APPDATA = options.env.APPDATA;
    clearConfigCache();
    configRegistry.invalidate();
    const server = createServer({}, { fetch: sink.fetch });
    const client = new Client(
      { name: "private-client-name", version: "private-version" },
      { capabilities: { roots: {} } },
    );
    client.setRequestHandler("roots/list", async () => ({
      roots: [{ uri: Bun.pathToFileURL(options.cwd).href }],
    }));
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      expect(globalConfigPath()).toBe(options.globalPath);
      expect(await globalTelemetryEnabled()).toBe(true);
      expect((await resolveConfig({ cwd: options.cwd })).telemetry).toEqual({
        enabled,
        globalEnabled: true,
      });
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const before = await client.listTools();
      expect(JSON.stringify(before)).not.toContain("conversation_id");
      const opened = await client.callTool({
        name: "workspace_open",
        arguments: { directory: options.cwd },
      });
      expect(opened.isError).not.toBe(true);
      const workspaceId = (
        opened.structuredContent as {
          data: { workspace: { workspaceId: string } };
        }
      ).data.workspace.workspaceId;
      for (const arguments_ of [{ workspaceId }, {}])
        expect(
          (
            await client.callTool({
              name: "workspace_status",
              arguments: arguments_,
            })
          ).isError,
        ).not.toBe(true);
      expect(
        (
          await client.callTool({
            name: "file_hash",
            arguments: {
              workspaceId,
              filePaths: [path.join(options.cwd, "example.txt")],
            },
          })
        ).isError,
      ).not.toBe(true);
      expect(
        (
          await client.callTool({
            name: "file_read",
            arguments: {
              workspaceId,
              files: [
                {
                  filePath: path.join(options.cwd, "absent.txt"),
                  mode: "text",
                },
              ],
            },
          })
        ).isError,
      ).toBe(true);
      expect(
        (
          await client.callTool({
            name: "config_status",
            arguments: { workspaceId },
          })
        ).isError,
      ).not.toBe(true);
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(
        before.tools.map((tool) => tool.name),
      );
    } finally {
      await client.close();
      await server.close();
      if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousXdg;
      if (previousAppData === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = previousAppData;
      clearConfigCache();
      configRegistry.invalidate();
    }
    const events = sink.packets.flatMap((packet) => packet.batch);
    if (!enabled) {
      expect(events).toHaveLength(0);
      return;
    }
    expect(
      events.filter((event) => event.event === "$mcp_tool_call"),
    ).toHaveLength(6);
    expect(
      events.filter((event) => event.properties.outcome === "success"),
    ).toHaveLength(5);
    expect(
      events.map((event) => event.properties.$mcp_tool_name).sort(),
    ).toEqual([
      "config_status",
      "file_hash",
      "file_read",
      "workspace_open",
      "workspace_status",
      "workspace_status",
    ]);
    expect(events.filter((event) => event.event === "$exception")).toHaveLength(
      0,
    );
    expect(
      events.filter(
        (event) => event.properties.$mcp_tool_name === "workspace_open",
      ),
    ).toHaveLength(1);
    expect(
      events.filter(
        (event) => event.properties.$mcp_tool_name === "workspace_status",
      ),
    ).toHaveLength(2);
    const failure = events.find(
      (event) => event.properties.outcome === "operational_error",
    )!;
    expect(failure.properties.error_code).toBe("ENOENT");
    expect(failure.properties.$mcp_error_type).toBe("ENOENT");
    expect(
      events.every(
        (event) => typeof event.properties.$mcp_duration_ms === "number",
      ),
    ).toBe(true);
    expect(JSON.stringify(events)).not.toContain("private");
  });

test("fatal callback records before cleanup and analytics failure preserves nonzero exit", async () => {
  for (const throws of [false, true]) {
    const listeners = new Map<string, (error: unknown) => void>();
    const sequence: string[] = [];
    const host: FailureHost = {
      on: (event, listener) => listeners.set(event, listener),
      off: (event) => listeners.delete(event),
      exit: (code) => sequence.push("exit:" + code),
      stderr: { write: () => {} },
    };
    const error = new Error("private fatal");
    const remove = installProcessFailureHandlers(
      () => {
        sequence.push("cleanup");
      },
      host,
      100,
      (received) => {
        expect(received).toBe(error);
        sequence.push("capture");
        if (throws) throw new Error("analytics unavailable");
      },
    );
    listeners.get("uncaughtException")!(error);
    await Promise.resolve();
    expect(sequence).toEqual(["capture", "cleanup", "exit:1"]);
    expect(host.exitCode).toBe(1);
    remove();
    expect(listeners.size).toBe(0);
  }
});

test("project suppression survives selection changes within a single compound operation", async () => {
  const sink = capture();
  const telemetry = new Telemetry({
    globalEnabled: async () => true,
    fetch: sink.fetch,
  });
  await telemetry.run("workspace_status", async () => {
    telemetry.select({
      telemetry: { enabled: false, globalEnabled: true },
    } as ResolvedConfig);
    telemetry.select({
      telemetry: { enabled: true, globalEnabled: true },
    } as ResolvedConfig);
  });
  await telemetry.close();
  expect(sink.packets).toHaveLength(0);
});

test("bundled artifact retains package stack frames with immutable build identifier", async () => {
  const options = await project();
  const dist = path.join(options.root, "dist");
  await mkdir(dist);
  const entry = path.join(options.root, "entry.ts");
  await writeFile(
    entry,
    "export { Telemetry } from " +
      JSON.stringify(path.resolve("src/runtime/telemetry.ts")) +
      ";",
  );
  const build = await Bun.build({
    entrypoints: [entry],
    target: "bun",
    format: "esm",
    define: {
      AST_MCP_BUILD_ID: JSON.stringify("a".repeat(40)),
      AST_MCP_SOURCE_FILES: JSON.stringify(["dist/ast-mcp.js"]),
    },
  });
  expect(build.success).toBe(true);
  const artifact = path.join(dist, "ast-mcp.js");
  await writeFile(artifact, await build.outputs[0]!.text());
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `
import { Telemetry } from ${JSON.stringify(Bun.pathToFileURL(artifact).href)};
const packets = [];
const telemetry = new Telemetry({
  globalEnabled: async () => true,
  fetch: async (_url, options) => {
    packets.push(JSON.parse(options.body));
    return new Response('{"status":1}');
  },
});
const error = new Error("private bundled failure");
error.stack = "Error: private\\n at minified (" + ${JSON.stringify(artifact)} + ":25:3)";
try {
  await telemetry.run("file_read", async () => {
    telemetry.select({ telemetry: { enabled: true, globalEnabled: true } });
    throw error;
  });
} catch {}
await telemetry.close();
console.log(JSON.stringify(packets.flatMap(packet => packet.batch).find(event => event.event === "$exception")));
`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(exitCode).toBe(0);
  expect(stderr).toBe("");
  const exception = JSON.parse(stdout);
  expect(exception.properties.$mcp_server_build).toBe("a".repeat(40));
  expect(exception.properties.$exception_list).toMatchObject([
    {
      stacktrace: {
        frames: [
          {
            filename: "ast-mcp/dist/ast-mcp.js",
            function: "<anonymous>",
            platform: "node:javascript",
            lineno: 25,
            colno: 3,
          },
        ],
      },
    },
  ]);
  expect(JSON.stringify(exception)).not.toContain(options.root);
});
