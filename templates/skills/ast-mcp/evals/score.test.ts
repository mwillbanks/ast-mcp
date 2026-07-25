import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scoreTranscript } from "./score";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function transcript(lines: string[]) {
  const directory = await mkdtemp(join(tmpdir(), "ast-mcp-score-"));
  directories.push(directory);
  const sessionPath = join(directory, "session.jsonl");
  await writeFile(sessionPath, lines.join("\n"));
  return { directory, sessionPath };
}

function record(type: string, payload: Record<string, unknown>) {
  return JSON.stringify({ payload, type });
}

test("reports malformed and unmatched transcript records", async () => {
  const { sessionPath } = await transcript([
    "not-json",
    record("response_item", {
      call_id: "orphan",
      output: "unmatched",
      type: "custom_tool_call_output",
    }),
  ]);

  const score = await scoreTranscript(sessionPath, true);
  expect(score.passed).toBe(false);
  expect(score.errors).toContain("line 1: invalid JSON");
  expect(score.errors).toContain("unmatched output ID: orphan");
  expect(score.errors).toContain(
    "strict scoring requires at least one ast-mcp-eval marker",
  );
});

test("binds direct calls to their marker and counts tool output", async () => {
  const { sessionPath } = await transcript([
    record("turn_context", {
      cwd: process.cwd(),
      workspace_roots: [process.cwd()],
    }),
    record("response_item", {
      content: "ast-mcp-eval:999",
      role: "user",
      type: "message",
    }),
    record("response_item", {
      call_id: "hash-call",
      input: { filePaths: ["fixture.ts"] },
      name: "mcp__ast_mcp__file_hash",
      type: "custom_tool_call",
    }),
    record("response_item", {
      call_id: "hash-call",
      output: [{ text: "hash output", type: "input_text" }],
      type: "custom_tool_call_output",
    }),
  ]);

  const score = await scoreTranscript(sessionPath);
  expect(score.execBatches).toBe(1);
  expect(score.evaluatedCases).toBe(1);
  expect(score.toolCalls.file_hash).toBe(1);
  expect(score.astMcpOutputChars).toBe(11);
  expect(score.errors).toContain("unknown eval ID: 999");
});

test("rejects nested exec evidence and duplicate identifiers", async () => {
  const source = `// ast-mcp-eval:91\ntext(await tools.mcp__ast_mcp__file_rename({"a.ts":{"expectedSha256":"abc","destination":"b.ts"}}));`;
  const { sessionPath } = await transcript([
    record("response_item", {
      call_id: "nested",
      input: source,
      name: "exec",
      type: "custom_tool_call",
    }),
    record("response_item", {
      call_id: "nested",
      input: source,
      name: "exec",
      type: "custom_tool_call",
    }),
    record("response_item", {
      call_id: "nested",
      output: "renamed",
      type: "custom_tool_call_output",
    }),
    record("response_item", {
      call_id: "nested",
      output: "duplicate",
      type: "custom_tool_call_output",
    }),
  ]);

  const score = await scoreTranscript(sessionPath);
  expect(score.errors).toContain("duplicate call ID: nested");
  expect(score.errors).toContain("duplicate output ID: nested");
  expect(score.errors).toContain(
    "eval 91 uses nested exec evidence that cannot be bound to individual MCP results",
  );
});
