import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { install, update } from "../src/installer";
import {
  checkInstall,
  runCheckInstallCli,
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
  }
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

test("checker detects stale managed guidance and hook payloads", async () => {
  const { home, root } = await folders();
  await install({ home, root, scope: "local", targets: ["codex"] });
  const agentsFile = path.join(root, "AGENTS.md");
  const agents = await readFile(agentsFile, "utf8");
  await writeFile(
    agentsFile,
    agents.replace("CRITICAL INSTRUCTION", "STALE INSTRUCTION"),
  );
  await writeFile(path.join(root, ".codex/hooks/ast-mcp.ts"), "stale");
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
