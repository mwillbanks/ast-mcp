import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  inspectCodexConfiguration,
  inspectHostConfiguration,
} from "../../src/installer/diagnostics";

const created: string[] = [];
afterEach(async () => {
  await Promise.all(
    created.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "ast-mcp-host-diagnostics-"),
  );
  created.push(directory);
  const root = path.join(directory, "project");
  const home = path.join(directory, "home");
  const codex = path.join(directory, "custom-codex");
  await Promise.all([
    mkdir(path.join(root, ".codex"), { recursive: true }),
    mkdir(codex, { recursive: true }),
    mkdir(home, { recursive: true }),
  ]);
  return { root, home, codex, env: { CODEX_HOME: codex } };
}

test("Codex inspection separates modern profile files and project overrides from live policy", async () => {
  const f = await fixture();
  await writeFile(
    path.join(f.codex, "config.toml"),
    `profile = "safe"\napproval_policy = "never"\n[projects.${JSON.stringify(f.root)}]\ntrust_level = "trusted"\n`,
  );
  await writeFile(
    path.join(f.codex, "safe.config.toml"),
    "approval_policy = { granular = { mcp_elicitations = true } }\n",
  );
  let report = await inspectCodexConfiguration({ ...f, scope: "local" });
  expect(report.layers.customHome).toBeTrue();
  expect(report.layers.profileFile).toBe("loaded");
  expect(report.disk).toMatchObject({
    policy: "granular",
    elicitation: "allowed",
    source: "profile-file",
    trust: "trusted",
  });
  expect(report.session.approvalPolicy).toBe("unknown");
  await writeFile(
    path.join(f.root, ".codex/config.toml"),
    "approval_policy = 'never'\nprofile = 'ignored-modern-project-profile'\n",
  );
  report = await inspectCodexConfiguration({ ...f, scope: "local" });
  expect(report.selectedProfile).toBe("safe");
  expect(report.disk).toMatchObject({
    policy: "never",
    elicitation: "blocked",
    source: "project",
  });
  expect(JSON.stringify(report)).not.toContain(f.codex);
  expect(JSON.stringify(report)).not.toContain(f.root);
});

test("legacy profile ambiguity and untrusted project configuration do not claim active readiness", async () => {
  const f = await fixture();
  await writeFile(
    path.join(f.codex, "config.toml"),
    "profile = 'safe'\napproval_policy = 'on-request'\n[profiles.safe]\napproval_policy = 'never'\n",
  );
  let report = await inspectCodexConfiguration({ ...f, scope: "local" });
  expect(report.disk).toMatchObject({
    policy: "unknown",
    source: "host-version-dependent",
  });
  await writeFile(
    path.join(f.codex, "config.toml"),
    `approval_policy = "never"\n[projects.${JSON.stringify(f.root)}]\ntrust_level = "untrusted"\n`,
  );
  await writeFile(
    path.join(f.root, ".codex/config.toml"),
    "approval_policy = 'on-request'\n",
  );
  report = await inspectCodexConfiguration({ ...f, scope: "local" });
  expect(report.disk).toMatchObject({ policy: "unknown", trust: "untrusted" });
  expect(report.session.readiness).toBe("unknown");
});

test("nested layers retain candidates but require known project trust", async () => {
  const f = await fixture();
  await mkdir(path.join(f.root, ".git"));
  const nested = path.join(f.root, "packages/service");
  await mkdir(path.join(nested, ".codex"), { recursive: true });
  await writeFile(
    path.join(f.root, ".codex/config.toml"),
    "approval_policy = 'never'\n",
  );
  await writeFile(
    path.join(nested, ".codex/config.toml"),
    "approval_policy = 'on-request'\nsecret = 'do-not-emit'\n",
  );
  const report = await inspectCodexConfiguration({
    ...f,
    root: nested,
    scope: "local",
  });
  expect(report.layers.projectLayerCount).toBe(2);
  expect(report.disk).toMatchObject({
    elicitation: "unknown",
    source: "unknown",
    trust: "unknown",
    modernCandidate: { policy: "on-request", elicitation: "allowed" },
  });
  expect(JSON.stringify(report)).not.toContain("do-not-emit");
  const generic = await inspectHostConfiguration({
    ...f,
    root: nested,
    scope: "local",
    target: "claude",
  });
  expect(generic.hosts).toHaveLength(1);
  expect(JSON.stringify(generic)).not.toContain("Codex Desktop");
});

