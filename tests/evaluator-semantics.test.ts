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

async function measure(sessionPath: string) {
  const process = Bun.spawn(
    ["bun", "run", "templates/skills/ast-mcp/evals/measure.ts", sessionPath],
    { stderr: "pipe", stdout: "pipe" },
  );
  const [stdout, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    process.exited,
  ]);
  return { exitCode, stdout };
}

test("transcript semantics enforce roots, sequence, expected output, and assertions", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-semantic-"));
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
            "valid",
            '// ast-mcp-eval:71\nawait tools.mcp__ast_mcp__file_hash({ filePaths: ["src/server.ts"] });',
            "mcp__ast_mcp__file_hash",
          ),
        ),
        JSON.stringify(
          output(
            "valid",
            '{"filePath":"src/server.ts","sha256":"abc","size":1}',
          ),
        ),
      ].join("\n"),
    );
    const valid = await measure(sessionPath);
    expect(valid.exitCode).toBe(0);
    expect(valid.stdout).toContain('"verifiedAssertions":3');

    await writeFile(
      sessionPath,
      [
        JSON.stringify(context),
        JSON.stringify(
          call(
            "outside",
            '// ast-mcp-eval:71\nawait tools.mcp__ast_mcp__file_hash({ filePaths: ["/etc/hosts"] });',
            "mcp__ast_mcp__file_hash",
          ),
        ),
        JSON.stringify(output("outside", '{"filePath":"/etc/hosts"}')),
      ].join("\n"),
    );
    const outside = await measure(sessionPath);
    expect(outside.exitCode).toBe(1);
    expect(outside.stdout).toContain(
      "file_hash input escapes transcript workspace roots: /etc/hosts",
    );

    await writeFile(
      sessionPath,
      [
        JSON.stringify(context),
        JSON.stringify(
          call(
            "concurrent",
            `// ast-mcp-eval:75
await Promise.all([
  tools.mcp__ast_mcp__file_hash({ filePaths: ["notes/existing.txt"] }),
  tools.mcp__ast_mcp__file_write({
    "notes/new.txt": { content: "new" },
    "notes/existing.txt": { content: "next", expectedSha256: "abc" },
  }),
]);`,
          ),
        ),
        JSON.stringify(output("concurrent", '{"files":{"notes/new.txt":{}}}')),
      ].join("\n"),
    );
    const concurrent = await measure(sessionPath);
    expect(concurrent.exitCode).toBe(1);
    expect(concurrent.stdout).toContain(
      "eval 75 uses nested exec evidence that cannot be bound to individual MCP results",
    );
    await writeFile(
      sessionPath,
      [
        JSON.stringify(context),
        JSON.stringify(
          call(
            "spoof",
            '// ast-mcp-eval:71\nconst claim = "tools.mcp__ast_mcp__file_hash({ filePaths: [\\"src/server.ts\\"] })";',
          ),
        ),
        JSON.stringify(output("spoof", '{"filePath":"src/server.ts"}')),
      ].join("\n"),
    );
    const spoof = await measure(sessionPath);
    expect(spoof.exitCode).toBe(0);
    expect(spoof.stdout).toContain('"evaluatedCases":0');
    expect(spoof.stdout).toContain('"toolCalls":{}');
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
