import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { spawnHttpMcpProcess, spawnLiveProcess } from "../support/live-process";
import {
  exerciseSkillsHttp,
  exerciseSkillsStdio,
  exerciseModernWorkspaceHttp,
  skillsMeta,
} from "../support/skills-protocol";

test("modern stdio preserves fragmented batches and recovers malformed and oversized frames", async () => {
  const live = spawnLiveProcess(process.execPath, [
    path.resolve("bin/ast-mcp.ts"),
    "mcp",
  ]);
  const request = (id: number, method: string) => ({
    jsonrpc: "2.0",
    id,
    method,
    params: { _meta: skillsMeta },
  });
  try {
    const batch =
      JSON.stringify([
        request(101, "server/discover"),
        {
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: 999, reason: "unused" },
        },
        request(102, "skills/list"),
      ]) + "\n";
    live.process.stdin.write(batch.slice(0, 17));
    live.process.stdin.write(batch.slice(17));
    const messages = [
      JSON.parse(await live.readStdoutLine()),
      JSON.parse(await live.readStdoutLine()),
    ];
    expect(messages.map((message) => message.id).sort()).toEqual([101, 102]);
    live.process.stdin.write("{bad}\n");
    expect(JSON.parse(await live.readStdoutLine()).error.code).toBe(-32700);
    live.process.stdin.write("x".repeat(10 * 1024 * 1024 + 1) + "\n");
    expect(JSON.parse(await live.readStdoutLine()).error.code).toBe(-32700);
    live.process.stdin.write(
      JSON.stringify(request(103, "skills/list")) + "\n",
    );
    expect(JSON.parse(await live.readStdoutLine()).id).toBe(103);
    live.process.stdin.end();
    expect(await live.waitForExit()).toBe(0);
  } finally {
    await live.stop();
  }
}, 30000);

test("real stdio serves modern Skills beside legacy clients", async () => {
  await exerciseSkillsStdio(path.resolve("bin/ast-mcp.ts"), process.cwd());
}, 30000);

test("real HTTP serves modern Skills and retains explicit workspace handles", async () => {
  const owned = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-modern-"));
  const fixture = path.join(owned, "fixture");
  await mkdir(fixture);
  await writeFile(
    path.join(fixture, "entry.ts"),
    "export function publish(value: string) { return value; }\n",
  );
  await writeFile(path.join(fixture, "modern.txt"), "original\n");
  for (const args of [
    ["init", "-q"],
    ["add", "."],
    [
      "-c",
      "user.name=Skills Test",
      "-c",
      "user.email=skills@example.invalid",
      "commit",
      "-qm",
      "fixture",
    ],
  ]) {
    const child = Bun.spawn(["git", ...args], {
      cwd: fixture,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await child.exited, await new Response(child.stderr).text()).toBe(0);
  }
  const live = await spawnHttpMcpProcess(
    process.execPath,
    [path.resolve("bin/ast-mcp.ts"), "mcp"],
    { cwd: fixture },
  );
  try {
    await exerciseSkillsHttp(live.url);
    await exerciseModernWorkspaceHttp(
      live.url,
      fixture,
      path.join(owned, "storage"),
    );
  } finally {
    await live.stop();
    await rm(owned, { recursive: true, force: true });
  }
}, 30000);
