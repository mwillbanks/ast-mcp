import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { clearConfigCache } from "../src/config";
import { runConfigCli } from "../src/config-cli";

let root = "";

afterEach(async () => {
  clearConfigCache();
  if (root) await rm(root, { force: true, recursive: true });
  root = "";
});

test("validates and shows resolved configuration as stable JSON", async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-config-cli-"));
  await mkdir(path.join(root, ".git"));
  await writeFile(path.join(root, "ast-mcp.toml"), "[http]\nport = 4567\n");

  const validate: string[] = [];
  await runConfigCli(["validate", "--root", root], (text) =>
    validate.push(text),
  );
  expect(JSON.parse(validate.join(""))).toMatchObject({
    projectRoot: root,
    valid: true,
  });

  const show: string[] = [];
  await runConfigCli([`show`, `--root=${root}`], (text) => show.push(text));
  expect(JSON.parse(show.join(""))).toMatchObject({
    http: { port: 4567 },
    projectRoot: root,
    version: 1,
  });

  const written: string[] = [];
  const stdout = spyOn(process.stdout, "write").mockImplementation((chunk) => {
    written.push(String(chunk));
    return true;
  });
  try {
    await runConfigCli(["validate", "--root", root]);
  } finally {
    stdout.mockRestore();
  }
  expect(JSON.parse(written.join(""))).toMatchObject({ valid: true });
});

test("reports configuration command usage errors", async () => {
  await expect(runConfigCli([])).rejects.toThrow(
    "Expected config validate, config show, or config migrate",
  );
  await expect(runConfigCli(["show", "--root"])).rejects.toThrow(
    "Missing value for --root",
  );
  await expect(runConfigCli(["show", "--unknown"])).rejects.toThrow(
    "Unknown option: --unknown",
  );
});
