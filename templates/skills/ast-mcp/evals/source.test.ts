import { expect, test } from "bun:test";
import {
  executableSource,
  extractExecInvocations,
  isInsidePromiseAll,
} from "./source";

test("masks quoted and commented source without shifting offsets", () => {
  const source = `const visible = true; // tools.mcp__ast_mcp__file_hash({})\nconst quoted = "tools.mcp__ast_mcp__file_read({})";\n/* hidden */ tools.mcp__ast_mcp__map({ paths: ["src"] });`;
  const executable = executableSource(source);
  expect(executable.length).toBe(source.length);
  expect(executable).not.toContain("file_hash");
  expect(executable).not.toContain("file_read");
  expect(executable).toContain("tools.mcp__ast_mcp__map");
});

test("extracts nested inputs and identifies Promise.all concurrency", () => {
  const source = `await Promise.all([\n  tools.mcp__ast_mcp__file_hash({ filePaths: ["a.ts", call("b.ts")] }),\n  tools.mcp__ast_mcp__map({ paths: ["src"] }),\n]);`;
  const invocations = extractExecInvocations(source);
  expect(invocations).toEqual([
    {
      concurrent: true,
      input: `{ filePaths: ["a.ts", call("b.ts")] }`,
      tool: "file_hash",
    },
    {
      concurrent: true,
      input: `{ paths: ["src"] }`,
      tool: "map",
    },
  ]);
  expect(
    isInsidePromiseAll(source, source.indexOf("tools.mcp__ast_mcp__map")),
  ).toBe(true);
});

test("ignores unterminated calls and preserves parentheses inside quotes", () => {
  const source = `tools.mcp__ast_mcp__search({ query: "call())" });\ntools.mcp__ast_mcp__show({ path: "open"`;
  expect(extractExecInvocations(source)).toEqual([
    {
      concurrent: false,
      input: `{ query: "call())" }`,
      tool: "search",
    },
  ]);
});
