import { expect, test } from "bun:test";
import { evaluateHook } from "../src/hook";

test("hook blocks unsupported lifecycle mutations and direct ast-grep", () => {
  for (const command of [
    "mkdir generated",
    "rmdir generated",
    "chmod 600 secret.txt",
    "chown 1:1 secret.txt",
    "find src -delete",
    "printf '%s' x | xargs rm",
    "sed -n '1p' src/file.ts",
    "ast-grep run --pattern '$A'",
  ])
    expect(
      evaluateHook({ tool_input: { command }, tool_name: "bash" }).denied,
    ).toBeTrue();

  expect(
    evaluateHook({
      tool_input: { command: "rg symbol src" },
      tool_name: "bash",
    }).denied,
  ).toBeFalse();
});
