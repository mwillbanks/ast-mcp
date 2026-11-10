import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const [output, ...options] = process.argv.slice(2);
if (
  !output ||
  options.some(
    (value) =>
      !["--with-pm", "--compiled-only", "--bytecode-only"].includes(value),
  ) ||
  new Set(options).size !== options.length
)
  throw new Error(
    "Usage: bun run scripts/build/qualify-standalone.ts <build-directory> [--compiled-only] [--bytecode-only] [--with-pm]",
  );
const compiledOnly = options.includes("--compiled-only");
const bytecodeOnly = options.includes("--bytecode-only");

const root = path.resolve(import.meta.dir, "../..");
const executable = (name: string) =>
  path.resolve(output, process.platform === "win32" ? `${name}.exe` : name);
const forms = [
  {
    name: "source",
    argv: [process.execPath, path.join(root, "bin/ast-mcp.ts")],
  },
  {
    name: "bundle",
    argv: [process.execPath, path.join(root, "dist/ast-mcp.js")],
  },
  { name: "plain", argv: [executable("ast-mcp-plain")] },
  { name: "bytecode", argv: [executable("ast-mcp-bytecode")] },
];
interface PackProof {
  language: string;
  sha256: string;
  status: string;
  version: string;
}

const original = "export function publish(value: string) { return value; }\n";
const candidate = original.replace("return value;", "return value.trim();");

