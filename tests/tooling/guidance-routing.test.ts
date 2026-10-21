import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { exportSkills } from "../../src/cli/skills";
import { bundledSkills, SKILL_URI } from "../../src/skills";

test("managed bootstrap stays small and routes complete instructions to the active skill", async () => {
  const [agents, template, reference, skill, evals] = await Promise.all([
    readFile("AGENTS.md", "utf8"),
    readFile("templates/AGENTS.md", "utf8"),
    readFile("templates/skills/ast-mcp/references/agents-guidance.md", "utf8"),
    readFile("templates/skills/ast-mcp/SKILL.md", "utf8"),
    readFile("templates/skills/ast-mcp/evals/batch.evals.json", "utf8"),
  ]);
  expect(reference).toBe(template);
  const managed = agents.match(
    /<!-- ast-mcp:begin -->\n\n([\s\S]*?)\n\n<!-- ast-mcp:end -->/,
  )?.[1];
  expect(managed).toBe(template.trim());
  expect(template.split("\n").length).toBeLessThanOrEqual(50);
  for (const instruction of [
    "`$ast-mcp` before local repository",
    "host-provided active skill directory",
    "global, agent-local, or project-local",
    "exact resource URI",
    "web or connector tools for remote content without local-file approval",
    "Apply local file policy when you save remote content locally",
    "`file_hash` immediately before mutation",
    "`expectedSha256`",
    "`astRules` or `aiderBlocks`",
    "`file_rename`",
    "Never request `write: true`",
    "only through `config_core` and `config_paths`",
    "Never switch to a fallback writer",
    "host controls reconnection and skill activation",
    "`ast-mcp skills update <destination>`",
    "preserve customization conflicts",
  ])
    expect(template).toContain(instruction);
  expect(template).not.toContain("evals:");
  expect(template).not.toContain("ast-mcp-eval:");
  expect(template).not.toContain("## Test layout");
  expect(agents).toContain("tests/integration/");
  expect(agents.indexOf("## Test layout")).toBeGreaterThan(
    agents.indexOf("<!-- ast-mcp:end -->"),
  );
  for (const match of skill.matchAll(/\]\((references\/[^)]+)\)/g))
    expect(
      await readFile(path.join("templates/skills/ast-mcp", match[1]), "utf8"),
    ).not.toBeEmpty();
  expect(evals).toContain('"variant": "ordered-ast-rules"');
  expect(evals).toContain(
    "Uses run only to preview or verify and sends the mutation through file_patch.",
  );
});

test("bootstrap references resolve from global and project skills and exact MCP manifests", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-guidance-"));
  try {
    const template = await readFile("templates/AGENTS.md", "utf8");
    const references = [...template.matchAll(/`(references\/[^`]+\.md)`/g)].map(
      (match) => match[1],
    );
    expect(new Set(references).size).toBe(4);
    const catalog = await bundledSkills();
    const manifest = catalog.get(SKILL_URI).skill.resources;
    for (const destination of [
      path.join(root, "home/.codex/skills/ast-mcp"),
      path.join(root, "project/.agents/skills/ast-mcp"),
    ]) {
      await exportSkills(destination);
      for (const relative of references) {
        const resource = catalog.files.find(
          (file) => file.relative === relative,
        );
        expect(resource).toBeDefined();
        const entry = manifest.find((item) => item.uri === resource!.uri);
        expect(entry).toBeDefined();
        const text = catalog.read(entry!.uri).contents[0].text;
        expect(
          await readFile(path.resolve(destination, relative), "utf8"),
        ).toBe(text);
      }
    }
    const installation = catalog.files
      .find((file) => file.relative === "references/installation.md")!
      .bytes.toString();
    for (const command of [
      "npm install --save-dev @mwillbanks/ast-mcp@latest",
      "ast-mcp update --scope global --target codex",
      "ast-mcp config migrate --output json",
      "ast-mcp config migrate --write --output json",
      "ast-mcp skills update .codex/skills/ast-mcp --output json",
    ])
      expect(installation).toContain(command);
    expect(installation).toContain(
      "The host negotiates the extension and activates the skill.",
    );
    expect(installation).toContain(
      "A skill cannot start or reconnect the server.",
    );
    expect(installation).toContain(
      "A selected local copy can shadow current MCP instructions.",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
