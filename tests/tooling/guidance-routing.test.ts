import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

test("guidance routes normal AST and Aider mutations through file_patch", async () => {
  const [agents, templateAgents, skill, agentReference, evals] =
    await Promise.all([
      readFile("AGENTS.md", "utf8"),
      readFile("templates/AGENTS.md", "utf8"),
      readFile("templates/skills/ast-mcp/SKILL.md", "utf8"),
      readFile(
        "templates/skills/ast-mcp/references/agents-guidance.md",
        "utf8",
      ),
      readFile("templates/skills/ast-mcp/evals/batch.evals.json", "utf8"),
    ]);

  for (const guidance of [agents, skill]) {
    expect(guidance).toContain("file_patch");
    expect(guidance).toContain("astRules");
    expect(guidance).toContain("aiderBlocks");
    expect(guidance).toContain("not the normal agent patch route");
  }

  for (const guidance of [agents, templateAgents, skill, agentReference]) {
    expect(guidance).toContain("connected tools for remote content");
    expect(guidance).toContain("without requesting local");
    expect(guidance).toContain("saved locally");
    expect(guidance).toContain("normal local file policy");
    expect(guidance).toContain("file_rename");
    expect(guidance).toContain("destination");
  }

  expect(agents).toContain("## Test layout");
  expect(agents).toContain("tests/integration/");
  expect(agents.indexOf("## Test layout")).toBeGreaterThan(
    agents.indexOf("<!-- ast-mcp:end -->"),
  );
  expect(templateAgents).not.toContain("## Test layout");
  expect(skill).toContain("Mutate through declared file batches");
  expect(evals).toContain('"variant": "ordered-ast-rules"');
  expect(evals).toContain(
    "Uses run only to preview or verify and sends the mutation through file_patch.",
  );
});
