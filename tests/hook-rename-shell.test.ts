import { expect, test } from "bun:test";
import { evaluateHook } from "../src/hook";

test("hook routes manual renames but leaves Git to the host", () => {
  for (const command of [
    "rename source destination",
    "xargs mv source destination",
    "busybox mv source destination",
    "/usr/bin/rename source destination",
    "sudo mv source destination",
  ])
    expect(
      evaluateHook({ tool_input: { command }, tool_name: "exec" }).denied,
    ).toBeTrue();

  for (const command of [
    "git mv source destination",
    "env git mv source destination",
    "env FOO=bar git mv source destination",
    "git -C repo mv source destination",
    "git -c key=value mv source destination",
    "git --work-tree=. mv source destination",
    "git --no-pager mv source destination",
    "/usr/bin/git mv source destination",
    "sudo -u user git mv source destination",
  ])
    expect(
      evaluateHook({ tool_input: { command }, tool_name: "exec" }).denied,
    ).toBeFalse();
});
