import { expect, test } from "bun:test";
import { evaluateHook } from "../src/hook";

test("hook routes common manual mutation without policing general commands", () => {
  for (const command of ["find src -delete", "printf '%s' x | xargs rm"])
    expect(
      evaluateHook({ tool_input: { command }, tool_name: "bash" }).denied,
    ).toBeTrue();

  for (const command of [
    "mkdir generated",
    "rmdir generated",
    "chmod 600 secret.txt",
    "chown 1:1 secret.txt",
    "sed -n '1p' src/file.ts",
    "ast-grep run --pattern 'identifier'",
    "rg symbol src",
  ])
    expect(
      evaluateHook({ tool_input: { command }, tool_name: "bash" }).denied,
    ).toBeFalse();
});
