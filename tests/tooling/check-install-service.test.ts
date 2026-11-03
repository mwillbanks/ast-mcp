import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { install } from "../../src/installer";
import {
  checkInstall,
  smokeMcpStdio,
} from "../../templates/skills/ast-mcp/scripts/check-install";
import { absentServiceStateQuery } from "../support/service-state";

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
  const localAlias = path.join(root, "node_modules/.bin/ast-mcp");
  await mkdir(path.dirname(localAlias), { recursive: true });
  await writeFile(
    localAlias,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.resolve(import.meta.dir, "../../bin/ast-mcp.ts"))} "$@"\n`,
  );
  await chmod(localAlias, 0o755);
  await install({
    home,
    host: "127.0.0.1",
    platform: process.platform,
    port: 4931,
    root,
    scope: "local",
    service: true,
    serviceRunner: async () => {},
    serviceStateQuery: absentServiceStateQuery,
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

  const digest = new Bun.CryptoHasher("sha256")
    .update(path.resolve(root))
    .digest("hex")
    .slice(0, 12);
  const serviceFile =
    process.platform === "darwin"
      ? path.join(
          home,
          "Library/LaunchAgents",
          `com.mwillbanks.ast-mcp-${digest}.plist`,
        )
      : path.join(home, ".config/systemd/user", `ast-mcp-${digest}.service`);
  const service = await readFile(serviceFile, "utf8");
  await writeFile(
    serviceFile,
    service.replace(
      localAlias,
      "/tmp/node_modules/@mwillbanks/ast-mcp/dist/ast-mcp.js",
    ),
  );
  const stale = await checkInstall(
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
  expect(stale.installed).toBeFalse();
  expect(stale.checks.service).toBeFalse();

  await rm(localAlias);
  await install({
    home,
    host: "127.0.0.1",
    platform: process.platform,
    port: 4931,
    root,
    scope: "local",
    service: true,
    serviceRunner: async () => {},
    serviceStateQuery: absentServiceStateQuery,
    targets: ["codex"],
    transport: "http",
  });
  const sourceArgs = [
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
  ];
  const sourceResult = await checkInstall(sourceArgs, home);
  expect(sourceResult.installed).toBeTrue();
  expect(sourceResult.checks.service).toBeTrue();
  const sourceService = await readFile(serviceFile, "utf8");
  const sourceScript = path.resolve(import.meta.dir, "../../bin/ast-mcp.ts");
  expect(sourceService).toContain(sourceScript);
  const injectedArguments =
    process.platform === "darwin"
      ? sourceService.replace(
          "<string>mcp</string>",
          "<string>mcp</string><string>--eval</string>",
        )
      : sourceService.replace('"mcp"', '"mcp" "--eval"');
  const wrongDirectory =
    process.platform === "darwin"
      ? sourceService.replace(
          /(<key>WorkingDirectory<\/key>\s*<string>)[^<]*(<\/string>)/,
          `$1${home}$2`,
        )
      : sourceService.replace(
          `WorkingDirectory="${root}"`,
          `WorkingDirectory="${home}"`,
        );
  for (const invalid of [
    sourceService.replace(sourceScript, process.execPath),
    sourceService.replace(process.execPath, sourceScript),
    injectedArguments,
    wrongDirectory,
  ]) {
    expect(invalid).not.toBe(sourceService);
    await writeFile(serviceFile, invalid);
    expect((await checkInstall(sourceArgs, home)).checks.service).toBeFalse();
  }
});
