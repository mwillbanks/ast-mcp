import { test as bunTest, expect } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Language, Parser } from "web-tree-sitter";

import { wasmGrammarAssets } from "../../src/intelligence/languages/shared/wasm-assets";
import { commandForPlatform } from "../../src/runtime/subprocess";
import { spawnHttpMcpProcess, spawnLiveProcess } from "../support/live-process";
import {
  exerciseSkillsHttp,
  exerciseSkillsRequests,
  exerciseModernWorkspaceHttp,
} from "../support/skills-protocol";

const consumerBun = process.env.AST_MCP_CONSUMER_BUN || process.execPath;

function consumerEnvironment(inherited = process.env): Record<string, string> {
  const inheritedPath = Object.entries(inherited).find(
    ([key]) => key.toUpperCase() === "PATH",
  )?.[1];
  const environment = Object.fromEntries(
    Object.entries(inherited).filter(
      ([key, value]) =>
        value !== undefined &&
        key.toUpperCase() !== "PATH" &&
        !/^(?:NODE_PATH|NODE_OPTIONS|BUN_OPTIONS|BUN_INSTALL|NAPI_RS_NATIVE_LIBRARY_PATH|AST_MCP_)/i.test(
          key,
        ),
    ),
  ) as Record<string, string>;
  environment.PATH = [path.dirname(consumerBun), inheritedPath]
    .filter(Boolean)
    .join(path.delimiter);
  environment.BUN_CONFIG_NO_AUTO_INSTALL = "1";
  environment.DO_NOT_TRACK = "1";
  return environment;
}

bunTest(
  "consumer environments preserve Windows Path while removing runtime overrides",
  () => {
    const environment = consumerEnvironment({
      Path: "system-bin",
      NODE_PATH: "repository-modules",
      NODE_OPTIONS: "--require=repository-hook",
      NAPI_RS_NATIVE_LIBRARY_PATH: "native-override",
      AST_MCP_PACKAGE_ARCHIVE: "archive",
    });
    expect(environment.PATH).toBe(
      [path.dirname(consumerBun), "system-bin"].join(path.delimiter),
    );
    expect(environment.Path).toBeUndefined();
    for (const key of [
      "NODE_PATH",
      "NODE_OPTIONS",
      "NAPI_RS_NATIVE_LIBRARY_PATH",
      "AST_MCP_PACKAGE_ARCHIVE",
    ])
      expect(environment[key]).toBeUndefined();
    expect(environment.BUN_CONFIG_NO_AUTO_INSTALL).toBe("1");
  },
);

async function command(
  args: string[],
  cwd: string,
  env = consumerEnvironment(),
  timeoutMs = 90_000,
): Promise<string> {
  const platformCommand = commandForPlatform(args[0]!, args.slice(1));
  const child = Bun.spawn([platformCommand.command, ...platformCommand.args], {
    cwd,
    env,
    stdin: "ignore",
    windowsVerbatimArguments: platformCommand.windowsVerbatimArguments,
    stderr: "pipe",
    stdout: "pipe",
    timeout: timeoutMs,
  });
  const [exitCode, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  if (exitCode !== 0) {
    const dependencyDiagnostics = args.includes("audit")
      ? await command(["npm", "ls", "sharp", "--all"], cwd, env).catch(String)
      : "";
    throw new Error(
      `${args.join(" ")} failed (exit ${exitCode}): ${stderr.trim()}\n${stdout.trim()}\n${dependencyDiagnostics}`,
    );
  }
  return stdout.trim();
}

function workspaceId(result: unknown): string {
  const match = JSON.stringify(result).match(/workspace:v1:[a-f0-9]{64}/);
  if (!match) throw new Error("workspace_open omitted workspaceId");
  return match[0];
}

function toolData<T>(result: Awaited<ReturnType<Client["callTool"]>>): T {
  expect(
    result.isError,
    JSON.stringify(result.structuredContent),
  ).not.toBeTrue();
  const data = (result.structuredContent as { data?: T } | undefined)?.data;
  expect(data).toBeDefined();
  if (!data) throw new Error("Tool omitted structured data");
  return data;
}

async function callPackageTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
) {
  try {
    return await client.callTool({ arguments: args, name });
  } catch (error) {
    throw new Error(`Packaged MCP ${name} operation failed: ${String(error)}`, {
      cause: error,
    });
  }
}

