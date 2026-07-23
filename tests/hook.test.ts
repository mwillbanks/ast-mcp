import { describe, expect, spyOn, test } from "bun:test";
import { decisionPayload, evaluateHook, runHook } from "../src/hook";

describe("agent hook", () => {
  test("blocks direct edit tools", () => {
    expect(
      evaluateHook({ tool_input: {}, tool_name: "apply_patch" }).denied,
    ).toBeTrue();
    expect(
      evaluateHook({ toolInput: {}, toolName: "editFiles" }).denied,
    ).toBeTrue();
  });
  test("blocks shell escape hatches", () => {
    expect(
      evaluateHook({
        tool_input: { cmd: "sed -i s/a/b/ file" },
        tool_name: "exec_command",
      }).denied,
    ).toBeTrue();
    expect(
      evaluateHook({
        tool_input: { command: "node -e \"writeFileSync('blocked', 'x')\"" },
        tool_name: "bash",
      }).denied,
    ).toBeTrue();
    expect(
      evaluateHook({
        tool_input: { command: "rg value src" },
        tool_name: "bash",
      }).denied,
    ).toBeFalse();
    expect(
      evaluateHook({
        tool_input: { command: "rg value src 2>/dev/null" },
        tool_name: "bash",
      }).denied,
    ).toBeFalse();
  });

  test("does not treat oversized input as a security boundary", () => {
    expect(
      evaluateHook({
        tool_input: {
          command: ["env ".repeat(100_000), "touch allowed-by-host"].join(""),
        },
        tool_name: "bash",
      }).denied,
    ).toBeFalse();
  });

  test("routes known bypasses without policing host-governed commands", () => {
    const blockedSources = [
      'const result = await tools.exec_command({ cmd: "touch /tmp/blocked" }); text(result);',
      'const result = await tools.exec_command ({ cmd: "touch /tmp/blocked" }); text(result);',
      'const result = await tools.exec_command?.({ cmd: "touch /tmp/blocked" }); text(result);',
      'const result = await tools?.exec_command({ cmd: "touch /tmp/blocked" }); text(result);',
      'const result = await tools.exec_command /* route */ ({ cmd: "touch /tmp/blocked" }); text(result);',
      'const result = await tools.bash({ command: "touch /tmp/blocked" }); text(result);',
      'const result = await tools.apply_patch("*** Begin Patch"); text(result);',
      'const result = await tools.apply_patch ({ patch: "*** Begin Patch" }); text(result);',
      'const result = await tools.apply_patch?.({ patch: "*** Begin Patch" }); text(result);',
      'const result = await tools?.apply_patch({ patch: "*** Begin Patch" }); text(result);',
      'const result = await tools.writeFile({ path: "/tmp/blocked" }); text(result);',
      'const result = await tools["apply_patch"]("*** Begin Patch"); text(result);',
    ];
    for (const source of blockedSources)
      for (const tool_name of [
        "exec",
        "functions.exec",
        "mcp__functions__exec",
        "codex.exec",
      ])
        expect(
          evaluateHook({ tool_input: source, tool_name }).denied,
        ).toBeTrue();

    for (const command of [
      "env touch /tmp/blocked",
      "command touch /tmp/blocked",
      "/usr/bin/touch /tmp/blocked",
      "sudo touch /tmp/blocked",
      "nice touch /tmp/blocked",
      "nohup touch /tmp/blocked",
      "busybox touch /tmp/blocked",
      "timeout 5 touch /tmp/blocked",
    ])
      expect(
        evaluateHook({ tool_input: { command }, tool_name: "exec_command" })
          .denied,
      ).toBeTrue();

    expect(
      evaluateHook({
        tool_input:
          'const result = await tools.mcp__ast_mcp__file_hash({ filePaths: ["src/hook.ts"] }); text(result);',
        tool_name: "exec",
      }).denied,
    ).toBeFalse();
    for (const command of [
      "git clone ./src ./dst",
      "git checkout -- file",
      "git clean -fd",
      "printf text > generated.log",
      "bun run generate | tee generated.log",
      "cp source target",
      "mkdir generated",
    ])
      expect(
        evaluateHook({ tool_input: { command }, tool_name: "exec_command" })
          .denied,
      ).toBeFalse();
    expect(
      evaluateHook({
        tool_input:
          'const result = await tools.exec_command({ cmd: "git checkout -- file > report.log" }); text(result);',
        tool_name: "exec",
      }).denied,
    ).toBeFalse();
  });
  test("recognizes shell aliases and object-wrapped executor source", () => {
    expect(
      evaluateHook({
        tool_input: { command: "touch blocked" },
        tool_name: "pwsh",
      }).denied,
    ).toBeTrue();
    expect(
      evaluateHook({
        tool_input: {
          code: 'const r = await tools.exec_command({ cmd: "touch blocked" })',
        },
        tool_name: "exec",
      }).denied,
    ).toBeTrue();
  });

  test("emits compatible denial payloads", () => {
    const payload = decisionPayload({ denied: true, reason: "no" }) as {
      hookSpecificOutput: { permissionDecision: string };
      permissionDecision: string;
    };
    expect(payload.permissionDecision).toBe("deny");
    expect(payload.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(decisionPayload({ denied: false })).toEqual({});
  });
  test("runs hook protocol output for valid and invalid input", async () => {
    const write = spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      expect(await runHook(Promise.resolve({ tool_name: "Write" }))).toBe(0);
      expect(await runHook(Promise.reject(new Error("bad input")))).toBe(2);
      expect(write).toHaveBeenCalledTimes(2);
    } finally {
      write.mockRestore();
    }
  });
});
