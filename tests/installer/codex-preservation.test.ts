import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { codexHome, installerTargetPaths } from "../../src/helpers/installer";
import { install, update } from "../../src/installer";
import { refreshCodexMcp } from "../../src/installer/codex";

const created: string[] = [];
const previousCodexHome = process.env.CODEX_HOME;
afterEach(async () => {
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  await Promise.all(
    created.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("refresh preserves nested tool permissions, environment, timeouts and unrelated server settings", () => {
  const old = `model = "keep"
# ast-mcp:begin
[mcp_servers.ast-mcp]
command = "old"
args = ["mcp"]
startup_timeout_sec = 20
tool_timeout_sec = 120
default_tools_approval_mode = "auto"
[mcp_servers.ast-mcp.env]
TOKEN = "preserve-without-reporting"
[mcp_servers.ast-mcp.tools.file_write]
approval_mode = "approve"
# ast-mcp:end
[mcp_servers.other]
command = "other"
`;
  const launch = { command: "new", args: ["mcp"], cwd: "/project" };
  const next = refreshCodexMcp(old, launch);
  const before = Bun.TOML.parse(old) as any;
  const after = Bun.TOML.parse(next) as any;
  expect(after.mcp_servers["ast-mcp"]).toEqual({
    ...before.mcp_servers["ast-mcp"],
    ...launch,
  });
  expect(after.mcp_servers.other).toEqual(before.mcp_servers.other);
  expect(after.model).toBe("keep");
  expect(refreshCodexMcp(next, launch)).toBe(next);
  const http = Bun.TOML.parse(
    refreshCodexMcp(next, { url: "http://127.0.0.1:3768/mcp" }),
  ) as any;
  expect(http.mcp_servers["ast-mcp"].command).toBeUndefined();
  expect(http.mcp_servers["ast-mcp"].env).toEqual(
    before.mcp_servers["ast-mcp"].env,
  );
});

test("refresh handles unmarked conventional server tables without duplicate declarations", () => {
  const next = refreshCodexMcp(
    '[mcp_servers.ast-mcp]\ncommand="old"\n[mcp_servers.ast-mcp.tools.file_patch]\napproval_mode="approve"\n',
    { command: "new", args: ["mcp"] },
  );
  expect(
    (Bun.TOML.parse(next) as any).mcp_servers["ast-mcp"].tools.file_patch
      .approval_mode,
  ).toBe("approve");
  expect(() =>
    refreshCodexMcp('mcp_servers = { ast-mcp = { command = "old" } }\n', {
      command: "new",
    }),
  ).toThrow("Expand inline");
});

test("local install inherits CODEX_HOME selected legacy policy and preserves local overrides through update", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "ast-mcp-codex-home-"),
  );
  created.push(directory);
  const root = path.join(directory, "project");
  const home = path.join(directory, "home");
  const custom = path.join(directory, "selected-codex-home");
  await Promise.all([
    mkdir(path.join(root, ".codex"), { recursive: true }),
    mkdir(custom, { recursive: true }),
  ]);
  process.env.CODEX_HOME = custom;
  expect(codexHome(home)).toBe(custom);
  expect(installerTargetPaths("codex", true, root, home)[0]).toBe(
    path.join(custom, "config.toml"),
  );
  const inherited =
    "profile = 'safe'\napproval_policy = 'on-request'\n[profiles.safe]\napproval_policy = { granular = { rules = false, mcp_elicitations = false } }\n";
  await writeFile(path.join(custom, "config.toml"), inherited);
  const file = path.join(root, ".codex/config.toml");
  await writeFile(
    file,
    "model = 'local'\n[profiles.safe]\nmodel = 'local-profile'\n",
  );
  const options = {
    root,
    home,
    scope: "local" as const,
    targets: ["codex"] as ["codex"],
    verifyLaunch: async () => {},
  };
  await install(options);
  const first = await readFile(file, "utf8");
  const config = Bun.TOML.parse(first) as any;
  expect(config.profiles.safe).toEqual({
    model: "local-profile",
    approval_policy: { granular: { rules: false, mcp_elicitations: true } },
  });
  expect(config.model).toBe("local");
  expect(await readFile(path.join(custom, "config.toml"), "utf8")).toBe(
    inherited,
  );
  await update(options);
  expect(await readFile(file, "utf8")).toBe(first);
});

test("local install inherits a modern CODEX_HOME profile without changing it", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "ast-mcp-modern-profile-"),
  );
  created.push(directory);
  const root = path.join(directory, "project");
  const custom = path.join(directory, "codex");
  await mkdir(root, { recursive: true });
  await mkdir(custom, { recursive: true });
  process.env.CODEX_HOME = custom;
  await writeFile(
    path.join(custom, "config.toml"),
    "profile = 'safe'\napproval_policy = 'on-request'\n",
  );
  const profile =
    "approval_policy = { granular = { rules = false, mcp_elicitations = false } }\n";
  await writeFile(path.join(custom, "safe.config.toml"), profile);
  await install({
    root,
    home: directory,
    scope: "local",
    targets: ["codex"],
    verifyLaunch: async () => {},
  });
  const local = Bun.TOML.parse(
    await readFile(path.join(root, ".codex/config.toml"), "utf8"),
  ) as any;
  expect(local.approval_policy).toEqual({
    granular: { rules: false, mcp_elicitations: true },
  });
  expect(await readFile(path.join(custom, "safe.config.toml"), "utf8")).toBe(
    profile,
  );
});