for (const {
  name,
  argv: [command, ...args],
} of bytecodeOnly ? forms.slice(3) : compiledOnly ? forms.slice(2) : forms) {
  assert(command);
  const temp = await mkdtemp(path.join(tmpdir(), "ast-mcp-standalone-"));
  const cwd = await realpath(temp);
  const emptyPath = path.join(cwd, "empty-path");
  const filePaths = ["entry.ts", "other.ts"];
  const source = filePaths.map((file) => path.join(cwd, file));
  const git = Bun.which("git");
  assert(git, "Git is required for workspace discovery");
  const windows = process.platform === "win32";
  const env = {
    ...(windows
      ? {
          SystemRoot: process.env.SystemRoot,
          WINDIR: process.env.WINDIR,
          TEMP: cwd,
          TMP: cwd,
          USERPROFILE: cwd,
        }
      : {}),
    AST_MCP_EXPERIMENT_NATIVE_ONLY: "1",
    BUN_CONFIG_NO_AUTO_INSTALL: "1",
    DO_NOT_TRACK: "1",
    HOME: cwd,
    PATH: windows ? path.dirname(git) : emptyPath,
    XDG_CONFIG_HOME: path.join(cwd, "config"),
  };
  const run = (commandArgs: string[], overrides = {}) => {
    const child = Bun.spawnSync([command, ...args, ...commandArgs], {
      cwd,
      env: { ...env, ...overrides },
      timeout: 30_000,
    });
    assert.equal(child.exitCode, 0, child.stderr.toString());
    return child.stdout.toString().trim();
  };
  const client = new Client({ name: "standalone-qualification", version: "1" });
  try {
    await mkdir(emptyPath);
    if (!windows) await symlink(git, path.join(emptyPath, path.basename(git)));
    assert.equal(Bun.which("bun", { PATH: env.PATH }), null);
    assert.equal(Bun.which("node", { PATH: env.PATH }), null);
    await Promise.all(source.map((file) => Bun.write(file, original)));
    await Bun.write(
      path.join(cwd, "native.rs"),
      "pub fn standalone() -> i32 { 1 }\n",
    );
    await Bun.write(
      path.join(cwd, "ast-mcp.toml"),
      `version = 2
[telemetry]
enabled = false
[formatting]
enabled = false
[[paths]]
id = "benchmark-workspace"
path = "."
policies = { read = "allow", write = "allow", delete = "allow" }
`,
    );
    const validated = JSON.parse(run(["config", "validate"]));
    assert.equal(validated.valid, true);
    assert.equal(validated.projectRoot, cwd);
    const embeddedBun = args.length
      ? null
      : run(["--version"], { BUN_BE_BUN: "1" });
    if (embeddedBun !== null) assert.equal(embeddedBun, Bun.version);
    const pack: PackProof | null =
      options.includes("--with-pm") && embeddedBun !== null
        ? JSON.parse(run(["pm", "install", "go", "--output", "json"])).pack
        : null;
    if (pack) {
      assert.equal(pack.status, "installed");
      const cached: PackProof = JSON.parse(
        run(["pm", "install", "go", "--offline", "--output", "json"]),
      ).pack;
      assert.equal(cached.sha256, pack.sha256);
      await Bun.write(
        path.join(cwd, "pack.go"),
        "package smoke\nfunc Publish() int { return 1 }\n",
      );
    }

    await client.connect(
      new StdioClientTransport({
        args: [...args, "mcp"],
        command,
        cwd,
        env,
        stderr: "inherit",
      }),
      { timeout: 10_000 },
    );
    assert(
      (await client.listResources()).resources.some((resource) =>
        resource.uri.includes("SKILL.md"),
      ),
    );
    async function tool<T>(
      toolName: string,
      parameters: Record<string, unknown>,
    ): Promise<T> {
      const result = await client.callTool({
        name: toolName,
        arguments: parameters,
      });
      assert(
        !result.isError,
        `${toolName}: ${JSON.stringify(result.structuredContent)}`,
      );
      const payload = result.structuredContent as { ok: boolean; data: T };
      assert(
        payload.ok,
        `${toolName}: ${JSON.stringify(result.structuredContent)}`,
      );
      return payload.data;
    }

    const storage = { kind: "explicit", path: path.join(cwd, "store") };
    const workspace = async () => {
      const opened = await tool<unknown>("workspace_open", {
        directory: cwd,
        storage,
      });
      const workspaceId = JSON.stringify(opened).match(
        /workspace:v1:[a-f0-9]{64}/,
      )?.[0];
      assert(workspaceId, "workspace_open omitted its workspace identity");
      return workspaceId;
    };
    const workspaceId = await workspace();
    const map = await tool<{ scan: { parsed: number } }>("map", {
      paths: ["entry.ts"],
      workspaceId,
    });
    assert.equal(map.scan.parsed, 1);
    assert(JSON.stringify(map).includes("publish"));
    const rust = await tool<{ items: unknown[]; scan: { parsed: number } }>(
      "run",
      {
        paths: ["native.rs"],
        lang: "rust",
        json: true,
        pattern: "pub fn standalone() -> i32 { 1 }",
        workspaceId,
      },
    );
    assert.equal(rust.scan.parsed, 1);
    assert.equal(rust.items.length, 1, JSON.stringify(rust));
    if (pack) {
      const mappedGo = await tool<{ scan: { parsed: number } }>("map", {
        paths: ["pack.go"],
        workspaceId,
      });
      assert.equal(mappedGo.scan.parsed, 1);
      assert(JSON.stringify(mappedGo).includes("Publish"));
    }
    const indexed = await tool<{ generation: string }>("index", {
      action: "build",
      workspaceId,
    });
    assert.match(indexed.generation, /^generation:v1:[a-f0-9]{64}$/);
    const retrieved = await tool<{ results: unknown[] }>("retrieve", {
      budget: {
        maxBytes: 64_000,
        maxCandidates: 100,
        maxItems: 20,
        timeoutMs: 30_000,
      },
      query: "publish",
      semantic: false,
      workspaceId,
    });
    assert(retrieved.results.length > 0);
    const sha = await tool<{ files: Array<{ sha256: string }> }>("file_hash", {
      filePaths,
      workspaceId,
    });
    const hashes = sha.files.map(({ sha256 }) => sha256);
    assert.equal(hashes.length, filePaths.length);
    const preview = await tool<{
      files: Record<string, { previewReceipt: string }>;
    }>("file_patch", {
      files: Object.fromEntries(
        filePaths.map((file, i) => [
          file,
          {
            astRules: [
              {
                pattern: "return value;",
                fix: "return value.trim();",
                expectedMatches: 1,
              },
            ],
            expectedSha256: hashes[i],
            patchStrategy: "ast",
            preview: true,
          },
        ]),
      ),
      workspaceId,
    });
    const prepared = Object.values(preview.files);
    assert.equal(prepared.length, filePaths.length);
    assert(prepared.every(({ previewReceipt }) => previewReceipt));
    const sourceBytes = () =>
      Promise.all(source.map((file) => Bun.file(file).text()));
    assert.deepEqual(
      await sourceBytes(),
      source.map(() => original),
    );
    await tool("file_patch", {
      files: Object.fromEntries(
        filePaths.map((file, i) => [
          file,
          {
            expectedSha256: hashes[i],
            previewReceipt: prepared[i]?.previewReceipt,
          },
        ]),
      ),
      workspaceId,
    });
    assert.deepEqual(
      await sourceBytes(),
      source.map(() => candidate),
    );

    console.log(
      JSON.stringify({
        name,
        executable: command,
        args,
        bun: Bun.version,
        embeddedBun,
        nativePack: pack
          ? {
              language: pack.language,
              version: pack.version,
              sha256: pack.sha256,
            }
          : null,
        checks: [
          "configuration",
          "skills",
          "native TypeScript map",
          "native Rust match",
          "index",
          "retrieve",
          "receipt commit",
          "exact bytes",
        ],
        executableBytes: await Bun.file(args[0] ?? command).size,
      }),
    );
  } catch (error) {
    throw new Error(`${name} parity failed`, { cause: error });
  } finally {
    await client.close();
    await rm(cwd, { force: true, recursive: true });
  }
}
