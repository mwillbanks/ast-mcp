import { expect, test } from "bun:test";

import {
  eventCommand,
  policyMatches,
  toolIdentity,
} from "../../src/helpers/hook";

test("normalizes host aliases and matches case-insensitive qualified or short tool names", () => {
  expect(toolIdentity({})).toEqual({
    name: "",
    normalizedName: "",
    shortName: "",
  });
  for (const event of [
    { tool_name: "TOOLS.Run" },
    { toolName: "TOOLS.Run" },
    { name: "TOOLS.Run" },
  ]) {
    const identity = toolIdentity(event);
    expect(identity.shortName).toBe("run");
    expect(policyMatches(["missing", "RUN"], identity)).toBeTrue();
    expect(policyMatches(["TOOLS.RUN"], identity)).toBeTrue();
    expect(policyMatches(["runner"], identity)).toBeFalse();
  }
});

test("extracts raw commands across host argument aliases and rejects absent command text", () => {
  for (const alias of [
    "tool_input",
    "toolInput",
    "toolArgs",
    "input",
    "args",
  ]) {
    expect(eventCommand({ [alias]: "echo ready" })).toEqual({
      command: "echo ready",
      raw: "echo ready",
    });
    for (const key of ["cmd", "command", "script", "source", "code"]) {
      const raw = { [key]: "echo ready" };
      expect(eventCommand({ [alias]: raw })).toEqual({
        command: "echo ready",
        raw,
      });
    }
  }
  expect(eventCommand({})).toEqual({ command: "", raw: undefined });
  expect(eventCommand({ input: 42 })).toEqual({ command: "", raw: 42 });
  expect(eventCommand({ input: {} })).toEqual({ command: "", raw: {} });
});
