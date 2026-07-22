import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

test("guidance routes normal AST and Aider mutations through file_patch", async () => {
  const [agents, skill, evals] = await Promise.all([
    readFile("AGENTS.md", "utf8"),
    readFile("templates/skills/ast-mcp/SKILL.md", "utf8"),
    readFile("templates/skills/ast-mcp/evals/batch.evals.json", "utf8"),
  ]);

  for (const guidance of [agents, skill]) {
    expect(guidance).toContain("file_patch");
    expect(guidance).toContain("astRules");
    expect(guidance).toContain("aiderBlocks");
    expect(guidance).toContain("not the normal agent patch route");
  }

  expect(skill).toContain("Mutate through keyed file_patch and file_write");
  expect(evals).toContain('"variant": "ordered-ast-rules"');
  expect(evals).toContain(
    "Uses run only to preview or verify and sends the mutation through file_patch.",
  );
});
