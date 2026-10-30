import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
