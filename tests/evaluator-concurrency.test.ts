import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function call(callId: string, input: string) {
  return {
    payload: {
      call_id: callId,
      input,
      name: "exec",
      type: "custom_tool_call",
    },
    type: "response_item",
  };
}

function output(callId: string, text: string) {
  return {
    payload: {
      call_id: callId,
      output: [{ text }],
      type: "custom_tool_call_output",
    },
    type: "response_item",
  };
}

test("semantic scoring preserves sequential order around unrelated Promise.all calls", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-order-"));
  const sessionPath = path.join(directory, "session.jsonl");
  const context = {
    payload: { cwd: directory, workspace_roots: [directory] },
    type: "turn_context",
  };

  try {
    await writeFile(
      sessionPath,
      [
        JSON.stringify(context),
        JSON.stringify(
          call(
            "sequential",
            '// ast-mcp-eval:75\nawait tools.mcp__ast_mcp__file_hash({ filePaths: ["notes/existing.txt"] });\nawait Promise.all([tools.mcp__ast_mcp__search({ query: "unrelated" })]);\nawait tools.mcp__ast_mcp__file_write({\n  "notes/new.txt": { content: "new" },\n  "notes/existing.txt": { content: "next", expectedSha256: "abc" },\n});',
          ),
        ),
        JSON.stringify(
          output(
            "sequential",
            '{"files":{"notes/new.txt":{"created":true},"notes/existing.txt":{"created":false}}}',
          ),
        ),
      ].join("\n"),
    );
    const process = Bun.spawn(
      ["bun", "run", "templates/skills/ast-mcp/evals/measure.ts", sessionPath],
      { stderr: "pipe", stdout: "pipe" },
    );
    const [stdout, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      process.exited,
    ]);
    expect(exitCode).toBe(1);
    expect(stdout).toContain(
      "eval 75 uses nested exec evidence that cannot be bound to individual MCP results",
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
