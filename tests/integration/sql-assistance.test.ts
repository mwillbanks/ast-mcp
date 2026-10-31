import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import type {
  SqlAssistanceOptions,
  SqlPatchDecision,
} from "../../src/runtime/sql-assistance";
import { hermeticConfig } from "../support/hermetic-config";
import { spawnHttpMcpProcess } from "../support/live-process";
import { removeTempDirectory } from "../support/temp-directory";

const executable = path.resolve(import.meta.dir, "../../bin/ast-mcp.ts");
const source = "SELECT 1;\n";
const postgres = {
  policy: "required",
  dialect: "postgresql",
  version: "18",
  variant: "sql",
} as const;
type Mode = "stdio" | "http";
type Response = Awaited<ReturnType<Client["callTool"]>>;
type FileResult = { sql: SqlPatchDecision; previewReceipt: string };

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function entry(
  before: string,
  after: string,
  sql?: SqlAssistanceOptions,
  preview = false,
) {
  return {
    aiderBlocks: [{ search: before, replace: after }],
    expectedSha256: sha256(before),
    patchStrategy: "aider_block",
    preview,
    ...(sql ? { sql } : {}),
  };
}

function fileResult(response: Response, file: string): FileResult {
  expect(response.isError, JSON.stringify(response)).not.toBeTrue();
  const body = response.structuredContent as {
    data: { files: Record<string, FileResult> };
  };
  return body.data.files[file]!;
}

function errorCode(response: Response) {
  expect(response.isError).toBeTrue();
  const body = response.structuredContent as {
    ok: boolean;
    error: { code: string; message: string };
  };
  expect(body.ok).toBeFalse();
  expect(body.error.message.length).toBeGreaterThan(0);
  return body.error.code;
}

async function project(
  mode: Mode,
  work: (context: {
    client: Client;
    connect: (name: string) => Promise<Client>;
    file: string;
    second: string;
    denied: string;
  }) => Promise<void>,
  defaults = "",
) {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "ast-mcp-sql-protocol-")),
  );
  const file = path.join(root, "migration.sql");
  const second = path.join(root, "second.sql");
  const denied = path.join(root, "denied.sql");
  const isolated = hermeticConfig(root);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries({
    ...isolated.env,
    HOME: isolated.home,
    USERPROFILE: isolated.home,
    AST_MCP_PROJECT_ROOT: root,
  })) {
    if (value !== undefined) env[key] = value;
  }
  const clients: Client[] = [];
  let server: Awaited<ReturnType<typeof spawnHttpMcpProcess>> | undefined;
  try {
    await writeFile(
      path.join(root, "ast-mcp.toml"),
      `version = 2
[mcp.configuration]
require_approval = false
[formatting]
enabled = false
${defaults}
[[paths]]
id = "workspace"
path = "."
policies = { read = "allow", write = "allow" }
[[paths]]
id = "denied"
path = "./denied.sql"
policies = { read = "deny", write = "deny" }
`,
    );
    await Promise.all(
      [file, second, denied].map((target) => writeFile(target, source)),
    );
    if (mode === "http")
      server = await spawnHttpMcpProcess(
        process.execPath,
        [executable, "mcp"],
        { cwd: root, env },
      );
    const connect = async (name: string) => {
      const client = new Client(
        { name, version: "1.0.0" },
        { capabilities: {} },
      );
      clients.push(client);
      const transport = server
        ? new StreamableHTTPClientTransport(server.url)
        : new StdioClientTransport({
            command: process.execPath,
            args: [executable, "mcp"],
            cwd: root,
            env,
            stderr: "pipe",
          });
      await client.connect(transport);
      return client;
    };
    await work({
      client: await connect(
        mode === "stdio" ? "generic-sql-client" : "Claude Desktop",
      ),
      connect,
      file,
      second,
      denied,
    });
  } finally {
    await Promise.all(clients.map((client) => client.close()));
    await server?.stop();
    await removeTempDirectory(root);
  }
}