test("host documents reject malformed, nonobject and oversized configuration without contents", async () => {
  const f = await fixture();
  for (const [source, status] of [
    ["[]", "invalid"],
    ["{private:", "invalid"],
    [" ".repeat(1024 * 1024 + 1), "unreadable"],
  ] as const) {
    await writeFile(path.join(f.home, ".claude.json"), source);
    const report = await inspectHostConfiguration({
      ...f,
      scope: "global",
      target: "claude",
    });
    expect(report.hosts[0]).toMatchObject({
      configuration: status,
      astMcpConfigured: false,
    });
    expect(JSON.stringify(report)).not.toContain("private");
  }
  await rm(path.join(f.home, ".claude.json"));
  await mkdir(path.join(f.home, ".claude.json"));
  expect(
    (
      await inspectHostConfiguration({
        ...f,
        scope: "global",
        target: "claude",
      })
    ).hosts[0],
  ).toMatchObject({ configuration: "unreadable" });
  await writeFile(path.join(f.codex, "config.toml"), "invalid [");
  expect(
    (await inspectCodexConfiguration({ ...f, scope: "global" })).disk,
  ).toMatchObject({ policy: "unknown", source: "unknown" });
});

test("global Codex diagnostics describe unsupported and partial policies conservatively", async () => {
  const f = await fixture();
  for (const [policy, expected] of [
    ["'unsupported'", { policy: "unsupported", elicitation: "unknown" }],
    [
      "{ granular = { rules = true } }",
      { policy: "granular", elicitation: "unknown" },
    ],
    [
      "{ granular = { mcp_elicitations = false } }",
      { policy: "granular", elicitation: "blocked" },
    ],
    ["'untrusted'", { policy: "untrusted", elicitation: "allowed" }],
  ] as const) {
    await writeFile(
      path.join(f.codex, "config.toml"),
      "profile = '../unsafe'\napproval_policy = " + policy + "\n",
    );
    const report = await inspectCodexConfiguration({ ...f, scope: "global" });
    expect(report.selectedProfile).toBe("unknown");
    expect(report.disk.modernCandidate).toEqual(expected);
  }
  await writeFile(
    path.join(f.codex, "config.toml"),
    "profile = 'safe'\nprofiles = { safe = false }\n",
  );
  expect(
    (await inspectCodexConfiguration({ ...f, scope: "global" })).disk.policy,
  ).toBe("default");
});

