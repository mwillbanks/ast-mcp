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
