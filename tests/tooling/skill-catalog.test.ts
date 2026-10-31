import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getCliHelp } from "../../src/cli";
import { createSkillCatalog } from "../../src/skills";
import { reconcileSkillExport } from "../../src/skills/export";

const skillRoot = path.resolve(
  import.meta.dir,
  "../../templates/skills/ast-mcp",
);

test("embedded CLI catalog covers executable commands, subcommands, and help options", async () => {
  const catalog = await readFile(
    path.join(skillRoot, "references/cli.md"),
    "utf8",
  );
  const commandSection = getCliHelp()
    .split("Commands:\n")[1]!
    .split("\nOptions:")[0]!;
  const commands = [...commandSection.matchAll(/^  ([a-z]+)\s+/gm)].map(
    (match) => match[1]!,
  );
  expect(commands.length).toBeGreaterThan(0);
  const documented = [...catalog.matchAll(/^\|\s+`([a-z]+)`\s+\|/gm)].map(
    (match) => match[1]!,
  );
  expect(documented.sort()).toEqual([...commands].sort());

  for (const command of commands) {
    const help = getCliHelp(command) ?? getCliHelp();
    for (const option of new Set(help.match(/--[a-z][a-z-]*/g) ?? []))
      expect(catalog, command + " " + option).toContain(option);
    const subcommands = help.match(
      new RegExp("ast-mcp " + command + " <([^>]+)>"),
    );
    if (subcommands?.[1]?.includes("|"))
      for (const subcommand of subcommands[1].split("|"))
        expect(catalog).toContain("ast-mcp " + command + " " + subcommand);
  }
});

test("embedded references resolve within the packaged skill and preserve manifest integrity", async () => {
  const catalog = await createSkillCatalog();
  const resources = new Set(catalog.files.map((file) => file.relative));
  for (const required of [
    "references/host-context.md",
    "references/cli.md",
    "references/diagnostics.md",
    "references/issue-reporting.md",
  ])
    expect(resources.has(required), required).toBeTrue();

  for (const file of catalog.files.filter((entry) =>
    entry.relative.endsWith(".md"),
  )) {
    for (const match of file.bytes
      .toString("utf8")
      .matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const href = match[1]!;
      if (/^[a-z]+:|^#/i.test(href)) continue;
      const relative = path.posix.normalize(
        path.posix.join(path.posix.dirname(file.relative), href.split("#")[0]!),
      );
      expect(relative.startsWith("../")).toBeFalse();
      expect(
        resources.has(relative),
        file.relative + " links " + href,
      ).toBeTrue();
    }
    const uri = file.uri;
    const resource = catalog
      .get("skill://ast-mcp/SKILL.md")
      .skill.resources.find((entry) => entry.uri === uri)!;
    expect(resource.size).toBe(file.bytes.length);
    expect(resource.digest).toBe(
      "sha256:" + createHash("sha256").update(file.bytes).digest("hex"),
    );
    expect(
      Buffer.from(catalog.read(uri).contents[0]!.text).equals(file.bytes),
    ).toBeTrue();
  }
});

test("new diagnostic references export exact bytes and preserve customized manual copies", async () => {
  const catalog = await createSkillCatalog();
  const files = catalog.files.filter((file) =>
    [
      "SKILL.md",
      "references/host-context.md",
      "references/cli.md",
      "references/diagnostics.md",
      "references/issue-reporting.md",
    ].includes(file.relative),
  );
  const destination = await mkdtemp(
    path.join(os.tmpdir(), "ast-mcp-skill-diagnostics-"),
  );
  try {
    const exported = await reconcileSkillExport(destination, "export", files);
    expect(exported.written.sort()).toEqual(
      files.map((file) => file.relative).sort(),
    );
    for (const file of files)
      expect(
        (await readFile(path.join(destination, file.relative))).equals(
          file.bytes,
        ),
      ).toBeTrue();
    const custom = path.join(destination, "references/diagnostics.md");
    await writeFile(custom, "Customized local diagnostic instructions\n");
    const customHost = path.join(destination, "references/host-context.md");
    await writeFile(customHost, "Customized host context instructions\n");
    const updated = await reconcileSkillExport(destination, "update", files);
    expect(updated.conflicts).toContain("references/diagnostics.md");
    expect(updated.conflicts).toContain("references/host-context.md");
    expect(await readFile(customHost, "utf8")).toBe(
      "Customized host context instructions\n",
    );
    expect(await readFile(custom, "utf8")).toBe(
      "Customized local diagnostic instructions\n",
    );
  } finally {
    await rm(destination, { recursive: true, force: true });
  }
});

test("skill scenarios cover unavailable checks, duplicate research, and reporting authorization", async () => {
  const suite = JSON.parse(
    await readFile(path.join(skillRoot, "evals/evals.json"), "utf8"),
  ) as {
    evals: Array<{
      variant: string;
      required_tools: string[];
      forbidden_tools: string[];
      assertions: string[];
    }>;
  };
  for (const variant of [
    "registry-unavailable",
    "host-full-access-unknown",
    "host-grok-context-unknown",
    "issue-report-duplicate",
    "issue-report-unavailable-checks",
    "issue-report-no-authorization",
    "issue-report-authorized-recheck",
  ]) {
    const scenario = suite.evals.find((entry) => entry.variant === variant);
    expect(scenario, variant).toBeDefined();
    expect(scenario!.required_tools).toContain("diagnostics");
    expect(scenario!.forbidden_tools).toContain("approval_probe");
    expect(scenario!.assertions.length).toBeGreaterThanOrEqual(3);
  }
  const worktree = suite.evals.find(
    (entry) => entry.variant === "host-worktree-explicit-selection",
  );
  expect(worktree).toBeDefined();
  expect(worktree!.required_tools).toEqual(["workspace_open"]);
  expect(worktree!.forbidden_tools).toContain("config_paths");
  expect(worktree!.forbidden_tools).toContain("config_core");
  expect(worktree!.assertions.length).toBeGreaterThanOrEqual(3);
});
