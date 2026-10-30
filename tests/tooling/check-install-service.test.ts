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

async function smokeFixture(
  root: string,
  options: { delay: number; exit: number; missing?: boolean },
) {
  const fixture = path.join(root, "smoke.ts");
  const toolNames = [
    "graph_diff",
    "graph_explain",
    "graph_path",
    "graph_query",
    "index",
    "index_status",
    "retrieve",
    "workspace_open",
    "workspace_status",
  ];
  await writeFile(
    fixture,
    `import { createInterface } from "node:readline";
import { writeFile } from "node:fs/promises";
const options = ${JSON.stringify(options)};
const tools = options.missing ? [] : ${JSON.stringify(toolNames)};
await writeFile("smoke.pid", String(process.pid));
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.id === undefined) continue;
  const result = message.method === "initialize" ? {} :
    message.method === "tools/list" ? { tools: tools.map(name => ({ name })) } :
    { structuredContent: { ok: true, data: { workspace: {
      workspaceId: "workspace:v1:fixture", checkoutRoot: process.cwd(),
      canonicalRootAnchor: process.cwd()
    } } } };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
}
await Bun.sleep(options.delay);
await writeFile("cleanup.txt", "complete");
if (options.exit) process.stderr.write("fixture shutdown failure\\n");
process.exit(options.exit);
`,
  );
  return fixture;
}

test("checker awaits graceful cleanup after protocol success", async () => {
  const root = await temporary("ast-mcp-smoke-cleanup-");
  const fixture = await smokeFixture(root, { delay: 700, exit: 0 });
  expect(
    (await smokeMcpStdio(process.execPath, root, 5_000, [fixture])).initialized,
  ).toBeTrue();
  expect(await readFile(path.join(root, "cleanup.txt"), "utf8")).toBe(
    "complete",
  );
});

test("checker rejects nonzero shutdown and preserves the protocol failure", async () => {
  const root = await temporary("ast-mcp-smoke-exit-");
  const fixture = await smokeFixture(root, { delay: 0, exit: 7 });
  await expect(
    smokeMcpStdio(process.execPath, root, 5_000, [fixture]),
  ).rejects.toThrow("exited with code 7: fixture shutdown failure");
  await smokeFixture(root, { delay: 0, exit: 7, missing: true });
  await expect(
    smokeMcpStdio(process.execPath, root, 5_000, [fixture]),
  ).rejects.toThrow("missing tools");
});

test("checker terminates cleanup that exceeds five seconds", async () => {
  const root = await temporary("ast-mcp-smoke-stalled-");
  const fixture = await smokeFixture(root, { delay: 60_000, exit: 0 });
  await expect(
    smokeMcpStdio(process.execPath, root, 5_000, [fixture]),
  ).rejects.toMatchObject({
    message: "MCP smoke shutdown exceeded five seconds",
  });
  const pid = Number(await readFile(path.join(root, "smoke.pid"), "utf8"));
  expect(pid).toBeGreaterThan(0);
  expect(() => process.kill(pid, 0)).toThrow();
}, 15_000);
