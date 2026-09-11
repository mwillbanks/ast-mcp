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
  checkInstall,
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

async function folders() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-check-root-"));
  const home = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-check-home-"));
  created.push(root, home);
  const globalAlias = path.join(home, ".bun/bin/ast-mcp");
  const localAlias = path.join(root, "node_modules/.bin/ast-mcp");
  const smokeServer = `#!/bin/sh
while IFS= read -r line; do
  case "$line" in
    *'"method":"initialize"'*) echo '{"jsonrpc":"2.0","id":1,"result":{"capabilities":{"tools":{}},"protocolVersion":"2025-06-18","serverInfo":{"name":"fixture","version":"1"}}}' ;;
    *'"method":"tools/list"'*) echo '{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"graph_diff"},{"name":"graph_explain"},{"name":"graph_path"},{"name":"graph_query"},{"name":"index"},{"name":"index_status"},{"name":"retrieve"},{"name":"workspace_open"},{"name":"workspace_status"}]}}' ;;
    *'"method":"tools/call"'*) echo '{"jsonrpc":"2.0","id":3,"result":{"structuredContent":{"data":{"canonicalRootAnchor":"${root}","checkoutRoot":"${root}","workspaceId":"workspace:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"ok":true}}}' ;;
  esac
done
`;
  await mkdir(path.dirname(globalAlias), { recursive: true });
  await mkdir(path.dirname(localAlias), { recursive: true });
  await writeFile(globalAlias, smokeServer);
  await writeFile(localAlias, smokeServer);
  await chmod(globalAlias, 0o755);
  await chmod(localAlias, 0o755);
  return { home, root };
}

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

    expect(result.installed).toBeTrue();
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

    expect(result.installed).toBeTrue();
    expect(result.installCommand).not.toContain("--root");
    expect(result.installCommand).toContain("--trust dprint");
    expect(result.updateCommand).toStartWith("ast-mcp update");
    expect(result.uninstallCommand).toStartWith("ast-mcp uninstall");
  }
  const configFile = path.join(home, ".codex/config.toml");
  const config = await readFile(configFile, "utf8");
  const windowsAlias = path.join(home, ".bun/bin/ast-mcp.cmd");
  await mkdir(path.dirname(windowsAlias), { recursive: true });
  await writeFile(windowsAlias, "#!/bin/sh\nexit 0\n");
  await chmod(windowsAlias, 0o755);
  await writeFile(
    configFile,
    config.replace(/command = .+/, `command = ${JSON.stringify(windowsAlias)}`),
  );
  expect(
    (
      await checkInstall(
        ["--scope", "global", "--target", "codex", "--root", root],
        home,
      )
    ).checks.mcp,
  ).toBeTrue();
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
  const incomplete = path.join(root, "incomplete");
  await writeFile(
    incomplete,
    `#!/bin/sh
while IFS= read -r line; do
  case "$line" in
    *'"method":"initialize"'*) echo '{"jsonrpc":"2.0","id":1,"result":{"capabilities":{},"protocolVersion":"2025-06-18","serverInfo":{"name":"fixture","version":"1"}}}' ;;
    *'"method":"tools/list"'*) echo '{"jsonrpc":"2.0","id":2,"result":{"tools":[]}}' ;;
    *'"method":"tools/call"'*) echo '{"jsonrpc":"2.0","id":3,"result":{}}' ;;
  esac
done
`,
  );
  await chmod(incomplete, 0o755);
  await expect(smokeMcpStdio(incomplete, root, 500)).rejects.toThrow(
    "missing tools",
  );

  const wrongWorkspace = path.join(root, "wrong-workspace");
  await writeFile(
    wrongWorkspace,
    `#!/bin/sh
while IFS= read -r line; do
  case "$line" in
    *'"method":"initialize"'*) echo '{"jsonrpc":"2.0","id":1,"result":{"capabilities":{},"protocolVersion":"2025-06-18","serverInfo":{"name":"fixture","version":"1"}}}' ;;
    *'"method":"tools/list"'*) echo '{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"generate"},{"name":"graph_diff"},{"name":"graph_explain"},{"name":"graph_path"},{"name":"graph_query"},{"name":"index"},{"name":"index_status"},{"name":"retrieve"},{"name":"workspace_open"},{"name":"workspace_status"}]}}' ;;
    *'"method":"tools/call"'*) echo '{"jsonrpc":"2.0","id":3,"result":{"structuredContent":{"ok":true,"data":{"workspaceId":"workspace:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","checkoutRoot":"/wrong","canonicalRootAnchor":"/wrong"}}}}' ;;
  esac
done
`,
  );
  await chmod(wrongWorkspace, 0o755);
  await expect(smokeMcpStdio(wrongWorkspace, root, 500)).rejects.toThrow(
    "did not select the requested workspace",
  );

  const silent = path.join(root, "silent");
  await writeFile(silent, "#!/bin/sh\nwhile read -r line; do :; done\n");
  await chmod(silent, 0o755);
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