for (const mode of ["stdio", "http"] as const) {
  test(`${mode}: SQL patching remains optional and preserves TypeScript validation`, async () => {
    await project(mode, async ({ client, file }) => {
      const candidate =
        "CREATE POLICY member_access ON public.members FOR SELECT USING (true);\n";
      const result = fileResult(
        await client.callTool({
          name: "file_patch",
          arguments: { files: { [file]: entry(source, candidate) } },
        }),
        file,
      );
      expect(result.sql.validation.status).toBe("not_requested");
      expect(await readFile(file, "utf8")).toBe(candidate);

      const typescript = path.join(path.dirname(file), "example.ts");
      const original = "export const value = 1;\n";
      await writeFile(typescript, original);
      const rejected = await client.callTool({
        name: "file_patch",
        arguments: {
          files: { [typescript]: entry(original, "export const value = ;\n") },
        },
      });
      expect(rejected.isError).toBeTrue();
      expect(await readFile(typescript, "utf8")).toBe(original);
    });
  }, 30_000);

  test(`${mode}: PostgreSQL assistance validates complete candidates only when requested`, async () => {
    await project(mode, async ({ client, file }) => {
      const valid = "SELECT 2;\n";
      const accepted = fileResult(
        await client.callTool({
          name: "file_patch",
          arguments: { files: { [file]: entry(source, valid, postgres) } },
        }),
        file,
      );
      expect(accepted.sql.validation).toMatchObject({
        status: "valid",
        complete: true,
        dialect: "postgresql",
      });
      expect(await readFile(file, "utf8")).toBe(valid);

      const invalid = "SELECT FROM;\n";
      const rejected = await client.callTool({
        name: "file_patch",
        arguments: { files: { [file]: entry(valid, invalid, postgres) } },
      });
      expect(errorCode(rejected)).toBe("sql_validation_rejected");
      expect(await readFile(file, "utf8")).toBe(valid);

      const advisory = fileResult(
        await client.callTool({
          name: "file_patch",
          arguments: {
            files: {
              [file]: entry(valid, invalid, {
                ...postgres,
                policy: "advisory",
              }),
            },
          },
        }),
        file,
      );
      expect(advisory.sql).toMatchObject({
        allowed: true,
        policy: "advisory",
        validation: { status: "invalid" },
      });
      expect(advisory.sql.validation.diagnostics?.length).toBeGreaterThan(0);
      expect(await readFile(file, "utf8")).toBe(invalid);
    });
  }, 30_000);

  test(`${mode}: unsupported selectors are advisory unless required and batches remain atomic`, async () => {
    await project(mode, async ({ client, file, second }) => {
      for (const selector of [
        { dialect: "unavailable-dialect" },
        { dialect: "postgresql", variant: "unavailable-extension" },
      ]) {
        const rejected = await client.callTool({
          name: "file_patch",
          arguments: {
            files: {
              [file]: entry(source, "SELECT 2;\n", {
                ...selector,
                policy: "required",
              }),
            },
          },
        });
        expect(errorCode(rejected)).toBe("sql_validation_rejected");
        expect(await readFile(file, "utf8")).toBe(source);
        const preview = fileResult(
          await client.callTool({
            name: "file_patch",
            arguments: {
              files: { [file]: entry(source, "SELECT 2;\n", selector, true) },
            },
          }),
          file,
        );
        expect(preview.sql).toMatchObject({
          allowed: true,
          policy: "advisory",
          validation: { status: "unsupported" },
        });
      }
      const batch = await client.callTool({
        name: "file_patch",
        arguments: {
          files: {
            [file]: entry(source, "SELECT 2;\n", postgres),
            [second]: entry(source, "SELECT FROM;\n", postgres),
          },
        },
      });
      expect(errorCode(batch)).toBe("sql_validation_rejected");
      expect(await readFile(file, "utf8")).toBe(source);
      expect(await readFile(second, "utf8")).toBe(source);
    });
  }, 30_000);

  test(`${mode}: explicit skip overrides required SQL without granting denied filesystem access`, async () => {
    await project(
      mode,
      async ({ client, file, denied }) => {
        const rejected = await client.callTool({
          name: "file_patch",
          arguments: { files: { [file]: entry(source, "SELECT FROM;\n") } },
        });
        expect(errorCode(rejected)).toBe("sql_validation_rejected");
        const result = fileResult(
          await client.callTool({
            name: "file_patch",
            arguments: {
              files: {
                [file]: entry(source, "SELECT FROM;\n", { policy: "skip" }),
              },
            },
          }),
          file,
        );
        expect(result.sql).toMatchObject({
          allowed: true,
          overridden: true,
          policy: "skip",
          validation: { status: "skipped" },
        });
        const forbidden = await client.callTool({
          name: "file_patch",
          arguments: {
            files: {
              [denied]: entry(source, "SELECT 2;\n", { policy: "skip" }),
            },
          },
        });
        expect(forbidden.isError).toBeTrue();
        expect(await readFile(denied, "utf8")).toBe(source);
      },
      '[files.patch.sql]\npolicy = "required"\ndialect = "postgresql"',
    );
  }, 30_000);
}

test("HTTP SQL preview receipts bind policy, selectors, session, hashes, and configuration", async () => {
  await project("http", async ({ client, connect, file }) => {
    const preview = async () =>
      fileResult(
        await client.callTool({
          name: "file_patch",
          arguments: {
            files: { [file]: entry(source, "SELECT 2;\n", postgres, true) },
          },
        }),
        file,
      );
    const commit = (
      receipt: string,
      extra: Record<string, unknown> = {},
      actor = client,
    ) =>
      actor.callTool({
        name: "file_patch",
        arguments: {
          files: {
            [file]: {
              expectedSha256: sha256(source),
              previewReceipt: receipt,
              ...extra,
            },
          },
        },
      });
    for (const sql of [
      { ...postgres, policy: "skip" },
      { ...postgres, variant: "unavailable-extension" },
    ]) {
      const prepared = await preview();
      expect(errorCode(await commit(prepared.previewReceipt, { sql }))).toBe(
        "preview_receipt_sql_changed",
      );
      expect(await readFile(file, "utf8")).toBe(source);
    }
    const bound = await preview();
    const other = await connect("grok");
    expect(errorCode(await commit(bound.previewReceipt, {}, other))).toBe(
      "preview_receipt_session_mismatch",
    );
    expect(await readFile(file, "utf8")).toBe(source);
    expect(
      errorCode(
        await commit(bound.previewReceipt, {
          expectedSha256: sha256("different source"),
        }),
      ),
    ).toBe("stale_hash");
    expect(await readFile(file, "utf8")).toBe(source);
    const changed = await preview();
    const configuration = await client.callTool({
      name: "config_core",
      arguments: {
        files: {
          patch: { sql: { policy: "advisory", dialect: "postgresql" } },
        },
      },
    });
    expect(configuration.isError, JSON.stringify(configuration)).not.toBeTrue();
    expect(errorCode(await commit(changed.previewReceipt))).toBe(
      "preview_receipt_configuration_changed",
    );
    expect(await readFile(file, "utf8")).toBe(source);
    const fresh = await preview();
    fileResult(await commit(fresh.previewReceipt), file);
    expect(await readFile(file, "utf8")).toBe("SELECT 2;\n");
    expect(errorCode(await commit(fresh.previewReceipt))).toBe(
      "preview_receipt_unknown",
    );
  });
}, 30_000);
