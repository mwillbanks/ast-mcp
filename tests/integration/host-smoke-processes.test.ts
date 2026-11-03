import { describe, expect, test } from "bun:test";

import {
  configuredHostSmokeChecks,
  type HostSmokeCheck,
  main,
  runHostSmokeChecks,
} from "../../scripts/testing/host-smoke";

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

test("relocated script preserves CLI output and error exits", async () => {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !name.startsWith("AST_MCP_HOST_SMOKE_"),
    ),
  ) as Record<string, string>;
  const script = Bun.fileURLToPath(
    new URL("../../scripts/testing/host-smoke.ts", import.meta.url),
  );
  for (const [extra, exitCode, marker] of [
    [{}, 0, "Host smoke checks skipped"],
    [{ AST_MCP_HOST_SMOKE_BROKEN: "{" }, 1, "must contain valid JSON"],
    [
      {
        AST_MCP_HOST_SMOKE_LOCAL: JSON.stringify({
          command: [process.execPath, "-e", 'console.log("ready")'],
          expect: ["ready"],
        }),
      },
      0,
      "Host smoke checks passed: local",
    ],
  ] as const) {
    const started = performance.now();
    const child = Bun.spawn([process.execPath, script], {
      env: { ...environment, ...extra },
      stderr: "pipe",
      stdout: "pipe",
    });
    const [status, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(status, stderr).toBe(exitCode);
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(exitCode === 0 ? stdout : stderr).toContain(marker);
    expect(exitCode === 0 ? stderr : stdout).toBe("");
  }
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

test("oversized host output terminates the command and reports the read failure", async () => {
  await expect(
    runHostSmokeChecks([
      {
        command: [
          process.execPath,
          "-e",
          "process.stdout.write(Buffer.alloc(17*1024*1024,65)); await Bun.sleep(10000);",
        ],
        expect: [],
        name: "overflow",
        timeoutMs: 5000,
      },
    ]),
  ).rejects.toThrow(
    'Host smoke "overflow" could not start: command output exceeded',
  );
});

test.skipIf(process.platform === "win32")(
  "times POSIX inherited pipes after a smoke command exits",
  async () => {
    const script = `Bun.spawn([process.execPath, "-e", "await Bun.sleep(800)"], { stdin: "ignore", stdout: "inherit", stderr: "inherit" }); process.exit(0)`;
    const start = performance.now();
    await expect(
      runHostSmokeChecks([
        {
          command: [process.execPath, "-e", script],
          expect: [],
          name: "descendant",
          timeoutMs: 100,
        },
      ]),
    ).rejects.toThrow('Host smoke "descendant" exceeded 100ms');
    expect(performance.now() - start).toBeLessThan(700);
  },
);
