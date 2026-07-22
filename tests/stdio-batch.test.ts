import { expect, test } from "bun:test";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function readJsonLine(
  reader: {
    read(): Promise<{ done: boolean; value?: Uint8Array<ArrayBufferLike> }>;
  },
  buffered: { value: string },
) {
  while (!buffered.value.includes("\n")) {
    const next = await reader.read();
    if (next.done) throw new Error("stdio server closed before a response");
    buffered.value += decoder.decode(next.value, { stream: true });
  }

  const newline = buffered.value.indexOf("\n");
  const line = buffered.value.slice(0, newline);
  buffered.value = buffered.value.slice(newline + 1);
  return JSON.parse(line) as { id?: number; result?: unknown };
}

test("stdio batch suppresses notification responses and preserves request IDs", async () => {
  const child = Bun.spawn(["bun", "run", "src/index.ts"], {
    cwd: process.cwd(),
    stderr: "pipe",
    stdin: "pipe",
    stdout: "pipe",
  });
  const reader = child.stdout.getReader();
  const buffered = { value: "" };

  try {
    child.stdin.write(
      encoder.encode(
        `${JSON.stringify({
          id: 1,
          jsonrpc: "2.0",
          method: "initialize",
          params: {
            capabilities: {},
            clientInfo: { name: "stdio-batch-test", version: "1.0.0" },
            protocolVersion: "2025-06-18",
          },
        })}\n`,
      ),
    );

    const initialized = await readJsonLine(reader, buffered);
    expect(initialized.id).toBe(1);

    child.stdin.write(
      encoder.encode(
        `${JSON.stringify([
          {
            jsonrpc: "2.0",
            method: "notifications/initialized",
            params: {},
          },
          {},
          { id: 2, jsonrpc: "2.0", method: "ping" },
        ])}\n`,
      ),
    );

    const responses = [
      await readJsonLine(reader, buffered),
      await readJsonLine(reader, buffered),
    ];
    expect(
      responses.map((response) => (response as { id?: unknown }).id).sort(),
    ).toEqual([2, null]);
    expect(
      responses.some(
        (response) =>
          (response as { error?: { code?: number }; id?: unknown }).id ===
            null &&
          (response as { error?: { code?: number } }).error?.code === -32600,
      ),
    ).toBeTrue();
    expect(
      responses.find((response) => response.id === 2)?.result,
    ).toBeTruthy();
  } finally {
    child.kill();
    await child.exited;
  }
});
