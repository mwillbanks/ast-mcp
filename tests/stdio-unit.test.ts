import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";

import { BatchingStdioServerTransport } from "../src/stdio";

test("stdio transport batches split JSON-RPC input and sends framed output", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const transport = new BatchingStdioServerTransport(stdin, stdout);
  const messages: unknown[] = [];
  let closed = false;
  transport.onmessage = (message) => messages.push(message);
  transport.onclose = () => {
    closed = true;
  };

  await transport.start();
  const payload = `${JSON.stringify([
    { id: 1, jsonrpc: "2.0", method: "ping" },
    { id: 2, jsonrpc: "2.0", method: "ping" },
  ])}\n`;
  stdin.write(payload.slice(0, 12));
  stdin.write(payload.slice(12));
  await Promise.resolve();
  expect(messages).toHaveLength(2);

  await transport.send({
    id: 3,
    jsonrpc: "2.0",
    result: {},
  } as never);
  expect(stdout.read()?.toString()).toContain('"id":3');

  await transport.close();
  expect(closed).toBeTrue();
  await expect(transport.send({} as never)).rejects.toThrow("closed");
});

test("large aggregate chunks preserve small frames and fragmented UTF-8", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const transport = new BatchingStdioServerTransport(stdin, stdout);
  const messages: unknown[] = [];
  const errors: Error[] = [];
  transport.onmessage = (message) => messages.push(message);
  transport.onerror = (error) => errors.push(error);
  await transport.start();
  const frame = Buffer.from(
    `${JSON.stringify({ id: "é", jsonrpc: "2.0", method: "ping", params: { padding: "x".repeat(1024) } })}\n`,
  );
  stdin.write(Buffer.concat(Array.from({ length: 11_000 }, () => frame)));
  const unicode = Buffer.from('{"id":"é","jsonrpc":"2.0","method":"ping"}\n');
  const split = unicode.indexOf(Buffer.from("é")) + 1;
  stdin.write(unicode.subarray(0, split));
  stdin.write(unicode.subarray(split));
  expect(messages).toHaveLength(11_001);
  expect(messages.at(-1)).toMatchObject({ id: "é" });
  expect(errors).toHaveLength(0);
  await transport.close();
});

test("oversized and malformed frames resynchronize without disconnecting", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let output = "";
  stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  const transport = new BatchingStdioServerTransport(stdin, stdout);
  const messages: unknown[] = [];
  const errors: Error[] = [];
  transport.onmessage = (message) => messages.push(message);
  transport.onerror = (error) => errors.push(error);
  await transport.start();
  stdin.write(Buffer.alloc(10 * 1024 * 1024 + 1, 120));
  stdin.write(
    'discarded\nnot-json\n[]\n42\n{"id":9,"jsonrpc":"2.0","method":"ping"}\n',
  );
  expect(messages).toEqual([{ id: 9, jsonrpc: "2.0", method: "ping" }]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const responses = output
    .trim()
    .split("\n")
    .map((line: string) => JSON.parse(line));
  expect(
    responses.map(
      (response: { error: { code: number } }) => response.error.code,
    ),
  ).toEqual([-32700, -32700, -32600, -32600]);
  expect(errors).toHaveLength(4);
  await transport.send({ id: 9, jsonrpc: "2.0", result: {} } as never);
  await transport.close();
});

test("EOF closes once and rejects writes waiting for drain", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough({ highWaterMark: 1 });
  const transport = new BatchingStdioServerTransport(stdin, stdout);
  let closes = 0;
  transport.onclose = () => {
    closes += 1;
  };
  await transport.start();
  const pending = transport.send({
    id: 1,
    jsonrpc: "2.0",
    result: {},
  } as never);
  const failure = pending.catch((error: Error) => error);
  stdin.end();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect((await failure) as Error).toMatchObject({
    message: "Stdio transport is closed",
  });
  expect(closes).toBe(1);
  await transport.close();
  expect(closes).toBe(1);
  await expect(transport.start()).rejects.toThrow();
});

test("handler failures preserve request IDs and suppress notification responses", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const transport = new BatchingStdioServerTransport(stdin, stdout);
  transport.onmessage = () => {
    throw new Error("handler failed");
  };
  await transport.start();
  stdin.write(
    '[{"id":"request","jsonrpc":"2.0","method":"ping"},{"jsonrpc":"2.0","method":"notifications/initialized"}]\n',
  );
  const responses = stdout
    .read()
    .toString()
    .trim()
    .split("\n")
    .map((line: string) => JSON.parse(line));
  expect(responses).toEqual([
    {
      jsonrpc: "2.0",
      id: "request",
      error: { code: -32603, message: "Internal error" },
    },
  ]);
  await transport.close();
});

test("broken output closes transport and rejects pending writes", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough({ highWaterMark: 1 });
  const transport = new BatchingStdioServerTransport(stdin, stdout);
  const errors: Error[] = [];
  let closes = 0;
  transport.onerror = (error) => errors.push(error);
  transport.onclose = () => {
    closes += 1;
  };
  await transport.start();
  const pending = transport
    .send({ id: 1, jsonrpc: "2.0", result: {} } as never)
    .catch((error: Error) => error);
  stdout.emit("error", new Error("broken pipe"));
  expect(await pending).toBeInstanceOf(Error);
  expect(errors[0]?.message).toBe("broken pipe");
  expect(closes).toBe(1);
  await expect(transport.send({} as never)).rejects.toThrow("closed");
});
