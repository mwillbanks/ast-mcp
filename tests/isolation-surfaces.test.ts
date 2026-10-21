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

import { exportSkills } from "../src/cli/skills";
import { evaluateHook } from "../src/hooks";
import { install, update } from "../src/installer";
import { createServicePlan } from "../src/installer/service";
import { httpEndpoint } from "../src/installer/transport";

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

test("installer leaves skill export explicit and its checker diagnoses host configuration", async () => {
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
    const exported = path.join(root, ".codex/skills/ast-mcp");
    await expect(readFile(path.join(exported, "SKILL.md"))).rejects.toThrow();
    await exportSkills(exported);
    expect(
      await readFile(path.join(root, ".codex/skills/ast-mcp/SKILL.md"), "utf8"),
    ).toContain("# AST MCP");
    const installedChecker = await import(
      pathToFileURL(
        path.join(root, ".codex/skills/ast-mcp/scripts/check-install.ts"),
      ).href
    );
    const sourceConfigFile = path.join(root, ".mcp.json");
    const sourceConfig = JSON.parse(await readFile(sourceConfigFile, "utf8"));
    const sourceEntry = sourceConfig.mcpServers["ast-mcp"];
    expect(path.isAbsolute(sourceEntry.command)).toBeTrue();
    expect(path.isAbsolute(sourceEntry.args[0])).toBeTrue();
    expect(sourceEntry.args[1]).toBe("mcp");
    expect(sourceEntry.cwd).toBe(root);
    const checkSource = () =>
      installedChecker.checkInstall(
        ["--scope", "local", "--target", "claude", "--root", root],
        home,
      );
    expect((await checkSource()).installed).toBeTrue();
    for (const invalid of [
      { command: sourceEntry.args[0] },
      { args: [sourceEntry.command, "mcp"] },
      { args: [...sourceEntry.args, "--eval", "evil"] },
      { cwd: home },
      { cwd: undefined },
    ]) {
      await writeFile(
        sourceConfigFile,
        JSON.stringify({
          ...sourceConfig,
          mcpServers: {
            ...sourceConfig.mcpServers,
            "ast-mcp": { ...sourceEntry, ...invalid },
          },
        }),
      );
      expect((await checkSource()).checks.mcp).toBeFalse();
    }
    await writeFile(sourceConfigFile, JSON.stringify(sourceConfig));
    const sourceHooksFile = path.join(root, ".claude/settings.json");
    const sourceHooks = JSON.parse(await readFile(sourceHooksFile, "utf8"));
    const sourceHookCommand = sourceHooks.hooks.PreToolUse[0].hooks[0].command;
    for (const invalid of [
      `${JSON.stringify(sourceEntry.args[0])} hook`,
      `${JSON.stringify(sourceEntry.command)} ${JSON.stringify(sourceEntry.command)} hook`,
      `${sourceHookCommand} --eval evil`,
    ]) {
      const candidate = structuredClone(sourceHooks);
      candidate.hooks.PreToolUse[0].hooks[0].command = invalid;
      await writeFile(sourceHooksFile, JSON.stringify(candidate));
      expect((await checkSource()).checks.hook).toBeFalse();
    }
    await writeFile(sourceHooksFile, JSON.stringify(sourceHooks));
    const receiptFile = path.join(
      home,
      ".ast-mcp/installations",
      `local-${new Bun.CryptoHasher("sha256").update(path.resolve(root)).digest("hex")}.json`,
    );
    const receiptText = await readFile(receiptFile, "utf8");
    const receipt = JSON.parse(receiptText);
    expect(receipt).toMatchObject({
      projectRoot: root,
      runtime: sourceEntry.command,
      script: sourceEntry.args[0],
      version: 1,
    });
    await writeFile(
      receiptFile,
      JSON.stringify({ ...receipt, projectRoot: home }),
    );
    const untrusted = await checkSource();
    expect(untrusted.checks.mcp).toBeFalse();
    expect(untrusted.checks.hook).toBeFalse();
    await writeFile(receiptFile, receiptText);
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
        createServicePlan({
          cliEntry: sourceEntry.command,
          cliArgs: [sourceEntry.args[0]],
          endpoint: httpEndpoint("127.0.0.1", 3768),
          home,
          platform: process.platform,
          root,
          scope: "local",
        }).content,
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

    await writeFile(path.join(exported, "SKILL.md"), "customized manual skill");
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

    const globalAlias = path.join(
      home,
      process.platform === "win32"
        ? ".bun/bin/ast-mcp.cmd"
        : ".bun/bin/ast-mcp",
    );
    await mkdir(path.dirname(globalAlias), { recursive: true });
    const sourceCli = path.resolve(import.meta.dir, "../bin/ast-mcp.ts");
    await writeFile(
      globalAlias,
      process.platform === "win32"
        ? `@echo off\r\n"${process.execPath}" "${sourceCli}" %*\r\n`
        : `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(sourceCli)} "$@"\n`,
    );
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
