import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";

import { evaluateHook } from "../src/hook";
import { BatchingStdioServerTransport } from "../src/stdio";

async function availablePort() {
  const socket = createNetServer();
  await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const address = socket.address();
  if (!address || typeof address === "string")
    throw new Error("Could not allocate a test port");
  await new Promise<void>((resolve, reject) =>
    socket.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

test("hook routes common nested shell and interpreter wrappers", () => {
  for (const command of [
    'bash -c "rm -f x"',
    "sh -c 'rm -f x'",
    "zsh -c 'rm -f x'",
    'env FOO=bar bash -c "rm -f x"',
    'env -- bash -c "rm -f x"',
    'env --ignore-environment zsh -c "rm -f x"',
    '"bash" "-c" "rm -f x"',
    'command sh -c "rm -f x"',
    'env -i node --eval "writeFileSync(\\"x\\", \\"x\\")"',
  ])
    expect(
      evaluateHook({ tool_input: { command }, tool_name: "exec_command" })
        .denied,
    ).toBeTrue();
});

test("stdio reports empty and malformed JSON-RPC input", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const transport = new BatchingStdioServerTransport(stdin, stdout);
  const errors: Error[] = [];
  transport.onerror = (error) => errors.push(error);
  await transport.start();

  const response = new Promise<Buffer>((resolve) =>
    stdout.once("data", resolve),
  );
  stdin.write("[]\n");
  expect((await response).toString()).toContain('"code":-32600');

  stdin.write("not-json\n");
  await Promise.resolve();
  expect(errors.some((error) => error.message.includes("JSON"))).toBeTrue();

  await transport.close();
});

test("stdio closes oversized input and handles drain and write errors", async () => {
  const stdin = new PassThrough();
  const stdout = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const transport = new BatchingStdioServerTransport(stdin, stdout);
  const errors: Error[] = [];
  transport.onerror = (error) => errors.push(error);
  await transport.start();

  stdin.write(Buffer.alloc(10 * 1024 * 1024 + 1));
  await Promise.resolve();
  expect(errors.some((error) => error.message.includes("exceeded"))).toBeTrue();
  await expect(transport.send({} as never)).rejects.toThrow("closed");

  const backpressure = new BatchingStdioServerTransport(
    new PassThrough(),
    stdout,
  );
  const write = spyOn(stdout, "write").mockImplementation(() => false);
  try {
    const pending = backpressure.send({} as never);
    stdout.emit("drain");
    await pending;

    const rejected = backpressure.send({} as never);
    stdout.emit("error", new Error("write failed"));
    await expect(rejected).rejects.toThrow("write failed");
  } finally {
    write.mockRestore();
  }
});

test("HTTP expires idle sessions deterministically", async () => {
  const port = await availablePort();
  const processHandle = Bun.spawn(
    [process.execPath, path.resolve(import.meta.dir, "../src/http-entry.ts")],
    {
      env: {
        ...process.env,
        AST_MCP_SESSION_SWEEP_INTERVAL_MS: "1",
        AST_MCP_SESSION_TIMEOUT_MS: "1",
        PORT: String(port),
      },
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
            clientInfo: { name: "idle-test", version: "1.0.0" },
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

    await Bun.sleep(30);
    const expired = await fetch(url, {
      body: JSON.stringify({
        id: 2,
        jsonrpc: "2.0",
        method: "ping",
        params: {},
      }),
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-session-id": sessionId as string,
      },
      method: "POST",
    });
    expect(expired.status).toBe(404);
  } finally {
    if (processHandle.exitCode === null) processHandle.kill("SIGTERM");
    await processHandle.exited;
  }
});

test("transcript scoring rejects failed, duplicate, and mismatched evidence", async () => {
  const directory = await mkdtemp(
    path.join(process.env.TMPDIR ?? "/tmp", "ast-mcp-score-"),
  );
  const sessionPath = path.join(directory, "session.jsonl");

  try {
    await writeFile(
      sessionPath,
      [
        JSON.stringify({
          payload: {
            call_id: "call-1",
            input: '// ast-mcp-eval:71\n{"filePaths":["src/server.ts"]}',
            name: "mcp__ast_mcp__file_hash",
            type: "custom_tool_call",
          },
          type: "response_item",
        }),
        JSON.stringify({
          payload: {
            call_id: "call-1",
            output: [{ text: '{"filePath":"src/server.ts"}' }],
            type: "custom_tool_call_output",
          },
          type: "response_item",
        }),
      ].join("\n"),
    );

    const process = Bun.spawn(
      ["bun", "run", "templates/skills/ast-mcp/evals/measure.ts", sessionPath],
      { stderr: "pipe", stdout: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain('"evaluatedCases":1');

    await writeFile(
      sessionPath,
      [
        JSON.stringify({
          payload: {
            call_id: "call-1",
            input:
              '// ast-mcp-eval:71\n{"files":[{"filePath":"src/server.ts","lines":[0,2]}]}',
            name: "mcp__ast_mcp__file_read",
            type: "custom_tool_call",
          },
          type: "response_item",
        }),
        JSON.stringify({
          payload: {
            call_id: "call-1",
            output: [{ text: "ok" }],
            type: "custom_tool_call_output",
          },
          type: "response_item",
        }),
        JSON.stringify({
          payload: {
            call_id: "call-1",
            output: [{ text: "duplicate" }],
            type: "custom_tool_call_output",
          },
          type: "response_item",
        }),
      ].join("\n"),
    );
    const failed = Bun.spawn(
      [
        "bun",
        "run",
        "templates/skills/ast-mcp/evals/measure.ts",
        "--strict",
        sessionPath,
      ],
      { stderr: "pipe", stdout: "pipe" },
    );
    expect(await failed.exited).toBe(1);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("stdio reports input and protocol-response errors", async () => {
  const stdin = new PassThrough();
  const stdout = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const transport = new BatchingStdioServerTransport(stdin, stdout);
  const errors: Error[] = [];
  transport.onerror = (error) => errors.push(error);
  await transport.start();

  stdin.emit("error", new Error("stdin failure"));
  const write = spyOn(stdout, "write").mockImplementation(() => false);
  try {
    stdin.write("[]\n");
    stdout.emit("error", new Error("response failure"));
    await Bun.sleep(0);
    expect(
      errors.some((error) => error.message.includes("stdin failure")),
    ).toBeTrue();
    expect(
      errors.some((error) => error.message.includes("response failure")),
    ).toBeTrue();
  } finally {
    write.mockRestore();
    await transport.close();
  }
});

test("transcript scoring requires named filesystem result evidence", async () => {
  const directory = await mkdtemp(
    path.join(process.env.TMPDIR ?? "/tmp", "ast-mcp-files-"),
  );
  const sessionPath = path.join(directory, "session.jsonl");
  const call = {
    payload: {
      call_id: "call-files",
      input:
        '// ast-mcp-eval:74\n{"notes/one.txt":{"content":"one"},"notes/two.txt":{"content":"two"},"notes/three.txt":{"content":"three"}}',
      name: "mcp__ast_mcp__file_write",
      type: "custom_tool_call",
    },
    type: "response_item",
  };

  try {
    await writeFile(
      sessionPath,
      [
        JSON.stringify(call),
        JSON.stringify({
          payload: {
            call_id: "call-files",
            output: [
              {
                text: '{"files":{"notes/one.txt":{},"notes/two.txt":{},"notes/three.txt":{}}}',
              },
            ],
            type: "custom_tool_call_output",
          },
          type: "response_item",
        }),
      ].join(String.fromCharCode(10)),
    );
    const successful = Bun.spawn(
      ["bun", "run", "templates/skills/ast-mcp/evals/measure.ts", sessionPath],
      { stderr: "pipe", stdout: "pipe" },
    );
    const [successfulOutput, successfulExitCode] = await Promise.all([
      new Response(successful.stdout).text(),
      successful.exited,
    ]);
    expect(successfulOutput).toContain('"passed":true');
    expect(successfulExitCode).toBe(0);

    await writeFile(
      sessionPath,
      [
        JSON.stringify(call),
        JSON.stringify({
          payload: {
            call_id: "call-files",
            output: [{ text: '{"files":{"notes/one.txt":{}}}' }],
            type: "custom_tool_call_output",
          },
          type: "response_item",
        }),
      ].join(String.fromCharCode(10)),
    );
    const failed = Bun.spawn(
      [
        "bun",
        "run",
        "templates/skills/ast-mcp/evals/measure.ts",
        "--strict",
        sessionPath,
      ],
      { stderr: "pipe", stdout: "pipe" },
    );
    const [output, exitCode] = await Promise.all([
      new Response(failed.stdout).text(),
      failed.exited,
    ]);
    expect(exitCode).toBe(1);
    expect(output).toContain(
      "eval 74 output does not prove file result: notes/two.txt",
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("transcript scoring aggregates eval batches and rejects integrity failures", async () => {
  const directory = await mkdtemp(
    path.join(process.env.TMPDIR ?? "/tmp", "ast-mcp-integrity-"),
  );
  const sessionPath = path.join(directory, "session.jsonl");
  const execCall = (callId: string, input: string) => ({
    payload: {
      call_id: callId,
      input,
      name: `mcp__ast_mcp__${input.match(/mcp__ast_mcp__(\w+)/)?.[1] ?? "file_hash"}`,
      type: "custom_tool_call",
    },
    type: "response_item",
  });
  const output = (callId: string, text: string, isError = false) => ({
    payload: {
      call_id: callId,
      isError,
      output: [{ text }],
      type: "custom_tool_call_output",
    },
    type: "response_item",
  });

  try {
    await writeFile(
      sessionPath,
      [
        execCall(
          "hash",
          `// ast-mcp-eval:75\nawait tools.mcp__ast_mcp__file_hash({ filePaths: ["notes/existing.txt"] });`,
        ),
        output("hash", '{"filePath":"notes/existing.txt"}'),
        execCall(
          "write",
          `// ast-mcp-eval:75\nawait tools.mcp__ast_mcp__file_write({ "notes/new.txt": { content: "new" }, "notes/existing.txt": { content: "next", expectedSha256: "abc" } });`,
        ),
        output("write", '{"files":{"notes/new.txt":{}}}'),
      ]
        .map((record) => JSON.stringify(record))
        .join(String.fromCharCode(10)),
    );
    const aggregate = Bun.spawn(
      ["bun", "run", "templates/skills/ast-mcp/evals/measure.ts", sessionPath],
      { stderr: "pipe", stdout: "pipe" },
    );
    const [aggregateOutput, aggregateExitCode] = await Promise.all([
      new Response(aggregate.stdout).text(),
      aggregate.exited,
    ]);
    expect(aggregateExitCode).toBe(0);
    expect(aggregateOutput).toContain('"evaluatedCases":1');

    await writeFile(
      sessionPath,
      [
        execCall(
          "duplicate",
          `// ast-mcp-eval:71
    await tools.mcp__ast_mcp__file_hash({});`,
        ),
        execCall(
          "duplicate",
          `// ast-mcp-eval:71
    await tools.mcp__ast_mcp__file_hash({});`,
        ),
        output("orphan", "orphan"),
        execCall(
          "failed",
          `// ast-mcp-eval:71
    await tools.mcp__ast_mcp__file_hash({});`,
        ),
        output("failed", "failed", true),
        execCall(
          "missing",
          `// ast-mcp-eval:71
    await tools.mcp__ast_mcp__file_hash({});`,
        ),
      ]
        .map((record) => JSON.stringify(record))
        .join(String.fromCharCode(10)),
    );
    const rejected = Bun.spawn(
      [
        "bun",
        "run",
        "templates/skills/ast-mcp/evals/measure.ts",
        "--strict",
        sessionPath,
      ],
      { stderr: "pipe", stdout: "pipe" },
    );
    const [rejectedOutput, rejectedExitCode] = await Promise.all([
      new Response(rejected.stdout).text(),
      rejected.exited,
    ]);
    expect(rejectedExitCode).toBe(1);
    for (const error of [
      "duplicate call ID: duplicate",
      "unmatched output ID: orphan",
      "failed call ID: failed",
      "missing output for call ID: missing",
    ])
      expect(rejectedOutput).toContain(error);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("eval fixtures cover every special surface category", async () => {
  const root = path.resolve(import.meta.dir, "..");
  const [primary, batch] = await Promise.all([
    Bun.file(
      path.join(root, "templates/skills/ast-mcp/evals/evals.json"),
    ).json(),
    Bun.file(
      path.join(root, "templates/skills/ast-mcp/evals/batch.evals.json"),
    ).json(),
  ]);
  const suite = primary as {
    evals: Array<{ category: string; surface: string }>;
    special_surfaces: string[];
  };
  const evals = [...suite.evals, ...(batch as typeof suite.evals)];

  for (const surface of suite.special_surfaces) {
    const categories = new Set(
      evals
        .filter((evaluation) => evaluation.surface === surface)
        .map((evaluation) => evaluation.category),
    );
    expect(categories).toEqual(new Set(["positive", "variant", "negative"]));
  }
});

test("live stdio server returns Invalid Request for an empty batch", async () => {
  const child = Bun.spawn(["bun", "run", "src/index.ts"], {
    cwd: process.cwd(),
    stderr: "pipe",
    stdin: "pipe",
    stdout: "pipe",
  });
  const reader = child.stdout.getReader();

  try {
    child.stdin.write(new TextEncoder().encode("[]\n"));
    const result = await Promise.race([
      reader.read(),
      Bun.sleep(2_000).then(() => {
        throw new Error("stdio server did not answer the empty batch");
      }),
    ]);
    if (result.done || !result.value)
      throw new Error("stdio server closed before responding");
    const response = JSON.parse(new TextDecoder().decode(result.value)) as {
      error?: { code?: number };
      id?: unknown;
    };
    expect(response.id).toBeNull();
    expect(response.error?.code).toBe(-32600);
  } finally {
    child.kill();
    await child.exited;
  }
});

test("live hook denies env wrapper commands", async () => {
  const child = Bun.spawn(["bun", "run", "src/hook.ts"], {
    cwd: process.cwd(),
    stderr: "pipe",
    stdin: "pipe",
    stdout: "pipe",
  });

  try {
    child.stdin.write(
      new TextEncoder().encode(
        JSON.stringify({
          tool_input: { command: 'env -- bash -c "rm -f x"' },
          tool_name: "exec_command",
        }),
      ),
    );
    child.stdin.end();
    const [output, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      child.exited,
    ]);
    expect(exitCode).toBe(0);
    expect(JSON.parse(output).permissionDecision).toBe("deny");
  } finally {
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
});
