import { expect, test } from "bun:test";

import { queryServiceCommand } from "../../src/installer/service-state";

const reply = (stdout: string, exitCode = 0, stderr = "") => ({
  stdout,
  exitCode,
  stderr,
});

test("read-only state subprocesses capture outcomes and terminate within the deadline", async () => {
  expect(
    await queryServiceCommand([
      process.execPath,
      "-e",
      'process.stdout.write("state");process.stderr.write("diagnostic");process.exit(3)',
    ]),
  ).toEqual(reply("state", 3, "diagnostic"));
  await expect(
    queryServiceCommand(
      [process.execPath, "-e", "setInterval(()=>{},1000)"],
      50,
    ),
  ).rejects.toThrow("timed out");
});

test("state subprocess spawn and excessive output failures cannot imply service absence", async () => {
  await expect(
    queryServiceCommand(["/ast-mcp-nonexistent-query-executable"]),
  ).rejects.toThrow();
  await expect(
    queryServiceCommand([
      process.execPath,
      "-e",
      'process.stdout.write("x".repeat(17*1024*1024));setInterval(()=>{},1000)',
    ]),
  ).rejects.toThrow("output exceeded");
});
