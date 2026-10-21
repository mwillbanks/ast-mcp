import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function call(callId: string, input: string, name = "exec") {
  return {
    payload: {
      call_id: callId,
      input,
      name,
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

test("semantic scoring ignores comment-only nested MCP input", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-comment-"));
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
            "comment-only",
            "// ast-mcp-eval:71\n{\n  /* filePaths: [src/server.ts] */\n}",
            "mcp__ast_mcp__file_hash",
          ),
        ),
        JSON.stringify(
          output(
            "comment-only",
            '{"filePath":"src/server.ts","sha256":"abc","size":1}',
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
    expect(stdout).toContain("file_hash has empty or schema-incomplete input");
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
