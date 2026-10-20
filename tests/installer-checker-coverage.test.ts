import { expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { verifyMcpLaunch } from "../src/installer-health";
import { httpEndpoint } from "../src/installer-transport";
import { createServicePlan } from "../src/service";
import {
  checkInstall,
  smokeMcpStdio,
} from "../templates/skills/ast-mcp/scripts/check-install";

test("installer reports input stream errors without losing diagnostics", async () => {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => true,
  });
  const spawn = spyOn(childProcess, "spawn").mockImplementation(() => {
    queueMicrotask(() => {
      child.stderr.write("broken input");
      child.stdin.emit("error", new Error("EPIPE"));
    });
    return child as never;
  });
  try {
    await expect(
      verifyMcpLaunch({ command: "fixture", args: [] }),
    ).rejects.toThrow("MCP launch input failed: EPIPE\nStderr: broken input");
  } finally {
    spawn.mockRestore();
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
  }
});

test("installer rejects malformed protocol and excessive output", async () => {
  for (const [code, diagnostic] of [
    [
      'process.stdout.write("invalid\\n"); setInterval(() => {}, 60000);',
      "JSON",
    ],
    [
      'process.stdout.write("x".repeat(11 * 1024 * 1024)); setInterval(() => {}, 60000);',
      "output exceeded",
    ],
    [
      'process.stderr.write("x".repeat(11 * 1024 * 1024)); setInterval(() => {}, 60000);',
      "diagnostic output exceeded",
    ],
  ]) {
    await expect(
      verifyMcpLaunch({ command: process.execPath, args: ["-e", code] }),
    ).rejects.toThrow(diagnostic);
  }
});

test("checker validates supported service arguments and rejects unsupported Windows services", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-service-parser-"));
  const root = await mkdtemp(
    path.join(os.tmpdir(), "ast-mcp-service-parser-root-"),
  );
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    const nativePlatform = process.platform;
    const alias = path.join(root, "node_modules/.bin/ast-mcp");
    await mkdir(path.dirname(alias), { recursive: true });
    await writeFile(alias, "#!/bin/sh\nexit 0\n");
    await chmod(alias, 0o755);
    const plan = createServicePlan({
      cliEntry: alias,
      endpoint: httpEndpoint("127.0.0.1", 3768),
      home,
      root,
      scope: "local",
      platform: "linux",
    });
    await mkdir(path.dirname(plan.file), { recursive: true });
    const args = ["--root", root, "--transport", "http", "--service"];
    await writeFile(plan.file, plan.content);
    if (nativePlatform === "win32") {
      expect(plan.content).toContain(
        '"mcp" "--transport" "http" "--host" "127.0.0.1" "--port" "3768"',
      );
      expect((await checkInstall(args, home)).checks.service).toBeFalse();
      expect(() =>
        createServicePlan({
          cliEntry: alias,
          endpoint: httpEndpoint("127.0.0.1", 3768),
          home,
          root,
          scope: "local",
          platform: "win32",
        }),
      ).toThrow("not supported on Windows");
      return;
    }
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "linux",
    });
    expect((await checkInstall(args, home)).checks.service).toBeTrue();
    for (const invalid of [
      plan.content.replace('"mcp"', '"mcp"--eval'),
      plan.content.replace('"mcp"', '"\\q"'),
      plan.content.replace(/^WorkingDirectory=.*$/m, ""),
      plan.content.replace(/^ExecStart=.*$/m, "ExecStart="),
    ]) {
      expect(invalid).not.toBe(plan.content);
      await writeFile(plan.file, invalid);
      expect((await checkInstall(args, home)).checks.service).toBeFalse();
    }
    await rm(plan.file);
    expect((await checkInstall(args, home)).checks.service).toBeFalse();
  } finally {
    Object.defineProperty(process, "platform", descriptor);
    await rm(home, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("checker preserves protocol errors when Windows cleanup cannot close input", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  const encoder = new TextEncoder();
  const child = {
    exitCode: null,
    pid: 99,
    exited: Promise.resolve(0),
    stdin: {
      write() {},
      flush: async () => {},
      end() {
        throw new Error("input cleanup failed");
      },
    },
    stdout: new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode("invalid\n"));
        controller.close();
      },
    }),
    stderr: new ReadableStream({
      start(controller) {
        controller.close();
      },
    }),
    kill() {},
  };
  let calls = 0;
  const helper = { exitCode: null, exited: Promise.resolve(0), kill() {} };
  const spawn = spyOn(Bun, "spawn").mockImplementation(() => {
    calls += 1;
    if (calls === 1) return child as never;
    return helper as never;
  });
  try {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "win32",
    });
    await expect(
      smokeMcpStdio("fixture.exe", os.tmpdir(), 1000),
    ).rejects.toThrow("JSON");
    expect(calls).toBe(2);
  } finally {
    spawn.mockRestore();
    Object.defineProperty(process, "platform", descriptor);
  }
});

test("checker bounds stalled Windows termination helpers and preserves cleanup failures", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "win32",
    });
    for (const cleanupThrows of [false, true]) {
      const encoder = new TextEncoder();
      let killed = 0;
      const child = {
        exitCode: null,
        pid: 99,
        exited: new Promise<number>(() => {}),
        stdin: {
          write() {},
          flush: async () => {},
          end() {
            throw new Error("input cleanup failed");
          },
        },
        stdout: new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode("invalid\n"));
            controller.close();
          },
        }),
        stderr: new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
        kill() {
          killed += 1;
          if (cleanupThrows) throw new Error("termination failed");
        },
      };
      let calls = 0;
      const helper = {
        exitCode: null,
        exited: new Promise<number>(() => {}),
        kill() {
          throw new Error("taskkill failed");
        },
      };
      const spawn = spyOn(Bun, "spawn").mockImplementation(() => {
        calls += 1;
        return (calls === 1 ? child : helper) as never;
      });
      try {
        await expect(
          smokeMcpStdio("fixture.exe", os.tmpdir(), 1000),
        ).rejects.toThrow("JSON");
        expect(killed).toBeGreaterThan(0);
      } finally {
        spawn.mockRestore();
      }
    }
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
});
