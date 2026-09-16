import { expect, test } from "bun:test";
import { spawnLiveProcess } from "./support/live-process";

const encoder = new TextEncoder();
test("stdio batch suppresses notification responses and preserves request IDs", async () => {
  const child = spawnLiveProcess(process.execPath, ["run", "src/index.ts"], {
    cwd: process.cwd(),
  });

  try {
    child.process.stdin.write(
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

    const initialized = JSON.parse(await child.readStdoutLine()) as {
      id?: number;
      result?: unknown;
    };
    expect(initialized.id).toBe(1);

    child.process.stdin.write(
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
      JSON.parse(await child.readStdoutLine()),
      JSON.parse(await child.readStdoutLine()),
    ] as Array<{ id?: number; result?: unknown }>;
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
    await child.stop();
  }
});
