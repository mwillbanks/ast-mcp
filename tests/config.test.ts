import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  clearConfigCache,
  configRequestPaths,
  currentConfig,
  globalConfigPath,
  resolveConfig,
} from "../src/config";
import { configuredExecution, localExecution } from "../src/tools/configured";

const created: string[] = [];

async function project(prefix: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  created.push(root);
  await mkdir(path.join(root, ".git"));
  return root;
}

afterEach(async () => {
  clearConfigCache();
  await Promise.all(
    created
      .splice(0)
      .map((folder) => rm(folder, { force: true, recursive: true })),
  );
});

test("resolves defaults and platform global paths", async () => {
  const root = await project("ast-mcp-config-default-");
  const config = await resolveConfig({
    cwd: root,
    env: {},
    home: path.join(root, "home"),
    platform: "linux",
  });
  expect(config.projectRoot).toBe(root);
  expect(config.workspace.roots).toEqual([root]);
  expect(config.safety.allowExternalRoots).toBeFalse();
  expect(config.http).toEqual({
    host: "127.0.0.1",
    port: 3768,
    sessionSweepIntervalMs: 60_000,
    sessionTimeoutMs: 1_800_000,
  });
  expect(config.provenance["http.port"]).toBe("default");
  expect(
    globalConfigPath({
      env: {},
      home: path.join(root, "home"),
      platform: "win32",
    }),
  ).toBe(path.join(root, "home", "AppData/Roaming/ast-mcp/ast-mcp.toml"));
});

test("deep merges global, project, and environment layers with provenance", async () => {
  const root = await project("ast-mcp-config-layers-");
  const globalHome = path.join(root, "xdg");
  const globalFile = path.join(globalHome, "ast-mcp/ast-mcp.toml");
  await mkdir(path.dirname(globalFile), { recursive: true });
  await mkdir(path.join(root, "nested"));
  await writeFile(
    path.join(path.dirname(globalFile), "global-dprint.json"),
    "{}",
  );
  await writeFile(
    globalFile,
    `[http]
  host = "global.example"
  port = 4000
  
  [safety]
  allow_external_roots = true
  
  [formatting]
  dprint_config = "./global-dprint.json"
  `,
  );
  await writeFile(
    path.join(root, "ast-mcp.toml"),
    `version = 1

[workspace]
roots = [".", "./nested"]

[http]
port = 5000

[safety]
allow_external_roots = false

[dependencies]
ast_bro_binary = "./bin/ast-bro"
`,
  );

  const config = await resolveConfig({
    cwd: root,
    env: {
      AST_MCP_HTTP_HOST: "env.example",
      AST_MCP_SESSION_TIMEOUT_MS: "9000",
      XDG_CONFIG_HOME: globalHome,
    },
    platform: "linux",
  });
  expect(config.workspace.roots).toEqual([root, path.join(root, "nested")]);
  expect(config.safety.allowExternalRoots).toBeFalse();
  expect(config.http.host).toBe("env.example");
  expect(config.http.port).toBe(5000);
  expect(config.http.sessionTimeoutMs).toBe(9000);
  expect(config.formatting.dprintConfig).toBe(
    path.join(globalFile, "../global-dprint.json"),
  );
  expect(config.dependencies.astBroBinary).toBe(path.join(root, "bin/ast-bro"));
  expect(config.provenance).toMatchObject({
    "formatting.dprint_config": "global",
    "http.host": "environment",
    "http.port": "project",
    "safety.allow_external_roots": "project",
    "workspace.roots": "project",
  });
  expect(config.sources.environment).toEqual([
    "AST_MCP_HTTP_HOST",
    "AST_MCP_SESSION_TIMEOUT_MS",
  ]);
});

test("reports malformed TOML, unknown keys, and invalid environment values", async () => {
  const root = await project("ast-mcp-config-errors-");
  const file = path.join(root, "ast-mcp.toml");
  await writeFile(file, "value = [\n");
  await expect(resolveConfig({ cwd: root, env: {} })).rejects.toThrow(
    `${file}: invalid TOML`,
  );

  clearConfigCache();
  await writeFile(file, "[safety]\nallow_external_root = true\n");
  await expect(resolveConfig({ cwd: root, env: {} })).rejects.toThrow(
    "safety: Unrecognized key",
  );

  clearConfigCache();
  await rm(file);
  await expect(
    resolveConfig({
      cwd: root,
      env: { AST_MCP_ALLOW_EXTERNAL_ROOTS: "sometimes" },
    }),
  ).rejects.toThrow("AST_MCP_ALLOW_EXTERNAL_ROOTS must be");
  await expect(
    resolveConfig({ cwd: root, env: { PORT: "70000" } }),
  ).rejects.toThrow("PORT must be an integer from 1 to 65535");
});