async function exercisePackage(
  client: Client,
  fixture: string,
  storagePath: string,
  writable: string,
): Promise<void> {
  const opened = await callPackageTool(client, "workspace_open", {
    directory: fixture,
    storage: { kind: "explicit", path: storagePath },
  });
  const id = workspaceId(opened.structuredContent);
  const mapped = toolData<{
    files: Array<{ symbols: Array<{ name: string }> }>;
    scan: { parsed: number; omitted: number };
  }>(
    await callPackageTool(client, "map", {
      paths: ["entry.ts"],
      workspaceId: id,
    }),
  );
  expect(
    mapped.files.flatMap((file) => file.symbols.map((symbol) => symbol.name)),
  ).toContain("publish");

  expect(mapped.scan.parsed).toBe(1);
  expect(mapped.scan.omitted).toBe(0);
  const searched = toolData<{
    items: unknown[];
    scan: { parsed: number; omitted: number };
  }>(
    await callPackageTool(client, "run", {
      paths: ["entry.ts"],
      pattern: "export function publish($$$ARGS) { $$$BODY }",
      lang: "typescript",
      json: true,
      workspaceId: id,
    }),
  );
  expect(searched.items.length).toBeGreaterThan(0);
  expect(searched.scan.parsed).toBe(1);
  expect(searched.scan.omitted).toBe(0);
  for (const filename of ["grammar.toml", "grammar.yaml", "grammar.md"]) {
    const grammar = toolData<{
      scan: { parsed: number; omitted: number };
      files: unknown[];
    }>(
      await callPackageTool(client, "map", {
        paths: [filename],
        workspaceId: id,
      }),
    );
    expect(grammar.scan.parsed, filename).toBe(1);
    expect(grammar.scan.omitted, filename).toBe(0);
    expect(grammar.files, filename).toHaveLength(1);
    expect(grammar.files[0], filename).toMatchObject({
      diagnostics: [],
      partial: false,
    });
  }
  const astRead = toolData<{
    files: Array<{ resolvedMode: string; content: unknown }>;
  }>(
    await callPackageTool(client, "file_read", {
      files: [{ filePath: "entry.ts", mode: "ast" }],
      workspaceId: id,
    }),
  );
  expect(astRead.files[0]?.resolvedMode).toBe("ast");
  expect(JSON.stringify(astRead)).toContain("publish");

  const built = toolData<{ generation: string }>(
    await callPackageTool(client, "index", {
      action: "build",
      workspaceId: id,
    }),
  );
  expect(built.generation).toMatch(/^generation:v1:[a-f0-9]{64}$/);
  const status = toolData<{
    counts: Record<string, number>;
    generation: string | null;
  }>(
    await callPackageTool(client, "index_status", {
      timeoutMs: 30_000,
      workspaceId: id,
    }),
  );
  expect(status.generation).toBe(built.generation);
  expect(status.counts.artifacts).toBeGreaterThan(0);
  expect(status.counts.chunks).toBeGreaterThan(0);
  expect(status.counts.publications).toBeGreaterThan(0);

  const retrieved = toolData<{ results: unknown[] }>(
    await callPackageTool(client, "retrieve", {
      budget: {
        maxBytes: 64_000,
        maxCandidates: 100,
        maxItems: 20,
        timeoutMs: 30_000,
      },
      query: "publish",
      semantic: false,
      workspaceId: id,
    }),
  );
  expect(retrieved.results.length).toBeGreaterThan(0);

  const hashed = toolData<{ files: Array<{ sha256: string }> }>(
    await callPackageTool(client, "file_hash", {
      filePaths: [writable],
      workspaceId: id,
    }),
  );
  const patch = {
    [writable]: {
      aiderBlocks: [{ replace: "updated\n", search: "original\n" }],
      expectedSha256: hashed.files[0]?.sha256,
      patchStrategy: "aider_block",
    },
  };
  toolData(
    await callPackageTool(client, "file_patch", {
      files: { [writable]: { ...patch[writable], preview: true } },
      workspaceId: id,
    }),
  );
  expect(await readFile(path.join(fixture, writable), "utf8")).toBe(
    "original\n",
  );
  toolData(
    await callPackageTool(client, "file_patch", {
      files: {
        [writable]: {
          aiderBlocks: [{ replace: "updated\n", search: "original\n" }],
          expectedSha256: hashed.files[0]?.sha256,
          patchStrategy: "aider_block",
        },
      },
      workspaceId: id,
    }),
  );
  expect(await readFile(path.join(fixture, writable), "utf8")).toBe(
    "updated\n",
  );
  // Refresh the workspace identity so this rejects the old hash, not overlay drift.
  const reopened = await callPackageTool(client, "workspace_open", {
    directory: fixture,
    storage: { kind: "explicit", path: storagePath },
  });
  const stale = await callPackageTool(client, "file_patch", {
    files: patch,
    workspaceId: workspaceId(reopened.structuredContent),
  });
  expect(stale.isError).toBeTrue();
  expect(JSON.stringify(stale)).toContain("hash");
  expect(await readFile(path.join(fixture, writable), "utf8")).toBe(
    "updated\n",
  );
}

