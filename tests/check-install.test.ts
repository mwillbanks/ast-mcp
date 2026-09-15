import { afterEach, expect, spyOn, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { install, update } from "../src/installer";
import {
  executableNames,
  resolveLocalBinaryAlias,
} from "../templates/skills/ast-mcp/scripts/binary-resolution";
import {
  checkInstall,
  mcpStdioCommand,
  runCheckInstallCli,
  smokeMcpStdio,
} from "../templates/skills/ast-mcp/scripts/check-install";

const created: string[] = [];
afterEach(async () => {
  await Promise.all(
    created
      .splice(0)
      .map((folder) => rm(folder, { force: true, recursive: true })),
  );
});

type FixtureResponses = Record<string, unknown> | null;

async function mcpFixture(
  directory: string,
  name: string,
  responses: FixtureResponses,
) {
  await mkdir(directory, { recursive: true });
  const script = path.join(directory, `${name}-fixture.ts`);
  await writeFile(
    script,
    `const responses = ${JSON.stringify(responses)} as Record<string, unknown> | null;
const decoder = new TextDecoder();
let buffered = "";
for await (const chunk of Bun.stdin.stream()) {
  buffered += decoder.decode(chunk, { stream: true });
  let newline = buffered.indexOf("\\n");
  while (newline >= 0) {
    const line = buffered.slice(0, newline).trim();
    buffered = buffered.slice(newline + 1);
    if (line && responses) {
      const request = JSON.parse(line) as { id: unknown; method: string };
      const result = responses[request.method];
      if (result !== undefined)
        console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
    }
    newline = buffered.indexOf("\\n");
  }
}
`,
  );
  const posixAlias = path.join(directory, name);
  const windowsAlias = path.join(directory, `${name}.cmd`);
  await writeFile(
    posixAlias,
    `#!/usr/bin/env bun\nimport ${JSON.stringify(script)};\n`,
  );
  await writeFile(
    windowsAlias,
    `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`,
  );
  await chmod(posixAlias, 0o755);
  await chmod(windowsAlias, 0o755);
  return process.platform === "win32" ? windowsAlias : posixAlias;
}

function workingResponses(root: string): FixtureResponses {
  return {
    initialize: {
      capabilities: { tools: {} },
      protocolVersion: "2025-06-18",
      serverInfo: { name: "fixture", version: "1" },
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

async function folders() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-check-root-"));
  const home = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-check-home-"));
  created.push(root, home);
  await mcpFixture(
    path.join(home, ".bun/bin"),
    "ast-mcp",
    workingResponses(root),
  );
  await mcpFixture(
    path.join(root, "node_modules/.bin"),
    "ast-mcp",
    workingResponses(root),
  );
  return { home, root };
}

test("resolves native Windows aliases before POSIX shims", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-resolve-"));
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
    "/s",
    "/c",
    `call "${windowsAlias}" mcp`,
  ]);
});

test("checker accepts a configured Windows alias after a preferred alias appears", async () => {
  if (process.platform !== "win32") return;
  const { home, root } = await folders();
  await install({ home, root, scope: "local", targets: ["codex"] });
  await writeFile(path.join(root, "node_modules/.bin/ast-mcp.exe"), "fixture");

  const result = await checkInstall(
    ["--scope", "local", "--target", "codex", "--root", root],
    home,
  );
  expect(result.checks.mcp).toBeTrue();
});

test("checker covers every local host surface", async () => {
  const { home, root } = await folders();
  await install({
    home,
    root,
    scope: "local",
    targets: ["codex", "claude", "copilot"],
  });
  for (const target of ["codex", "claude", "copilot"] as const) {
    const result = await checkInstall(
      ["--scope", "local", "--target", target, "--root", root],
      home,
    );

    expect(result).toMatchObject({ installed: true, smokeError: null });
  }
  const configFile = path.join(root, ".mcp.json");
  const config = JSON.parse(await readFile(configFile, "utf8"));
  config.mcpServers["ast-mcp"].args = ["/evil/src/index.ts"];
  await writeFile(configFile, `${JSON.stringify(config)}\n`);
  expect(
    (
      await checkInstall(
        ["--scope", "local", "--target", "claude", "--root", root],
        home,
      )
    ).installed,
  ).toBeFalse();
});

