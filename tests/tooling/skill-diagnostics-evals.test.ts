import { expect, test } from "bun:test";

const semanticModule = new URL(
  "../../templates/skills/ast-mcp/evals/semantic.ts",
  import.meta.url,
).href;

for (const tool of ["diagnostics", "approval_probe"]) {
  test(`semantic evaluator accepts the strict empty ${tool} input`, () => {
    // Keep template evaluation sources outside the repository TypeScript project.
    const script = `
      import { verifyEvaluation } from ${JSON.stringify(semanticModule)};
      const tool = ${JSON.stringify(tool)};
      const evaluation = {
        id: 221, assertions: [], expected_output: "Observed result",
        files: [], forbidden_tools: [], required_tools: [tool],
      };
      const inputs = ["{}", "{ }", "{ /* inspected */ }", "", '{"target":"codex"}', '{"approved":true}', "[]"];
      console.log(JSON.stringify(inputs.map(input => verifyEvaluation(
        evaluation, [{ index: 0, input, tool }], "Observed result", ["/workspace"],
      ))));
    `;
    const result = Bun.spawnSync([process.execPath, "--eval", script], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
    const errors = JSON.parse(result.stdout.toString()) as string[][];
    expect(errors).toHaveLength(7);
    const failure = tool + " has empty or schema-incomplete input";
    for (const entry of errors.slice(0, 3)) {
      expect(entry).not.toContain(failure);
    }
    for (const entry of errors.slice(3)) {
      expect(entry).toContain(failure);
    }
  });
}
