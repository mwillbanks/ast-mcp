import { expect, spyOn, test } from "bun:test";
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
import { pathToFileURL } from "node:url";
import { evaluateHook } from "../src/hook";
import { install, update } from "../src/installer";

const shell = (command: string) =>
  evaluateHook({ tool_input: { command }, tool_name: "bash" }).denied;

test("hook routes manual mutation without policing host-governed execution", () => {
  for (const command of [
    "apply_patch < change.patch",
    'python -c \'open("x", "w")\'',
    "mv source destination",
    "Set-Content -Path file -Value value",
  ])
    expect(shell(command)).toBeTrue();

  for (const command of [
    "cat source > target",
    "echo text >> file",
    "awk '{ print }' file",
    "git restore file",
    "dprint fmt src",
    "bun test --bail",
    "rg symbol src",
  ])
    expect(shell(command)).toBeFalse();
  expect(
    evaluateHook({
      toolArgs: { command: "cat source > target" },
      toolName: "bash",
    }).denied,
  ).toBeFalse();
});

test("installer copies only the unified skill and its checker diagnoses the result", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-skill-install-"));
  const home = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-skill-home-"));
  const priorSkipSmoke = process.env.AST_MCP_CHECK_INSTALL_SKIP_SMOKE;
  process.env.AST_MCP_CHECK_INSTALL_SKIP_SMOKE = "1";
  try {
    const targets: Array<"codex" | "claude" | "copilot"> = [
      "codex",
      "claude",
      "copilot",
    ];
    await install({ home, root, scope: "local", targets });
    const astMcpBinary = path.join(root, "node_modules/.bin/ast-mcp");
    await rm(astMcpBinary, { force: true });
    await mkdir(path.dirname(astMcpBinary), { recursive: true });
    await writeFile(
      astMcpBinary,
      `#!/bin/sh
while IFS= read -r line; do
  case "$line" in
    *'"method":"initialize"'*) echo '{"jsonrpc":"2.0","id":1,"result":{"capabilities":{"tools":{}},"protocolVersion":"2025-06-18","serverInfo":{"name":"fixture","version":"1"}}}' ;;
    *'"method":"tools/list"'*) echo '{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"graph_diff"},{"name":"graph_explain"},{"name":"graph_path"},{"name":"graph_query"},{"name":"index"},{"name":"index_status"},{"name":"retrieve"},{"name":"workspace_open"},{"name":"workspace_status"}]}}' ;;
    *'"method":"tools/call"'*) echo '{"jsonrpc":"2.0","id":3,"result":{"structuredContent":{"data":{"workspaceId":"workspace:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"ok":true}}}' ;;
  esac
done
`,
    );
    await chmod(astMcpBinary, 0o755);
    expect(
      await readFile(path.join(root, ".codex/skills/ast-mcp/SKILL.md"), "utf8"),
    ).toContain("# AST MCP");
    const installedChecker = await import(
      pathToFileURL(
        path.join(root, ".codex/skills/ast-mcp/scripts/check-install.ts"),
      ).href
    );
    if (process.platform === "darwin" || process.platform === "linux") {
      const digest = new Bun.CryptoHasher("sha256")
        .update(path.resolve(root))
        .digest("hex")
        .slice(0, 12);
      const serviceFile =
        process.platform === "darwin"
          ? path.join(
              home,
              "Library/LaunchAgents",
              `com.mwillbanks.ast-mcp-${digest}.plist`,
            )
          : path.join(
              home,
              ".config/systemd/user",
              `ast-mcp-${digest}.service`,
            );
      await mkdir(path.dirname(serviceFile), { recursive: true });
      await writeFile(
        serviceFile,
        `ExecStart="./node_modules/.bin/ast-mcp" --transport http --host 127.0.0.1 --port 3768 ${root}`,
      );
      const serviceResult = await installedChecker.checkInstall(
        [
          "--scope",
          "local",
          "--target",
          "codex",
          "--root",
          root,
          "--transport",
          "http",
          "--host",
          "127.0.0.1",
          "--port",
          "3768",
          "--service",
        ],
        home,
      );
      expect(serviceResult.checks.service).toBeTrue();
    }
    for (const target of targets)
      expect(
        (
          await installedChecker.checkInstall(
            ["--scope", "local", "--target", target, "--root", root],
            home,
          )
        ).installed,
      ).toBeTrue();

    await rm(
      path.join(root, ".codex/skills/ast-mcp/references/skill-template.md"),
    );
    expect(
      (
        await installedChecker.checkInstall(
          ["--scope", "local", "--target", "codex", "--root", root],
          home,
        )
      ).installed,
    ).toBeTrue();

    const configFile = path.join(root, ".mcp.json");
    const config = JSON.parse(await readFile(configFile, "utf8"));
    config.mcpServers["ast-mcp"].args = ["/evil/src/index.ts"];
    await writeFile(configFile, `${JSON.stringify(config)}\n`);
    const stale = await installedChecker.checkInstall(
      ["--scope", "local", "--target", "claude", "--root", root],
      home,
    );
    expect(stale.installed).toBeFalse();
    expect(stale.checks.mcp).toBeFalse();

    await update({ home, root, scope: "local", targets });
    for (const target of targets)
      expect(
        (
          await installedChecker.checkInstall(
            ["--scope", "local", "--target", target, "--root", root],
            home,
          )
        ).installed,
      ).toBeTrue();

    const globalAlias = path.join(home, ".bun/bin/ast-mcp");
    await mkdir(path.dirname(globalAlias), { recursive: true });
    await writeFile(globalAlias, await readFile(astMcpBinary, "utf8"));
    await chmod(globalAlias, 0o755);
    await install({ home, root, scope: "global", targets });
    for (const target of targets) {
      const result = await installedChecker.checkInstall(
        ["--scope", "global", "--target", target, "--root", root],
        home,
      );
      expect(result.installed).toBeTrue();
      expect(result.installCommand).not.toContain("--root");
    }
    await expect(
      installedChecker.checkInstall(["--unknown"], home),
    ).rejects.toThrow("Unknown argument");
    const missing = await installedChecker.checkInstall(
      [
        "--scope",
        "local",
        "--target",
        "codex",
        "--root",
        "/tmp/missing-ast-mcp",
      ],
      home,
    );
    expect(missing.operation).toBe("install");
    const output = spyOn(process.stdout, "write").mockImplementation(
      () => true,
    );
    try {
      await installedChecker.runCheckInstallCli([
        "--scope",
        "local",
        "--target",
        "codex",
        "--root",
        "/tmp/missing-ast-mcp",
      ]);
      expect(output).toHaveBeenCalledTimes(1);
    } finally {
      output.mockRestore();
    }
  } finally {
    if (priorSkipSmoke === undefined)
      delete process.env.AST_MCP_CHECK_INSTALL_SKIP_SMOKE;
    else process.env.AST_MCP_CHECK_INSTALL_SKIP_SMOKE = priorSkipSmoke;
    await rm(root, { force: true, recursive: true });
    await rm(home, { force: true, recursive: true });
  }
}, 30_000);

test("skill and AGENTS surfaces contain the enforced contract and evals", async () => {
  const skill = await readFile(
    path.resolve("templates/skills/ast-mcp/SKILL.md"),
    "utf8",
  );
  const agents = await readFile(path.resolve("templates/AGENTS.md"), "utf8");
  const evalDirectory = path.resolve("templates/skills/ast-mcp/evals");
  const [primaryJson, fileHashJson] = await Promise.all([
    readFile(path.join(evalDirectory, "evals.json"), "utf8"),
    readFile(path.join(evalDirectory, "file-hash.evals.json"), "utf8"),
  ]);
  const primary = JSON.parse(primaryJson);
  const fileHashEvals = JSON.parse(fileHashJson);
  expect(skill).toContain("references/installation.md");
  expect(skill).toContain("file_hash");
  expect(skill).toContain("file_read");
  expect(agents).toContain("apply_patch");
  expect(agents).toContain("CRITICAL INSTRUCTION");
  expect(primary.evals.length + fileHashEvals.length).toBeGreaterThanOrEqual(
    73,
  );
});
