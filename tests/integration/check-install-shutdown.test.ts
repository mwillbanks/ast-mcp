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
