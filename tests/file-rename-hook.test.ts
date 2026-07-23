import { expect, test } from "bun:test";
import { evaluateHook } from "../src/hook";

test("hook blocks direct rename tools and nested rename calls", () => {
  for (const toolName of [
    "rename",
    "renameFile",
    "move",
    "moveFile",
    "fileRename",
  ]) {
    expect(evaluateHook({ tool_name: toolName }).denied).toBeTrue();
  }
  expect(
    evaluateHook({
      tool_input: {
        command: 'tools.rename({ source: "a", destination: "b" })',
      },
      tool_name: "exec",
    }).denied,
  ).toBeTrue();
});
