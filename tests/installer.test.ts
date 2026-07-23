import { afterEach, describe, expect, test } from "bun:test";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { install, runInstallerCli, uninstall, update } from "../src/installer";
import { assertAstBroAvailable } from "../src/runtime/dependencies";

const created: string[] = [];
afterEach(async () => {
  await Promise.all(
    created
      .splice(0)
      .map((folder) => rm(folder, { force: true, recursive: true })),
  );
});

describe("installer", () => {
  test("installs every local host idempotently", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-install-"));
    created.push(root);
    await install({
      root,
      scope: "local",
      targets: ["codex", "claude", "copilot"],
    });
    await install({
      root,
      scope: "local",
      targets: ["codex", "claude", "copilot"],
    });
    expect(
      await readFile(path.join(root, ".codex/config.toml"), "utf8"),
    ).toContain("[mcp_servers.ast-mcp]");
    expect(
      JSON.parse(await readFile(path.join(root, ".mcp.json"), "utf8"))
        .mcpServers["ast-mcp"],
    ).toBeTruthy();
    expect(
      JSON.parse(
        await readFile(path.join(root, ".github/hooks/ast-mcp.json"), "utf8"),
      ).hooks.preToolUse,
    ).toHaveLength(1);
    const codexHook = await readFile(
      path.join(root, ".codex/hooks.json"),
      "utf8",
    );
    const claudeHook = await readFile(
      path.join(root, ".claude/settings.json"),
      "utf8",
    );
    const copilotHook = await readFile(
      path.join(root, ".github/hooks/ast-mcp.json"),
      "utf8",
    );
    expect(codexHook).toContain("dist/ast-mcp.js");
    expect(claudeHook).toContain("dist/ast-mcp.js");
    expect(copilotHook).toContain("dist/ast-mcp.js");
    expect(codexHook).not.toContain(root);
    expect(claudeHook).not.toContain(root);
    expect(copilotHook).not.toContain(root);
    const agents = await readFile(path.join(root, "AGENTS.md"), "utf8");
    expect(agents.match(/ast-mcp:begin/g)).toHaveLength(1);
  });
  test("installs global target locations", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-root-"));
    const home = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-home-"));
    created.push(root, home);
    await install({
      home,
      root,
      scope: "global",
      targets: ["codex", "claude", "copilot"],
    });
    expect(
      await readFile(path.join(home, ".codex/AGENTS.md"), "utf8"),
    ).toContain("AST MCP");
    expect(
      await readFile(path.join(home, ".claude/CLAUDE.md"), "utf8"),
    ).toContain("AST MCP");
    expect(
      JSON.parse(
        await readFile(path.join(home, ".copilot/mcp-config.json"), "utf8"),
      ).mcpServers["ast-mcp"].type,
    ).toBe("local");
  });
  test("runs the installer CLI parser", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-cli-"));
    created.push(root);
    await runInstallerCli([
      "--scope",
      "local",
      "--target",
      "codex",
      "--root",
      root,
    ]);
    expect(
      await readFile(path.join(root, ".codex/config.toml"), "utf8"),
    ).toContain("ast-mcp");
    await runInstallerCli([
      "update",
      "--scope",
      "local",
      "--target",
      "codex",
      "--root",
      root,
    ]);
    await runInstallerCli([
      "uninstall",
      "--scope",
      "local",
      "--target",
      "codex",
      "--root",
      root,
    ]);
    expect(await readFile(path.join(root, ".codex/config.toml"), "utf8")).toBe(
      "",
    );
    await expect(runInstallerCli(["--unknown"])).rejects.toThrow(
      "Unknown option",
    );
    await expect(runInstallerCli(["install", "--scope"])).rejects.toThrow(
      "Missing value for --scope",
    );
    await expect(
      runInstallerCli(["install", "--scope=invalid"]),
    ).rejects.toThrow('Invalid scope "invalid"');
    await expect(
      runInstallerCli(["install", "--target=invalid"]),
    ).rejects.toThrow('Invalid target "invalid"');
  });

  test("fails before configuring a host when ast-bro is unavailable", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-missing-tool-"));
    created.push(root);
    const options = {
      astBroBinary: path.join(root, "missing-ast-bro"),
      root,
      scope: "local" as const,
      targets: ["codex" as const],
    };
    for (const operation of [install, update])
      await expect(operation(options)).rejects.toThrow(
        "cargo install ast-bro --version 3.0.0 --locked",
      );
    await expect(
      access(path.join(root, ".codex/config.toml")),
    ).rejects.toThrow();
  });

  test("provides platform-specific ast-bro environment commands", () => {
    expect(() =>
      assertAstBroAvailable("/missing/ast-bro", "linux", "x64"),
    ).toThrow('>> "$HOME/.profile"');
    expect(() =>
      assertAstBroAvailable("C:\\missing\\ast-bro.exe", "win32", "x64"),
    ).toThrow(
      '[Environment]::SetEnvironmentVariable("AST_BRO_BINARY", "$HOME\\.cargo\\bin\\ast-bro.exe", "User")',
    );
  });

  test("update replaces every managed surface and preserves surrounding guidance", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-update-"));
    created.push(root);
    await writeFile(
      path.join(root, "AGENTS.md"),
      "user prefix\n\n<!-- ast-mcp:begin -->\nstale guidance\n<!-- ast-mcp:end -->\n\nuser suffix\n",
    );
    await update({
      root,
      scope: "local",
      targets: ["codex", "claude", "copilot"],
    });
    const expected = (
      await readFile(path.resolve("templates/AGENTS.md"), "utf8")
    ).trim();
    const agents = await readFile(path.join(root, "AGENTS.md"), "utf8");
    expect(agents).toContain("user prefix");
    expect(agents).toContain("user suffix");
    expect(agents.match(/ast-mcp:begin/g)).toHaveLength(1);
    expect(
      agents.match(
        /<!-- ast-mcp:begin -->\n\n([\s\S]*?)\n\n<!-- ast-mcp:end -->/,
      )?.[1],
    ).toBe(expected);
    for (const hookFile of [
      ".codex/hooks/ast-mcp.ts",
      ".claude/hooks/ast-mcp.ts",
      ".github/hooks/ast-mcp.ts",
    ])
      expect(
        await access(path.join(root, hookFile))
          .then(() => false)
          .catch(() => true),
      ).toBeTrue();

    await writeFile(
      path.join(root, ".codex/skills/ast-mcp/obsolete.txt"),
      "obsolete",
    );
    await (async () => {
      const legacyHook = path.join(root, ".codex/hooks/ast-mcp.ts");
      await mkdir(path.dirname(legacyHook), { recursive: true });
      await writeFile(legacyHook, "stale");
    })();
    await update({ root, scope: "local", targets: ["codex"] });
    await expect(
      access(path.join(root, ".codex/skills/ast-mcp/obsolete.txt")),
    ).rejects.toThrow();
    await expect(
      access(path.join(root, ".codex/hooks/ast-mcp.ts")),
    ).rejects.toThrow();
  });

  test("uninstall removes only ast-mcp managed surfaces", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-uninstall-"));
    created.push(root);
    await mkdir(path.join(root, ".codex"), { recursive: true });
    await mkdir(path.join(root, ".github/hooks"), { recursive: true });
    await writeFile(path.join(root, "AGENTS.md"), "user guidance\n");
    await writeFile(path.join(root, ".codex/config.toml"), "# user config\n");
    await writeFile(
      path.join(root, ".codex/hooks.json"),
      `${JSON.stringify({ hooks: { PreToolUse: [{ matcher: "custom" }] } })}\n`,
    );
    await writeFile(
      path.join(root, ".mcp.json"),
      `${JSON.stringify({ mcpServers: { other: { command: "other" } } })}\n`,
    );
    await writeFile(
      path.join(root, ".github/hooks/ast-mcp.json"),
      `${JSON.stringify({ hooks: { preToolUse: [{ command: "custom" }] } })}\n`,
    );
    await install({
      root,
      scope: "local",
      targets: ["codex", "claude", "copilot"],
    });
    await uninstall({ root, scope: "local", targets: ["codex"] });
    expect(await readFile(path.join(root, "AGENTS.md"), "utf8")).toContain(
      "<!-- ast-mcp:begin -->",
    );
    await uninstall({ root, scope: "local", targets: ["claude"] });
    expect(await readFile(path.join(root, "AGENTS.md"), "utf8")).toContain(
      "<!-- ast-mcp:begin -->",
    );
    await uninstall({ root, scope: "local", targets: ["copilot"] });

    expect(await readFile(path.join(root, "AGENTS.md"), "utf8")).toBe(
      "user guidance\n",
    );
    expect(await readFile(path.join(root, ".codex/config.toml"), "utf8")).toBe(
      "# user config\n",
    );
    const mcp = JSON.parse(
      await readFile(path.join(root, ".mcp.json"), "utf8"),
    );
    expect(mcp.mcpServers.other.command).toBe("other");
    expect(mcp.mcpServers["ast-mcp"]).toBeUndefined();
    const codexHooks = JSON.parse(
      await readFile(path.join(root, ".codex/hooks.json"), "utf8"),
    );
    expect(codexHooks.hooks.PreToolUse).toEqual([{ matcher: "custom" }]);
    const copilotHooks = JSON.parse(
      await readFile(path.join(root, ".github/hooks/ast-mcp.json"), "utf8"),
    );
    expect(copilotHooks.hooks.preToolUse).toEqual([{ command: "custom" }]);
    for (const managedPath of [
      ".codex/hooks/ast-mcp.ts",
      ".claude/hooks/ast-mcp.ts",
      ".github/hooks/ast-mcp.ts",
      ".codex/skills/ast-mcp/SKILL.md",
      ".claude/skills/ast-mcp/SKILL.md",
      ".github/skills/ast-mcp/SKILL.md",
    ])
      await expect(access(path.join(root, managedPath))).rejects.toThrow();
  });

  test("uninstall preserves additive host files when managed content was all they contained", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-owned-files-"));
    created.push(root);
    await install({
      root,
      scope: "local",
      targets: ["codex", "claude"],
    });

    await uninstall({
      root,
      scope: "local",
      targets: ["codex", "claude"],
    });

    expect(await readFile(path.join(root, "AGENTS.md"), "utf8")).toBe("");
    expect(await readFile(path.join(root, ".codex/config.toml"), "utf8")).toBe(
      "",
    );
    expect(
      JSON.parse(await readFile(path.join(root, ".codex/hooks.json"), "utf8")),
    ).toEqual({});
    expect(
      JSON.parse(await readFile(path.join(root, ".mcp.json"), "utf8")),
    ).toEqual({});
    expect(
      JSON.parse(
        await readFile(path.join(root, ".claude/settings.json"), "utf8"),
      ),
    ).toEqual({});
  });

  test("uninstall surfaces shared-file read errors without deleting those paths", async () => {
    const configRoot = await mkdtemp(
      path.join(os.tmpdir(), "ast-mcp-config-read-error-"),
    );
    const instructionsRoot = await mkdtemp(
      path.join(os.tmpdir(), "ast-mcp-instructions-read-error-"),
    );
    created.push(configRoot, instructionsRoot);
    await mkdir(path.join(configRoot, ".codex/config.toml"), {
      recursive: true,
    });
    await mkdir(path.join(instructionsRoot, "AGENTS.md"), { recursive: true });

    await expect(
      uninstall({
        root: configRoot,
        scope: "local",
        targets: ["codex"],
      }),
    ).rejects.toThrow();
    await expect(
      uninstall({
        root: instructionsRoot,
        scope: "local",
        targets: ["codex"],
      }),
    ).rejects.toThrow();
    expect(
      (await lstat(path.join(configRoot, ".codex/config.toml"))).isDirectory(),
    ).toBeTrue();
    expect(
      (await lstat(path.join(instructionsRoot, "AGENTS.md"))).isDirectory(),
    ).toBeTrue();
  });
});
