import { afterEach, expect, spyOn, test } from "bun:test";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runInstallerCli } from "../src/installer";

const created: string[] = [];
afterEach(async () => {
  await Promise.all(
    created
      .splice(0)
      .map((folder) => rm(folder, { force: true, recursive: true })),
  );
});

async function temporary(prefix: string) {
  const folder = await mkdtemp(path.join(os.tmpdir(), prefix));
  created.push(folder);
  return folder;
}

test("parses HTTP installer options and reports the effective endpoint", async () => {
  const root = await temporary("ast-mcp-installer-cli-http-");
  const output: string[] = [];
  const stdout = spyOn(process.stdout, "write").mockImplementation((value) => {
    output.push(String(value));
    return true;
  });
  try {
    await runInstallerCli([
      "install",
      "--scope=local",
      "--target=codex",
      `--root=${root}`,
      "--transport=http",
      "--host=127.0.0.1",
      "--port=4912",
    ]);
  } finally {
    stdout.mockRestore();
  }
  const result = JSON.parse(output.join(""));
  expect(result.transport).toBe("http");
  expect(result.endpoint).toBe("http://127.0.0.1:4912/mcp");
  expect(result.service).toEqual({ managed: false });
  expect(result.manualStart).toContain("--transport http");
  expect(
    await readFile(path.join(root, ".codex/config.toml"), "utf8"),
  ).toContain('url = "http://127.0.0.1:4912/mcp"');
});

test("rejects invalid installer transport and service combinations before host writes", async () => {
  const root = await temporary("ast-mcp-installer-cli-invalid-");
  await expect(
    runInstallerCli([
      "install",
      "--root",
      root,
      "--target",
      "codex",
      "--transport",
      "invalid",
    ]),
  ).rejects.toThrow("expected stdio or http");
  await expect(
    runInstallerCli([
      "install",
      "--root",
      root,
      "--target",
      "codex",
      "--transport",
      "http",
      "--service",
    ]),
  ).rejects.toThrow("explicit --port");
  await expect(access(path.join(root, ".codex/config.toml"))).rejects.toThrow();
});
