import { describe, expect, spyOn, test } from "bun:test";

import { decisionPayload, evaluateHook, runHook } from "../../src/hooks";
import { isManagedHook, managedAstMcpHookEntry } from "../../src/hooks/managed";
import {
  isManagedHook as skillIsManagedHook,
  managedAstMcpHookEntry as skillManagedHookEntry,
} from "../../templates/skills/ast-mcp/scripts/managed-hook";

test("recognizes direct Bun and native hook commands in both hook readers", () => {
  for (const readHook of [managedAstMcpHookEntry, skillManagedHookEntry]) {
    for (const entry of [
      "./node_modules/.bin/ast-mcp-bun",
      "C:\\Program Files\\npm\\ast-mcp-bun.cmd",
      "./node_modules/@mwillbanks/ast-mcp-linux-x64/ast-mcp-bytecode",
      "C:\\Program Files\\npm\\node_modules\\@mwillbanks\\ast-mcp-windows-x64\\ast-mcp-bytecode.exe",
    ]) {
      expect(readHook(`${JSON.stringify(entry)} hook`)).toBe(entry);
      expect(readHook(`${JSON.stringify(entry)} mcp`)).toBeUndefined();
    }
    expect(readHook('"./custom/ast-mcp-bun-helper" hook')).toBeUndefined();
  }
});

test("requires exact ownership evidence for direct Bun and native hooks", () => {
  for (const ownsHook of [isManagedHook, skillIsManagedHook]) {
    const selected = '"./node_modules/.bin/ast-mcp" hook';
    const known = '"./node_modules/.bin/ast-mcp-bun" hook';
    const custom = '"/custom/ast-mcp-bytecode.exe" hook';
    const ownsPackageHook = (command: string) => command === known;
    expect(
      ownsHook({ type: "command", command: known }, "preToolUse", selected),
    ).toBeFalse();
    expect(
      ownsHook(
        { type: "command", command: known },
        "preToolUse",
        selected,
        ownsPackageHook,
      ),
    ).toBeTrue();
    expect(
      ownsHook(
        { hooks: [{ type: "command", command: custom }] },
        "PreToolUse",
        selected,
        ownsPackageHook,
      ),
    ).toBeFalse();
  }
});

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
          'const result = await tools.mcp__ast_mcp__file_hash({ filePaths: ["src/hooks/index.ts"] }); text(result);',
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

  test("uses the invoked Windows shell dialect", () => {
    for (const event of [
      { tool_input: { command: "ni file -ItemType File" }, tool_name: "pwsh" },
      {
        tool_input: { command: '[IO.File]::WriteAllText("file", "value")' },
        tool_name: "powershell",
      },
      { tool_input: { command: "dir && del file" }, tool_name: "cmd.exe" },
      { toolInput: { command: "copy source target" }, toolName: "cmd" },
      {
        tool_input: {
          command: 'powershell.exe -NoProfile -Command "sc file value"',
        },
        tool_name: "exec_command",
      },
    ])
      expect(evaluateHook(event).denied).toBeTrue();

    expect(
      evaluateHook({
        tool_input: { command: "cp source target" },
        tool_name: "exec_command",
      }).denied,
    ).toBeFalse();
    expect(
      evaluateHook({
        tool_input: { command: "Get-Content file" },
        tool_name: "powershell",
      }).denied,
    ).toBeFalse();
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