async function startHttpServer(executable: string, fixture: string) {
  const server = await spawnHttpMcpProcess(consumerBun, [executable, "mcp"], {
    cwd: fixture,
    env: consumerEnvironment(),
    timeoutMs: 30_000,
  });
  const client = new Client({ name: "package-http-smoke", version: "1" });
  try {
    await client.connect(new StreamableHTTPClientTransport(server.url), {
      timeout: 5_000,
    });
    return {
      client,
      url: server.url,
      diagnostics: server.diagnostics,
      stop: server.stop,
    };
  } catch (error) {
    await client.close().catch(() => undefined);
    await server.stop();
    throw new Error(
      `Packaged HTTP server rejected MCP initialize: ${String(error)}\n${server.diagnostics()}`,
      { cause: error },
    );
  }
}

const test = bunTest.skipIf(process.env.AST_MCP_SKIP_PACKAGE_SMOKE === "1");

const selectedInstaller = process.env.AST_MCP_CONSUMER_INSTALLER;
if (
  selectedInstaller &&
  selectedInstaller !== "bun" &&
  selectedInstaller !== "npm"
)
  throw new Error("AST_MCP_CONSUMER_INSTALLER must be bun or npm");
async function exerciseConsumer(installer: string) {
  const repository = path.resolve(import.meta.dir, "../..");
  const owned = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-package-smoke-"));
  const fixture = path.join(owned, "fixture");
  try {
    let archive = process.env.AST_MCP_PACKAGE_ARCHIVE;
    if (!archive) {
      await command([process.execPath, "run", "build"], repository);
      const packed = await command(
        [
          process.execPath,
          "pm",
          "pack",
          "--ignore-scripts",
          "--destination",
          owned,
          "--quiet",
        ],
        repository,
      );
      archive = path.isAbsolute(packed)
        ? packed
        : path.join(owned, path.basename(packed));
    }
    archive = path.resolve(archive);
    const archivedPaths = await command(["tar", "-tzf", archive], repository);
    expect(archivedPaths).not.toContain("node_modules");
    await command(["tar", "-xzf", archive, "-C", owned], repository);
    await Parser.init();
    for (const grammar of wasmGrammarAssets) {
      const asset = path.join(
        owned,
        "package",
        "dist",
        "workers",
        "out",
        grammar,
        `tree-sitter-${grammar}.wasm`,
      );
      const language = await Language.load(asset);
      const parser = new Parser();
      try {
        parser.setLanguage(language);
        expect(parser.language).toBe(language);
        const tree = parser.parse("");
        expect(tree).not.toBeNull();
        tree?.delete();
      } finally {
        parser.delete();
      }
    }
    await command(["git", "init", "-q", fixture], repository);
    await Promise.all([
      writeFile(
        path.join(fixture, "entry.ts"),
        "export function publish(value: string) { return value; }\n",
      ),
      writeFile(
        path.join(fixture, "Main.java"),
        "public final class Main { public static void run() {} }\n",
      ),
      writeFile(
        path.join(fixture, "grammar.toml"),
        '[packageFixture]\nname = "native grammar"\n',
      ),
      writeFile(
        path.join(fixture, "grammar.yaml"),
        "packageFixture:\n  name: native grammar\n",
      ),
      writeFile(
        path.join(fixture, "grammar.md"),
        "# packageFixture\n\nNative grammar **content**.\n",
      ),
      writeFile(
        path.join(fixture, "bunfig.toml"),
        '[install]\nauto = "disable"\n',
      ),
      writeFile(path.join(fixture, "stdio.txt"), "original\n"),
      writeFile(path.join(fixture, "http.txt"), "original\n"),
      writeFile(path.join(fixture, "modern.txt"), "original\n"),
    ]);
    await command(["git", "add", "."], fixture);
    await command(
      [
        "git",
        "-c",
        "user.email=package@example.invalid",
        "-c",
        "user.name=Package Smoke",
        "commit",
        "-qm",
        "fixture",
      ],
      fixture,
    );

    const consumer = path.join(owned, "consumer");
    // Fresh caches prevent local-tarball cache entries from masking changed bytes.
    const installEnvironment = {
      ...consumerEnvironment(),
      BUN_INSTALL_CACHE_DIR: path.join(owned, "bun-cache"),
      npm_config_cache: path.join(owned, "npm-cache"),
    };
    await mkdir(consumer);
    await writeFile(
      path.join(consumer, "package.json"),
      JSON.stringify({
        dependencies: { "@mwillbanks/ast-mcp": archive },
        private: true,
      }),
    );
    await command(
      installer === "bun"
        ? [process.execPath, "install", "--production", "--ignore-scripts"]
        : [
            "npm",
            "install",
            "--omit=dev",
            "--ignore-scripts",
            "--no-audit",
            "--no-fund",
          ],
      consumer,
      installEnvironment,
      installer === "npm" ? 300_000 : 90_000,
    );
    const installedPackage = path.join(
      consumer,
      "node_modules",
      "@mwillbanks",
      "ast-mcp",
    );
    const installedManifest = JSON.parse(
      await readFile(path.join(installedPackage, "package.json"), "utf8"),
    );
    if (installer === "bun") {
      await command(
        [process.execPath, "install", "--lockfile-only", "--ignore-scripts"],
        consumer,
        installEnvironment,
      );
      expect(
        JSON.parse(
          await command(
            [process.execPath, "audit", "--json"],
            consumer,
            installEnvironment,
          ),
        ),
      ).toEqual({});
    } else {
      const audit = JSON.parse(
        await command(
          ["npm", "audit", "--omit=dev", "--json"],
          consumer,
          installEnvironment,
        ),
      );
      expect(audit.metadata.vulnerabilities.total).toBe(0);
    }
    expect(installedManifest.dependencies["@lancedb/lancedb"]).toBeUndefined();
    expect(installedManifest.devDependencies["@lancedb/lancedb"]).toBe(
      "0.40.0",
    );
    await expect(
      readFile(
        path.join(
          consumer,
          "node_modules",
          "@lancedb",
          "lancedb",
          "package.json",
        ),
        "utf8",
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const launcherCandidates = (
      process.platform === "win32"
        ? ["ast-mcp.exe", "ast-mcp.cmd", "ast-mcp"]
        : ["ast-mcp"]
    ).map((name) => path.join(consumer, "node_modules", ".bin", name));
    const launcher = (
      await Promise.all(
        launcherCandidates.map(async (candidate) =>
          (await Bun.file(candidate).exists()) ? candidate : undefined,
        ),
      )
    ).find(Boolean);
    if (!launcher)
      throw new Error("Consumer installation omitted the ast-mcp launcher");
    // An ignored stdin reproduces startup with immediate EOF through the real launcher.
    expect(await command([launcher, "mcp"], fixture)).toBe("");
    const executable = path.join(installedPackage, "dist", "ast-mcp.js");
    const canonicalFixture = await realpath(fixture);
    const jsonOutput = JSON.parse(
      await command([consumerBun, executable, "config", "validate"], fixture),
    );
    expect(jsonOutput).toMatchObject({ valid: true });
    expect(await realpath(jsonOutput.projectRoot)).toBe(canonicalFixture);
    for (const format of ["human", "json", "yaml", "toml"] as const) {
      const output = await command(
        [consumerBun, executable, "--output", format, "config", "validate"],
        fixture,
      );
      if (format === "human")
        expect(output).toContain("Configuration validation");
      else {
        const parsed =
          format === "json"
            ? JSON.parse(output)
            : format === "yaml"
              ? Bun.YAML.parse(output)
              : Bun.TOML.parse(output);
        expect(parsed).toMatchObject({ valid: true });
        expect(await realpath(parsed.projectRoot as string)).toBe(
          canonicalFixture,
        );
      }
    }
    const exported = JSON.parse(
      await command(
        [
          consumerBun,
          executable,
          "skills",
          "export",
          path.join(owned, "exported-skills"),
        ],
        fixture,
      ),
    );
    expect(exported).toMatchObject({
      operation: "export",
      preserved: [],
      written: expect.arrayContaining(["SKILL.md"]),
    });
    const exportedDirectory = path.join(owned, "exported-skills");
    const updateArguments = [
      consumerBun,
      executable,
      "skills",
      "update",
      exportedDirectory,
      "--output",
      "json",
    ];
    const unchangedSkills = JSON.parse(await command(updateArguments, fixture));
    expect(unchangedSkills).toMatchObject({
      operation: "update",
      written: [],
      updated: [],
      conflicts: [],
    });
    expect(unchangedSkills.unchanged).toContain("SKILL.md");
    const skillPath = path.join(exportedDirectory, "SKILL.md");
    const currentSkill = await readFile(skillPath, "utf8");
    const exportManifestPath = path.join(
      exportedDirectory,
      ".ast-mcp-export.json",
    );
    const exportManifest = JSON.parse(
      await readFile(exportManifestPath, "utf8"),
    );
    // Simulate a previously exported version with its matching managed baseline.
    const previousSkill = "# Previous bundled skill\n";
    await writeFile(skillPath, previousSkill);
    exportManifest.files["SKILL.md"] = createHash("sha256")
      .update(previousSkill)
      .digest("hex");
    await writeFile(exportManifestPath, JSON.stringify(exportManifest));
    const refreshedSkills = JSON.parse(await command(updateArguments, fixture));
    expect(refreshedSkills.updated).toEqual(["SKILL.md"]);
    expect(refreshedSkills.conflicts).toEqual([]);
    expect(await readFile(skillPath, "utf8")).toBe(currentSkill);
    expect(
      JSON.parse(await readFile(exportManifestPath, "utf8")).files["SKILL.md"],
    ).toBe(createHash("sha256").update(currentSkill).digest("hex"));
    const customized = currentSkill + "\nUser customization\n";
    await writeFile(skillPath, customized);
    const conflictProcess = Bun.spawn(updateArguments, {
      cwd: fixture,
      env: consumerEnvironment(),
      stderr: "pipe",
      stdout: "pipe",
      timeout: 90_000,
    });
    const [conflictExit, conflictStdout, conflictStderr] = await Promise.all([
      conflictProcess.exited,
      new Response(conflictProcess.stdout).text(),
      new Response(conflictProcess.stderr).text(),
    ]);
    expect(conflictExit).not.toBe(0);
    expect(JSON.parse(conflictStdout)).toMatchObject({
      operation: "update",
      conflicts: ["SKILL.md"],
      preserved: ["SKILL.md"],
    });
    expect(conflictStderr).toContain("Compare these files with a fresh export");
    expect(await readFile(skillPath, "utf8")).toBe(customized);
    const skills = spawnLiveProcess(consumerBun, [executable, "mcp"], {
      cwd: fixture,
      env: consumerEnvironment(),
      timeoutMs: 30_000,
    });
    let requestId = 0;
    try {
      await exerciseSkillsRequests(async (method, params = {}) => {
        const id = ++requestId;
        skills.process.stdin.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            method,
            params: {
              ...params,
              _meta: {
                "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                "io.modelcontextprotocol/clientCapabilities": {},
              },
            },
          }) + "\n",
        );
        for (;;) {
          const message = JSON.parse(await skills.readStdoutLine());
          if (message.id === id) return message;
        }
      });
      skills.process.stdin.end();
      expect(await skills.waitForExit()).toBe(0);
    } finally {
      await skills.stop();
    }
    const stdio = new Client({ name: "package-stdio-smoke", version: "1" });
    const stdioTransport = new StdioClientTransport({
      args: [executable, "mcp"],
      command: consumerBun,
      env: consumerEnvironment(),
      cwd: fixture,
      stderr: "pipe",
    });
    await stdio.connect(stdioTransport);
    try {
      await exercisePackage(
        stdio,
        fixture,
        path.join(owned, "stdio-storage"),
        "stdio.txt",
      );
    } finally {
      await stdio.close();
    }

    const httpServer = await startHttpServer(executable, fixture);
    try {
      await exerciseSkillsHttp(httpServer.url);
      await exerciseModernWorkspaceHttp(
        httpServer.url,
        fixture,
        path.join(owned, "modern-storage"),
      );
      try {
        try {
          await exercisePackage(
            httpServer.client,
            fixture,
            path.join(owned, "http-storage"),
            "http.txt",
          );
        } catch (error) {
          throw new Error(
            `Packaged HTTP lifecycle failed: ${String(error)}\n${httpServer.diagnostics()}`,
            { cause: error },
          );
        }
      } finally {
        await httpServer.client.close();
      }
    } finally {
      await httpServer.stop();
    }
  } finally {
    await rm(owned, { force: true, recursive: true });
  }
}

test.each(selectedInstaller ? [selectedInstaller] : ["bun", "npm"])(
  "%s production package supports stdio and HTTP lifecycle operations",
  exerciseConsumer,
  360_000,
);