test("auto discovery inspects each host and package-manager lockfiles independently", async () => {
  const f = await fixture();
  await mkdir(path.join(f.home, ".copilot"));
  await writeFile(
    path.join(f.home, ".claude.json"),
    '{"mcpServers":{"ast-mcp":{}}}',
  );
  await writeFile(
    path.join(f.home, ".copilot/mcp-config.json"),
    '{"mcpServers":{"ast-mcp":{}}}',
  );
  await mkdir(path.join(f.root, ".github"));
  await writeFile(
    path.join(f.root, ".github/mcp.json"),
    '{"mcpServers":{"ast-mcp":{}}}',
  );
  const global = await inspectHostConfiguration({
    ...f,
    scope: "global",
    target: "auto",
  });
  expect(global.hosts).toHaveLength(3);
  expect(
    global.hosts
      .slice(1)
      .every((host) => "astMcpConfigured" in host && host.astMcpConfigured),
  ).toBeTrue();
  expect(
    (
      await inspectHostConfiguration({
        ...f,
        scope: "local",
        target: "copilot",
      })
    ).hosts[0],
  ).toMatchObject({ astMcpConfigured: true });
  const packageDirectory = path.join(
    f.root,
    "node_modules/@mwillbanks/ast-mcp",
  );
  await mkdir(packageDirectory, { recursive: true });
  await writeFile(
    path.join(packageDirectory, "package.json"),
    '{"name":"@mwillbanks/ast-mcp","version":"1.2.3"}',
  );
  for (const [manager, lock] of [
    ["bun", "bun.lock"],
    ["pnpm", "pnpm-lock.yaml"],
    ["yarn", "yarn.lock"],
    ["npm", "package-lock.json"],
  ] as const) {
    await writeFile(path.join(f.root, lock), "");
    const report = await inspectHostConfiguration({
      ...f,
      scope: "local",
      target: "auto",
    });
    expect(report.upgrade.manager).toBe(manager);
    expect(report.upgrade.command).toContain("@mwillbanks/ast-mcp@latest");
    expect(report.upgrade.refreshCommand).toContain("--target all");
    expect(report.installedPackages.projectVersion).toBe("1.2.3");
    await rm(path.join(f.root, lock));
  }
  await writeFile(path.join(f.root, "bun.lock"), "");
  await writeFile(path.join(f.root, "yarn.lock"), "");
  expect(
    (await inspectHostConfiguration({ ...f, scope: "local", target: "claude" }))
      .upgrade.manager,
  ).toBe("unknown");
  await writeFile(
    path.join(f.root, "package.json"),
    '{"packageManager":"pnpm@10"}',
  );
  expect(
    (await inspectHostConfiguration({ ...f, scope: "local", target: "claude" }))
      .upgrade.manager,
  ).toBe("pnpm");
});

test("PATH diagnostics distinguish installed versions and global upgrade managers", async () => {
  const f = await fixture();
  const which = spyOn(Bun, "which");
  try {
    for (const [segment, manager] of [
      [".bun", "bun"],
      ["pnpm", "pnpm"],
      ["npm", "npm"],
      ["other", "unknown"],
    ] as const) {
      const directory = path.join(f.home, segment);
      await mkdir(path.join(directory, "bin"), { recursive: true });
      const binary = path.join(directory, "bin/ast-mcp");
      await writeFile(binary, "");
      await writeFile(
        path.join(directory, "package.json"),
        '{"name":"@mwillbanks/ast-mcp","version":"2.0.0"}',
      );
      which.mockReturnValue(binary);
      const report = await inspectHostConfiguration({
        ...f,
        scope: "global",
        target: "claude",
      });
      expect(report.upgrade.manager).toBe(manager);
      expect(report.installedPackages.pathExecutableVersion).toBe("2.0.0");
    }
    for (const binary of [
      null,
      path.join(f.home, "missing"),
      path.parse(f.home).root,
    ]) {
      which.mockReturnValue(binary);
      expect(
        (
          await inspectHostConfiguration({
            ...f,
            scope: "global",
            target: "claude",
          })
        ).installedPackages.pathExecutableVersion,
      ).toBe("unknown");
    }
  } finally {
    which.mockRestore();
  }
});

test("nearest trusted project entry wins and unreadable paths remain sanitized", async () => {
  const f = await fixture();
  await writeFile(
    path.join(f.codex, "config.toml"),
    `approval_policy = "never"\n[projects.${JSON.stringify(path.dirname(f.root))}]\ntrust_level = "untrusted"\n[projects.${JSON.stringify(f.root)}]\ntrust_level = "trusted"\n`,
  );
  await writeFile(
    path.join(f.root, ".codex/config.toml"),
    "approval_policy = 'on-request'\n",
  );
  expect(
    (await inspectCodexConfiguration({ ...f, scope: "local" })).disk,
  ).toMatchObject({ trust: "trusted", elicitation: "allowed" });
  if (process.platform === "win32") await mkdir(path.join(f.root, ".mcp.json"));
  else await symlink(".mcp.json", path.join(f.root, ".mcp.json"));
  const report = await inspectHostConfiguration({
    ...f,
    scope: "local",
    target: "claude",
  });
  expect(report.hosts[0]).toMatchObject({ configuration: "unreadable" });
  expect(JSON.stringify(report)).not.toContain(f.root);
});
