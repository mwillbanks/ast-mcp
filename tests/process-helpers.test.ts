import { describe, expect, test } from "bun:test";
import {
  captureProcess,
  successfulProcessOutput,
} from "../src/helpers/process";
import { compactCallSyntax } from "../src/helpers/string";

const stream = (value: string) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(value));
      controller.close();
    },
  });

describe("process and source helpers", () => {
  test("captures stream and non-stream process handles", async () => {
    await expect(
      captureProcess({
        exited: Promise.resolve(0),
        stderr: stream("warn"),
        stdout: stream("ok"),
      }),
    ).resolves.toEqual({ exitCode: 0, stderr: "warn", stdout: "ok" });
    await expect(
      captureProcess({ exited: Promise.resolve(0), stderr: null, stdout: 1 }),
    ).resolves.toEqual({ exitCode: 0, stderr: "", stdout: "" });
  });

  test("reports fallback process failures and removes comments", () => {
    expect(() =>
      successfulProcessOutput("tool", { exitCode: 3, stderr: "", stdout: "" }),
    ).toThrow("tool exited with code 3");
    expect(
      compactCallSyntax("// ignored tools.bad()\ntools . good ( 'value' )"),
    ).toBe("tools.good('value')");
  });
});
