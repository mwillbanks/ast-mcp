import { afterEach, expect, test } from "bun:test";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { callAstBro } from "../src/ast-bro/client";
import { type AstBroResult, parseAstBroShowV2 } from "../src/ast-bro/result";
import { patchFile } from "../src/patch/engine";
import { sha256 } from "../src/runtime/hash";

let folder = "";
afterEach(async () => {
  delete process.env.AST_MCP_ROOTS;
  delete process.env.AST_MCP_ALLOW_EXTERNAL_ROOTS;
  if (folder) await rm(folder, { force: true, recursive: true });
  folder = "";
});

async function astMcpClient(root: string) {
  const client = new Client(
    { name: "ast-bro-routing-test", version: "1.0.0" },
    { capabilities: { roots: {} } },
  );
  client.setRequestHandler("roots/list", async () => ({
    roots: [{ name: "routing-test", uri: pathToFileURL(root).href }],
  }));
  const transport = new StdioClientTransport({
    args: [path.resolve(import.meta.dir, "../src/index.ts")],
    command: "bun",
    cwd: path.resolve(import.meta.dir, ".."),
    env: {
      ...(process.env.AST_BRO_BINARY
        ? { AST_BRO_BINARY: process.env.AST_BRO_BINARY }
        : {}),
      AST_MCP_ALLOW_EXTERNAL_ROOTS: "1",
      AST_MCP_ROOTS: root,
      HOME: process.env.HOME ?? "",
      PATH: process.env.PATH ?? "",
    },
    stderr: "pipe",
  });
  await client.connect(transport);
  return client;
}

test("ast-bro map parse errors route source through the Aider fallback", async () => {
  folder = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-map-routing-"));
  process.env.AST_MCP_ROOTS = folder;
  process.env.AST_MCP_ALLOW_EXTERNAL_ROOTS = "1";
  const filePath = path.join(folder, "broken.ts");
  await writeFile(filePath, "const broken = ;\n");
  const result = await patchFile({
    aiderBlock: {
      replace: "const fixed = 1;",
      search: "const broken = ;",
    },
    expectedSha256: sha256(await readFile(filePath, "utf8")),
    filePath,
    patchStrategy: "aider_block",
  });
  expect(result.strategy).toBe("aider_block");
  expect(await readFile(filePath, "utf8")).toBe("const fixed = 1;\n");
});

test("registered show v2 enforces globs, coverage, frontmatter, and paths", async () => {
  folder = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-show-v2-"));
  process.env.AST_MCP_ROOTS = folder;
  process.env.AST_MCP_ALLOW_EXTERNAL_ROOTS = "1";
  const first = path.join(folder, "one.ts");
  await writeFile(first, "export function target() { return 1; }\n");
  await writeFile(
    path.join(folder, "two.ts"),
    "export function target() { return 2; }\n",
  );
  const markdown = path.join(folder, "skill.md");
  await writeFile(markdown, "---\nname: example\n---\n\n# Example\n");
  const client = await astMcpClient(folder);
  try {
    const result = await client.callTool({
      arguments: {
        json: true,
        limit: 1,
        path: path.join(folder, "*.ts"),
        symbols: ["target"],
      },
      name: "show",
    });
    const payload = parseAstBroShowV2(result as AstBroResult);
    expect(payload.files_scanned).toBe(2);
    expect(payload.total).toBe(2);
    expect(payload.shown).toBe(1);
    expect(payload.truncated).toBeTrue();
    expect(payload.files).toHaveLength(1);

    const plaintext = await client.callTool({
      arguments: { path: first, symbols: ["target"] },
      name: "show",
    });
    expect(plaintext.isError).not.toBeTrue();
    expect((plaintext.content[0] as { text?: string }).text).toContain(
      "target",
    );

    const frontmatter = parseAstBroShowV2(
      (await client.callTool({
        arguments: {
          json: true,
          path: markdown,
          symbols: ["frontmatter"],
        },
        name: "show",
      })) as AstBroResult,
    );
    expect(frontmatter.files[0]?.matches[0]?.kind).toBe("frontmatter");

    const empty = parseAstBroShowV2(
      (await client.callTool({
        arguments: {
          json: true,
          path: path.join(folder, "missing-*.ts"),
          symbols: ["target"],
        },
        name: "show",
      })) as AstBroResult,
    );
    expect(empty).toMatchObject({
      files: [],
      files_scanned: 0,
      shown: 0,
      total: 0,
      truncated: false,
    });

    const escaping = await client.callTool({
      arguments: {
        json: true,
        path: path.join(folder, "../*.ts"),
        symbols: ["target"],
      },
      name: "show",
    });
    expect(escaping.isError).toBeTrue();

    await symlink(first, path.join(folder, "linked.ts"));
    const linked = await client.callTool({
      arguments: {
        json: true,
        path: path.join(folder, "linked.ts"),
        symbols: ["target"],
      },
      name: "show",
    });
    expect(linked.isError).toBeTrue();
  } finally {
    await client.close();
  }
});

test("semantic indexes stay at the workspace root for nested analysis", async () => {
  folder = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-index-root-"));
  const nested = path.join(folder, "change", "specs");
  const source = path.join(nested, "identity.ts");
  await mkdir(nested, { recursive: true });
  await writeFile(source, "export const identity = 'stable';\n");

  await callAstBro(
    "search",
    {
      alpha: 0.5,
      json: true,
      languages: ["typescript"],
      path: nested,
      query: "stable identity",
      top_k: 3,
    },
    folder,
  );
  await access(path.join(folder, ".ast-bro", "index", "meta.json"));
  await expect(access(path.join(nested, ".ast-bro"))).rejects.toThrow();

  await callAstBro(
    "find_related",
    { json: true, line: 1, path: source, root: nested, top_k: 3 },
    folder,
  );
  await expect(access(path.join(nested, ".ast-bro"))).rejects.toThrow();
});
