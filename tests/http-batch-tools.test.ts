import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function availablePort() {
  const probe = Bun.serve({
    fetch: () => new Response("probe"),
    port: 0,
  });
  const port = probe.port;
  probe.stop(true);
  return port;
}

test("live HTTP batch carries file tools and suppresses notifications", async () => {
  const root = path.resolve(import.meta.dir, "..");
  const folder = await mkdtemp(path.join(root, ".tmp-http-batch-"));
  const readable = path.join(folder, "readable.txt");
  const notes = path.join(folder, "notes.md");
  const created = path.join(folder, "created.txt");
  const readableContent = "read me\n";
  const notesContent = "alpha\nbeta\n";
  await Promise.all([
    writeFile(readable, readableContent),
    writeFile(notes, notesContent),
  ]);

  const port = availablePort();
  const processHandle = Bun.spawn(
    [process.execPath, path.resolve(root, "src/http-entry.ts")],
    {
      cwd: root,
      env: { ...process.env, PORT: String(port) },
      stderr: "pipe",
      stdout: "pipe",
    },
  );

  try {
    const url = `http://127.0.0.1:${port}/mcp`;
    let initialized: Response | undefined;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      initialized = await fetch(url, {
        body: JSON.stringify({
          id: 1,
          jsonrpc: "2.0",
          method: "initialize",
          params: {
            capabilities: {},
            clientInfo: { name: "http-batch-tools-test", version: "1.0.0" },
            protocolVersion: "2025-06-18",
          },
        }),
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        method: "POST",
      }).catch(() => undefined);
      if (initialized) break;
      await Bun.sleep(25);
    }

    expect(initialized?.status).toBe(200);
    const sessionId = initialized?.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    const response = await fetch(url, {
      body: JSON.stringify([
        {
          jsonrpc: "2.0",
          method: "notifications/initialized",
          params: {},
        },
        {
          id: 2,
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            arguments: { [created]: { content: "created\n" } },
            name: "file_write",
          },
        },
        {
          id: 3,
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            arguments: {
              files: [{ filePath: readable, lines: [0, 2] }],
            },
            name: "file_read",
          },
        },
        {
          id: 4,
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            arguments: { filePaths: [readable] },
            name: "file_hash",
          },
        },
        {
          id: 5,
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            arguments: {
              [notes]: {
                aiderBlocks: [
                  { replace: "one", search: "alpha" },
                  { replace: "two", search: "beta" },
                ],
                expectedSha256: sha256(notesContent),
                patchStrategy: "aider_block",
              },
            },
            name: "file_patch",
          },
        },
      ]),
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-session-id": sessionId as string,
      },
      method: "POST",
    });

    expect(response.status).toBe(200);
    const messages = (await response.text())
      .split("\n")
      .filter((line) => line.startsWith("data: ") && line.length > 6)
      .map((line) => JSON.parse(line.slice(6))) as Array<{
      id: number;
      result?: { isError?: boolean };
    }>;
    expect(messages.map((message) => message.id).sort()).toEqual([2, 3, 4, 5]);
    expect(
      messages.every((message) => message.result?.isError !== true),
    ).toBeTrue();
    expect(await readFile(created, "utf8")).toBe("created\n");
    expect(await readFile(notes, "utf8")).toBe("one\ntwo\n");
  } finally {
    if (processHandle.exitCode === null) processHandle.kill("SIGTERM");
    await processHandle.exited;
    await rm(folder, { force: true, recursive: true });
  }
});
