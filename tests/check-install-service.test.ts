import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { install } from "../src/installer";
import { checkInstall } from "../templates/skills/ast-mcp/scripts/check-install";

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

test("diagnoses the platform-native managed HTTP service", async () => {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  const root = await temporary("ast-mcp-check-service-root-");
  const home = await temporary("ast-mcp-check-service-home-");
  await install({
    home,
    host: "127.0.0.1",
    platform: process.platform,
    port: 4931,
    root,
    scope: "local",
    service: true,
    serviceRunner: async () => {},
    targets: ["codex"],
    transport: "http",
  });
  const result = await checkInstall(
    [
      "--scope",
      "local",
      "--target",
      "codex",
      "--root",
      root,
      "--transport",
      "http",
      "--host",
      "127.0.0.1",
      "--port",
      "4931",
      "--service",
    ],
    home,
  );
  expect(result.installed).toBeTrue();
  expect(result.checks.service).toBeTrue();
  expect(result.updateCommand).toContain("--service");
});