test("reloads changed and deleted files while caching unchanged resolutions", async () => {
  const root = await project("ast-mcp-config-cache-");
  const file = path.join(root, "ast-mcp.toml");
  await writeFile(file, "[http]\nport = 3100\n");
  const first = await resolveConfig({ cwd: root, env: {} });
  const cached = await resolveConfig({ cwd: root, env: {} });
  expect(cached).toBe(first);

  await writeFile(file, "[http]\nport = 32000\n");
  const changed = await resolveConfig({ cwd: root, env: {} });
  expect(changed).not.toBe(first);
  expect(changed.http.port).toBe(32000);

  await rm(file);
  const deleted = await resolveConfig({ cwd: root, env: {} });
  expect(deleted.http.port).toBe(3768);
  expect(deleted.sources.project).toBeUndefined();
});

test("uses client roots and rejects a request crossing conflicting policies", async () => {
  const first = await project("ast-mcp-config-root-a-");
  const second = await project("ast-mcp-config-root-b-");
  await writeFile(
    path.join(first, "ast-mcp.toml"),
    '[formatting]\ndprint_config = "./first.json"\n',
  );
  await writeFile(path.join(first, "first.json"), "{}");
  await writeFile(
    path.join(second, "ast-mcp.toml"),
    '[formatting]\ndprint_config = "./second.json"\n',
  );
  await writeFile(path.join(second, "second.json"), "{}");

  const selected = await resolveConfig({
    clientRoots: [`file://${first}`, `file://${second}`],
    cwd: os.tmpdir(),
    env: {},
    requestPaths: [path.join(second, "value.ts")],
  });
  expect(selected.projectRoot).toBe(second);
  expect(selected.trustedRoots).toEqual([first, second]);

  await expect(
    resolveConfig({
      clientRoots: [first, second],
      cwd: os.tmpdir(),
      env: {},
      requestPaths: [
        path.join(first, "value.ts"),
        path.join(second, "value.ts"),
      ],
    }),
  ).rejects.toThrow("conflicting ast-mcp policies");
});

test("extracts paths from direct and keyed tool request shapes", () => {
  expect(
    configRequestPaths({
      "/repo/a.ts": {
        destination: "/repo/b.ts",
        expectedSha256: "a".repeat(64),
      },
      paths: ["src", "/repo/c.ts"],
    }),
  ).toEqual(["/repo/a.ts", "/repo/b.ts", "src", "/repo/c.ts"]);
});

test("runs local tool operations inside the active configuration", async () => {
  const config = await localExecution({}, currentConfig);
  expect(config.projectRoot).toBe(process.cwd());
});

test("queries MCP roots only when the client advertises the capability", async () => {
  let unsupportedListCalled = false;
  const unsupported = {
    server: {
      getClientCapabilities: () => ({}),
      listRoots: async () => {
        unsupportedListCalled = true;
        return { roots: [] };
      },
    },
  } as unknown as McpServer;
  const fallback = await configuredExecution(unsupported)({}, currentConfig);
  expect(fallback.projectRoot).toBe(process.cwd());
  expect(unsupportedListCalled).toBeFalse();

  const root = await project("ast-mcp-config-client-root-");
  await writeFile(path.join(root, "ast-mcp.toml"), "[http]\nport = 4321\n");
  const supported = {
    server: {
      getClientCapabilities: () => ({ roots: {} }),
      listRoots: async () => ({
        roots: [{ uri: `file://${root}` }],
      }),
    },
  } as unknown as McpServer;
  const selected = await configuredExecution(supported)(
    { path: path.join(root, "src") },
    currentConfig,
  );
  expect(selected.projectRoot).toBe(root);
  expect(selected.http.port).toBe(4321);
});
