import { describe, expect, test } from "bun:test";
import {
  configuredHostSmokeChecks,
  type HostSmokeCheck,
  main,
  runHostSmokeChecks,
} from "../src/host-smoke";

describe("optional live host smoke checks", () => {
  test("disables every host by default", () => {
    expect(configuredHostSmokeChecks({})).toEqual([]);
  });

  test("discovers arbitrary opt-in hosts from environment definitions", () => {
    const checks = configuredHostSmokeChecks({
      AST_MCP_HOST_SMOKE_ALPHA: JSON.stringify({
        command: ["alpha-host", "--print", "read-only prompt"],
        expect: "generation",
      }),
      AST_MCP_HOST_SMOKE_CUSTOM_HOST: JSON.stringify({
        command: ["custom-host", "smoke"],
        expect: ["config_status", "generation"],
        timeoutMs: 1_000,
      }),
      AST_MCP_HOST_SMOKE_TIMEOUT_MS: "90000",
    });

    expect(checks).toEqual([
      {
        command: ["alpha-host", "--print", "read-only prompt"],
        expect: ["generation"],
        name: "alpha",
        timeoutMs: 90_000,
      },
      {
        command: ["custom-host", "smoke"],
        expect: ["config_status", "generation"],
        name: "custom-host",
        timeoutMs: 1_000,
      },
    ]);
  });

  test("rejects malformed opt-in definitions before spawning", () => {
    expect(() =>
      configuredHostSmokeChecks({
        AST_MCP_HOST_SMOKE_ALPHA: JSON.stringify({
          command: "alpha-host smoke",
        }),
      }),
    ).toThrow("command must be a non-empty string array");
    expect(() =>
      configuredHostSmokeChecks({
        AST_MCP_HOST_SMOKE_ALPHA: JSON.stringify({
          command: ["alpha-host"],
          shell: true,
        }),
      }),
    ).toThrow("contains unsupported keys: shell");
  });

  test("runs only configured checks and verifies required markers", async () => {
    const checks: HostSmokeCheck[] = [
      {
        command: ["first"],
        expect: ["config_status"],
        name: "first",
        timeoutMs: 1_000,
      },
      {
        command: ["second"],
        expect: [],
        name: "second",
        timeoutMs: 1_000,
      },
    ];
    const invoked: string[] = [];

    await expect(
      runHostSmokeChecks(checks, async (check) => {
        invoked.push(check.name);
        return { exitCode: 0, output: `${check.name} config_status` };
      }),
    ).resolves.toEqual(["first", "second"]);
    expect(invoked.sort()).toEqual(["first", "second"]);
  });

  test("fails an enabled host without exposing its output", async () => {
    const check: HostSmokeCheck = {
      command: ["host"],
      expect: [],
      name: "host",
      timeoutMs: 1_000,
    };

    await expect(
      runHostSmokeChecks([check], async () => ({
        exitCode: 7,
        output: "sensitive host output",
      })),
    ).rejects.toThrow(
      'Host smoke "host" failed with exit code 7; external output is suppressed',
    );
  });

  test("validates opt-in JSON and timeout bounds", () => {
    expect(
      configuredHostSmokeChecks({ AST_MCP_HOST_SMOKE_TIMEOUT_MS: "0" }),
    ).toEqual([]);
    expect(() =>
      configuredHostSmokeChecks({
        AST_MCP_HOST_SMOKE_ALPHA: JSON.stringify({ command: ["alpha-host"] }),
        AST_MCP_HOST_SMOKE_TIMEOUT_MS: "0",
      }),
    ).toThrow("must be an integer between 1 and 600000");
    expect(() =>
      configuredHostSmokeChecks({ AST_MCP_HOST_SMOKE_ALPHA: "{" }),
    ).toThrow("must contain valid JSON");
    expect(() =>
      configuredHostSmokeChecks({ AST_MCP_HOST_SMOKE_ALPHA: "[]" }),
    ).toThrow("must contain a JSON object");
    expect(() =>
      configuredHostSmokeChecks({
        AST_MCP_HOST_SMOKE_ALPHA: JSON.stringify({
          command: ["alpha-host"],
          expect: [],
        }),
      }),
    ).toThrow("expect must be a non-empty string or string array");
  });

  test("reports runner, timeout, and marker failures", async () => {
    const check: HostSmokeCheck = {
      command: ["host"],
      expect: ["generation"],
      name: "host",
      timeoutMs: 10,
    };
    await expect(
      runHostSmokeChecks([check], async () => {
        throw new Error("unavailable");
      }),
    ).rejects.toThrow('Host smoke "host" could not start: unavailable');
    await expect(
      runHostSmokeChecks([check], async () => ({
        exitCode: 0,
        output: "",
        timedOut: true,
      })),
    ).rejects.toThrow('Host smoke "host" exceeded 10ms');
    await expect(
      runHostSmokeChecks([check], async () => ({
        exitCode: 0,
        output: "config_status",
      })),
    ).rejects.toThrow(
      'Host smoke "host" did not emit required markers: generation',
    );
  });

  test("runs shell-free local commands and enforces timeouts", async () => {
    const success: HostSmokeCheck = {
      command: [
        process.execPath,
        "-e",
        'console.log("config_status generation")',
      ],
      expect: ["config_status", "generation"],
      name: "local",
      timeoutMs: 1_000,
    };
    await expect(runHostSmokeChecks([success])).resolves.toEqual(["local"]);
    const slow: HostSmokeCheck = {
      command: [process.execPath, "-e", "await Bun.sleep(500)"],
      expect: [],
      name: "slow",
      timeoutMs: 5,
    };
    await expect(runHostSmokeChecks([slow])).rejects.toThrow(
      'Host smoke "slow" exceeded 5ms',
    );
  });

  test("main skips by default and runs only explicit definitions", async () => {
    await expect(main({})).resolves.toEqual([]);
    await expect(
      main({
        AST_MCP_HOST_SMOKE_LOCAL: JSON.stringify({
          command: [
            process.execPath,
            "-e",
            'console.log("config_status generation")',
          ],
          expect: ["config_status", "generation"],
        }),
      }),
    ).resolves.toEqual(["local"]);
  });
});
