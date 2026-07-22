import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("evals:measure reads nested ast-mcp calls from a real Codex exec transcript", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ast-mcp-eval-"));
  const sessionPath = join(directory, "session.jsonl");
  try {
    await writeFile(
      sessionPath,
      [
        JSON.stringify({
          payload: { cwd: directory, workspace_roots: [directory] },
          type: "turn_context",
        }),
        JSON.stringify({
          payload: {
            call_id: "call-1",
            input: `const hash = await tools.mcp__ast_mcp__file_hash({ filePaths: ["fixture.ts"] });
const patched = await tools.mcp__ast_mcp__file_patch({
  "fixture.ts": {
    expectedSha256: "abc",
    patchStrategy: "ast",
    astRules: [{ pattern: "old()", fix: "next()", expectedMatches: 1 }],
  },
});
text(JSON.stringify({ hash, patched }));`,
            name: "exec",
            type: "custom_tool_call",
          },
          type: "response_item",
        }),
        JSON.stringify({
          payload: {
            call_id: "call-1",
            output: [{ text: "measured output", type: "input_text" }],
            type: "custom_tool_call_output",
          },
          type: "response_item",
        }),
        JSON.stringify({
          payload: {
            call_id: "call-shell",
            input: "text(await tools.exec_command({ cmd: 'git status' }));",
            name: "exec",
            type: "custom_tool_call",
          },
          type: "response_item",
        }),
        JSON.stringify({
          payload: {
            call_id: "call-shell",
            output: [{ text: "unrelated output", type: "input_text" }],
            type: "custom_tool_call_output",
          },
          type: "response_item",
        }),
      ].join("\n"),
    );

    const process = Bun.spawn(
      ["bun", "run", "templates/skills/ast-mcp/evals/measure.ts", sessionPath],
      { stderr: "pipe", stdout: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain('"file_hash":1');
    expect(stdout).toContain('"file_patch":1');
    expect(stdout).toContain('"mutationCalls":1');
    expect(stdout).toContain('"astMcpOutputChars":15');
    expect(stdout).toContain('"errors":[]');
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
