import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

test("stdio resolves project TOML from client-advertised roots", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-client-root-"));
  await mkdir(path.join(root, ".git"));
  await writeFile(
    path.join(root, "ast-mcp.toml"),
    '[workspace]\nroots = ["."]\n',
  );
  const readable = path.join(root, "project-note.txt");
  await writeFile(readable, "project configuration\n");

  const client = new Client(
    { name: "config-roots-test", version: "1.0.0" },
    { capabilities: { roots: {} } },
  );
  client.setRequestHandler("roots/list", async () => ({
    roots: [{ name: "configured project", uri: pathToFileURL(root).href }],
  }));
  const transport = new StdioClientTransport({
    args: [path.resolve(import.meta.dir, "../../src/index.ts")],
    command: "bun",
    cwd: path.resolve(import.meta.dir, "../.."),
    stderr: "pipe",
  });

  try {
    await client.connect(transport);
    const result = await client.callTool({
      arguments: { files: [{ filePath: readable }] },
      name: "file_read",
    });
    if (result.isError) throw new Error(JSON.stringify(result));
    expect(result.content[0]).toMatchObject({
      type: "text",
    });
    expect((result.content[0] as { text: string }).text).toContain(
      "project configuration",
    );
  } finally {
    await client.close();
    await rm(root, { force: true, recursive: true });
  }
});

test("stdio config_core clears optional dprint configuration through its public schema", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-clear-dprint-"));
  const file = path.join(root, "ast-mcp.toml");
  await mkdir(path.join(root, ".git"));
  await writeFile(
    file,
    `version = 2
[formatting]
enabled = false
dprint_config = "./retired.json"
# preserve this formatter policy
fallback = "preserve"
[mcp.configuration]
require_approval = false
[telemetry]
enabled = false
`,
  );
  const client = new Client({ name: "clear-dprint-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    args: [path.resolve(import.meta.dir, "../../src/index.ts")],
    command: process.execPath,
    cwd: root,
    env: {
      ...process.env,
      APPDATA: path.join(root, "state"),
      XDG_CONFIG_HOME: path.join(root, "state"),
    },
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    const result = await client.callTool({
      arguments: { formatting: { dprint_config: null } },
      name: "config_core",
    });
    expect(result.isError).not.toBeTrue();
    expect(result.structuredContent).toMatchObject({ ok: true });
    const source = await Bun.file(file).text();
    expect(source).not.toContain("dprint_config");
    expect(source).toContain("# preserve this formatter policy");
    expect(source).toContain('fallback = "preserve"');
    const invalid = await client.callTool({
      arguments: { cli: { output: { interactive: "xml" } } },
      name: "config_core",
    });
    expect(invalid.isError).toBeTrue();
    expect(await Bun.file(file).text()).toBe(source);
    const output = await client.callTool({
      arguments: {
        cli: { output: { interactive: "yaml", non_interactive: "toml" } },
      },
      name: "config_core",
    });
    expect(output.isError).not.toBeTrue();
    expect(output.structuredContent).toMatchObject({
      ok: true,
      data: { changed: ["cli.output"] },
    });
    expect(Bun.TOML.parse(await Bun.file(file).text())).toMatchObject({
      cli: { output: { interactive: "yaml", non_interactive: "toml" } },
    });
    const status = await client.callTool({
      arguments: {},
      name: "config_status",
    });
    expect(status.structuredContent).toMatchObject({
      data: {
        healthy: true,
        cli: { output: { interactive: "yaml", nonInteractive: "toml" } },
      },
      ok: true,
    });
  } finally {
    await client.close();
    await rm(root, { force: true, recursive: true });
  }
});