test("checker covers every global host surface", async () => {
  const { home, root } = await folders();
  await install({
    home,
    root,
    scope: "global",
    targets: ["codex", "claude", "copilot"],
  });
  for (const target of ["codex", "claude", "copilot"] as const) {
    const result = await checkInstall(
      ["--scope", "global", "--target", target, "--root", root],
      home,
    );

    expect(result).toMatchObject({ installed: true, smokeError: null });
    expect(result.installCommand).not.toContain("--root");
    expect(result.installCommand).toContain("--trust dprint");
    expect(result.updateCommand).toStartWith("ast-mcp update");
    expect(result.uninstallCommand).toStartWith("ast-mcp uninstall");
  }
  const configFile = path.join(home, ".codex/config.toml");
  const config = await readFile(configFile, "utf8");
  const secondaryAlias = await mcpFixture(
    path.join(home, ".bun/install/global/node_modules/.bin"),
    "ast-mcp",
    workingResponses(root),
  );
  await writeFile(
    configFile,
    config.replace(
      /command = .+/,
      `command = ${JSON.stringify(secondaryAlias)}`,
    ),
  );
  expect(
    (
      await checkInstall(
        ["--scope", "global", "--target", "codex", "--root", root],
        home,
      )
    ).checks.mcp,
  ).toBeTrue();
  const invalidAlias = path.join(home, ".bun/bin/ast-mcp.invalid");
  await writeFile(
    configFile,
    config.replace(/command = .+/, `command = ${JSON.stringify(invalidAlias)}`),
  );
  expect(
    (
      await checkInstall(
        ["--scope", "global", "--target", "codex", "--root", root],
        home,
      )
    ).checks.mcp,
  ).toBeFalse();
  await writeFile(
    configFile,
    config.replace(
      /command = .+/,
      'command = "/tmp/node_modules/@mwillbanks/ast-mcp/dist/ast-mcp.js"',
    ),
  );
  expect(
    (
      await checkInstall(
        ["--scope", "global", "--target", "codex", "--root", root],
        home,
      )
    ).checks.mcp,
  ).toBeFalse();
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
  expect(missing.installCommand).toContain("bun pm trust dprint");
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

test("stdio smoke fails closed for incomplete and unresponsive servers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-smoke-"));
  created.push(root);
  const incomplete = await mcpFixture(root, "incomplete", {
    initialize: {
      capabilities: {},
      protocolVersion: "2025-06-18",
      serverInfo: { name: "fixture", version: "1" },
    },
    "tools/call": {},
    "tools/list": { tools: [] },
  });
  await expect(smokeMcpStdio(incomplete, root, 2_000)).rejects.toThrow(
    "missing tools",
  );

  const wrongWorkspace = await mcpFixture(root, "wrong-workspace", {
    initialize: {
      capabilities: {},
      protocolVersion: "2025-06-18",
      serverInfo: { name: "fixture", version: "1" },
    },
    "tools/call": {
      structuredContent: {
        data: {
          workspace: {
            canonicalRootAnchor: "/wrong",
            checkoutRoot: "/wrong",
            workspaceId:
              "workspace:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          },
        },
        ok: true,
      },
    },
    "tools/list": {
      tools: [
        "generate",
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
  });
  await expect(smokeMcpStdio(wrongWorkspace, root, 2_000)).rejects.toThrow(
    "did not select the requested workspace",
  );

  const silent = await mcpFixture(root, "silent", null);
  await expect(smokeMcpStdio(silent, root, 25)).rejects.toThrow("timed out");
});

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

test("checker detects stale managed guidance and hook payloads", async () => {
  const { home, root } = await folders();
  await install({ home, root, scope: "local", targets: ["codex"] });
  const agentsFile = path.join(root, "AGENTS.md");
  const agents = await readFile(agentsFile, "utf8");
  await writeFile(
    agentsFile,
    agents.replace("CRITICAL INSTRUCTION", "STALE INSTRUCTION"),
  );
  await (async () => {
    const hookFile = path.join(root, ".codex/hooks.json");
    const hooks = JSON.parse(await readFile(hookFile, "utf8"));
    hooks.hooks.PreToolUse[0].hooks[0].command = 'bun "/stale/ast-mcp.js" hook';
    await writeFile(hookFile, JSON.stringify(hooks));
  })();
  await writeFile(path.join(root, ".codex/skills/ast-mcp/SKILL.md"), "stale");

  const stale = await checkInstall(
    ["--scope", "local", "--target", "codex", "--root", root],
    home,
  );
  expect(stale.installed).toBeFalse();
  expect(stale.checks.instructions).toBeFalse();
  expect(stale.checks.hook).toBeFalse();
  expect(stale.checks.skill).toBeFalse();
  expect(stale.needsUpdate).toBeTrue();
  expect(stale.operation).toBe("update");
  expect(stale.recommendedCommand).toBe(stale.updateCommand);

  await update({ home, root, scope: "local", targets: ["codex"] });
  expect(
    (
      await checkInstall(
        ["--scope", "local", "--target", "codex", "--root", root],
        home,
      )
    ).installed,
  ).toBeTrue();
});
