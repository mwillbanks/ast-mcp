import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("transcript evaluator rejects semantically empty nested exec calls", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-spoof-"));
  const sessionPath = path.join(directory, "session.jsonl");
  try {
    await writeFile(
      sessionPath,
      [
        JSON.stringify({
          payload: {
            call_id: "exec-spoof",
            input:
              "// ast-mcp-eval:71\nawait tools.mcp__ast_mcp__file_hash({});",
            name: "exec",
            type: "custom_tool_call",
          },
          type: "response_item",
        }),
        JSON.stringify({
          payload: {
            call_id: "exec-spoof",
            output: [{ text: '{"filePath":"src/server.ts"}' }],
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
    const [stdout, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      process.exited,
    ]);
    expect(exitCode).toBe(1);
    expect(stdout).toContain('"evaluatedCases":1');
    expect(stdout).toContain(
      "eval 71 uses nested exec evidence that cannot be bound to individual MCP results",
    );
    expect(stdout).toContain('"verifiedAssertions":0');
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("transcript evaluator isolates each eval marker", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-markers-"));
  const sessionPath = path.join(directory, "session.jsonl");
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
            call_id: "direct-markers",
            input:
              '// ast-mcp-eval:71\n// ast-mcp-eval:72\n{ filePaths: ["src/server.ts"] }',
            name: "mcp__ast_mcp__file_hash",
            type: "custom_tool_call",
          },
          type: "response_item",
        }),
        JSON.stringify({
          payload: {
            call_id: "direct-markers",
            output: [{ text: '{"filePath":"src/server.ts","sha256":"abc"}' }],
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
    const [stdout, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      process.exited,
    ]);
    expect(exitCode).toBe(1);
    expect(stdout).toContain(
      "carries multiple eval markers; evidence must be isolated per case",
    );
    expect(stdout).toContain('"verifiedAssertions":0');
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("user eval prompts bind following direct MCP records", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-prompt-"));
  const sessionPath = path.join(directory, "session.jsonl");
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
            content: [{ text: "ast-mcp-eval:71", type: "input_text" }],
            role: "user",
            type: "message",
          },
          type: "response_item",
        }),
        JSON.stringify({
          payload: {
            call_id: "direct-prompt",
            input: '{ filePaths: ["src/server.ts"] }',
            name: "mcp__ast_mcp__file_hash",
            type: "custom_tool_call",
          },
          type: "response_item",
        }),
        JSON.stringify({
          payload: {
            call_id: "direct-prompt",
            output: [
              {
                text: '{"filePath":"src/server.ts","sha256":"abc","size":1}',
              },
            ],
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
    const [stdout, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      process.exited,
    ]);
    expect(exitCode).toBe(0);
    const score = JSON.parse(stdout);
    expect(score.passed).toBeTrue();
    expect(score.evaluatedCases).toBe(1);
    expect(score.verifiedAssertions).toBe(3);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
