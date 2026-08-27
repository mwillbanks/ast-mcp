import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { clearConfigCache, resolveConfig, withConfig } from "../src/config";
import {
  existingPathPolicies,
  pathTableIds,
  validateConfigSource,
  writeConfigSource,
} from "../src/config-edit";
import { configRegistry } from "../src/config-registry";
import {
  InputRequiredSignal,
  withApprovalContext,
} from "../src/runtime/approval";
import { applyConfigCore, applyConfigPaths } from "../src/runtime/config-write";

const created: string[] = [];

async function project(prefix: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  created.push(root);
  await mkdir(path.join(root, ".git"));
  return root;
}

function v2Source(extra = "") {
  return `version = 2

# keep this comment
[workspace]
roots = ["."]
worktrees = "include"

[safety]
require_hash = true

[[paths]]
id = "workspace"
path = "."
policies = { read = "allow", write = "allow", delete = "deny" }
${extra}`;
}

function approvalScope(
  inputResponses?: unknown,
  capabilities: Record<string, unknown> = { elicitation: {} },
) {
  return {
    context: { mcpReq: { inputResponses }, sessionId: "config-write" },
    server: { server: { getClientCapabilities: () => capabilities } },
    tool: "config_core",
  } as never;
}

async function approveNext(operation: () => Promise<unknown>) {
  let responseKey: string | undefined;
  try {
    await withApprovalContext(approvalScope(), operation);
  } catch (error) {
    if (!(error instanceof InputRequiredSignal)) throw error;
    responseKey = Object.keys(
      (error.result as { inputRequests: Record<string, unknown> })
        .inputRequests,
    )[0];
  }
  if (!responseKey) throw new Error("Expected configuration approval");
  return withApprovalContext(
    approvalScope({
      [responseKey]: {
        action: "accept",
        content: { decision: "allow_once" },
      },
    }),
    operation,
  );
}

afterEach(async () => {
  clearConfigCache();
  await Promise.all(
    created
      .splice(0)
      .map((folder) => rm(folder, { force: true, recursive: true })),
  );
});

test("defaults enable MCP configuration tools with approval required", async () => {
  const root = await project("ast-mcp-config-write-default-");
  await writeFile(path.join(root, "ast-mcp.toml"), "version = 2\n");
  const config = await resolveConfig({
    cwd: root,
    env: { XDG_CONFIG_HOME: path.join(root, "xdg") },
  });
  expect(config.mcp.configuration).toEqual({
    enabled: true,
    requireApproval: true,
  });
  expect(config.provenance["mcp.configuration.enabled"]).toBe("default");
});

test("unknown configuration keys are rejected", async () => {
  const root = await project("ast-mcp-config-write-unknown-");
  await writeFile(
    path.join(root, "ast-mcp.toml"),
    "version = 2\n[mcp]\nunexpected = true\n",
  );
  await expect(
    resolveConfig({
      cwd: root,
      env: { XDG_CONFIG_HOME: path.join(root, "xdg") },
    }),
  ).rejects.toThrow(/unexpected|unrecognized|invalid/i);
});

test("config_core updates a section while preserving paths and comments", async () => {
  const root = await project("ast-mcp-config-write-core-");
  const file = path.join(root, "ast-mcp.toml");
  await writeFile(file, v2Source());
  const env = { XDG_CONFIG_HOME: path.join(root, "xdg") };
  await withConfig({ cwd: root, env }, async () => {
    await approveNext(() =>
      applyConfigCore({ safety: { require_hash: false } }),
    );
  });
  const source = await readFile(file, "utf8");
  expect(source).toContain("# keep this comment");
  expect(source).toContain('id = "workspace"');
  expect(source).toContain("require_hash = false");
  const config = await resolveConfig({ cwd: root, env });
  expect(config.safety.requireHash).toBeFalse();
});

test("config_paths batches add, update, and remove", async () => {
  const root = await project("ast-mcp-config-write-paths-");
  const file = path.join(root, "ast-mcp.toml");
  await writeFile(file, v2Source());
  const env = { XDG_CONFIG_HOME: path.join(root, "xdg") };
  const extra = path.join(root, "extra");
  await mkdir(extra);
  await withConfig({ cwd: root, env }, async () => {
    await approveNext(() =>
      applyConfigPaths({
        operations: [
          {
            op: "add",
            rule: {
              id: "extra",
              path: extra,
              policies: { read: "allow", write: "deny" },
            },
          },
          {
            id: "workspace",
            op: "update",
            rule: { policies: { read: "allow", write: "request" } },
          },
        ],
      }),
    );
    await approveNext(() =>
      applyConfigPaths({ operations: [{ id: "extra", op: "remove" }] }),
    );
  });
  const source = await readFile(file, "utf8");
  expect(source).not.toContain('id = "extra"');
  expect(source).toContain('write = "request"');
  await expect(
    withConfig({ cwd: root, env }, () =>
      approveNext(() =>
        applyConfigPaths({
          operations: [{ id: "missing", op: "remove" }],
        }),
      ),
    ),
  ).rejects.toMatchObject({ code: "configuration_path_missing" });
});

test("configuration tools require elicitation by default", async () => {
  const root = await project("ast-mcp-config-write-approval-");
  await writeFile(path.join(root, "ast-mcp.toml"), v2Source());
  const env = { XDG_CONFIG_HOME: path.join(root, "xdg") };
  await withConfig({ cwd: root, env }, async () => {
    await expect(
      withApprovalContext(approvalScope(undefined, {}), () =>
        applyConfigCore({ http: { port: 4001 } }),
      ),
    ).rejects.toMatchObject({ code: "approval_required" });
    await expect(
      withApprovalContext(approvalScope(), () =>
        applyConfigCore({ http: { port: 4001 } }),
      ),
    ).rejects.toBeInstanceOf(InputRequiredSignal);
  });
});

test("require_approval false skips elicitation except mcp.configuration changes", async () => {
  const root = await project("ast-mcp-config-write-skip-");
  await writeFile(
    path.join(root, "ast-mcp.toml"),
    `${v2Source()}\n[mcp.configuration]\nenabled = true\nrequire_approval = false\n`,
  );
  const env = { XDG_CONFIG_HOME: path.join(root, "xdg") };
  await withConfig({ cwd: root, env }, async () => {
    await applyConfigCore({ http: { port: 4010 } });
    await expect(
      withApprovalContext(approvalScope(), () =>
        applyConfigCore({
          mcp: { configuration: { require_approval: true } },
        }),
      ),
    ).rejects.toBeInstanceOf(InputRequiredSignal);
  });
  const config = await resolveConfig({ cwd: root, env });
  expect(config.http.port).toBe(4010);
});

test("disabled MCP configuration tools fail closed", async () => {
  const root = await project("ast-mcp-config-write-disabled-");
  await writeFile(
    path.join(root, "ast-mcp.toml"),
    `${v2Source()}\n[mcp.configuration]\nenabled = false\n`,
  );
  const env = { XDG_CONFIG_HOME: path.join(root, "xdg") };
  await withConfig({ cwd: root, env }, async () => {
    await expect(
      applyConfigCore({ safety: { require_hash: false } }),
    ).rejects.toMatchObject({ code: "configuration_mcp_disabled" });
  });
});

test("configuration writes reload without restarting the registry", async () => {
  const root = await project("ast-mcp-config-write-reload-");
  await writeFile(path.join(root, "ast-mcp.toml"), v2Source());
  const env = { XDG_CONFIG_HOME: path.join(root, "xdg") };
  const options = { cwd: root, env };
  const initial = await configRegistry.snapshot(options);
  const result = await withConfig(options, async () =>
    approveNext(() => applyConfigCore({ http: { port: 4321 } })),
  );
  const reloaded = await configRegistry.snapshot(options);
  expect(reloaded.generation).toBeGreaterThan(initial.generation);
  expect(result).toMatchObject({
    generation: reloaded.generation,
    healthy: true,
  });
  expect(reloaded.config?.http.port).toBe(4321);
});

test("version 1 configuration cannot be edited through MCP tools", async () => {
  const root = await project("ast-mcp-config-write-v1-");
  await writeFile(path.join(root, "ast-mcp.toml"), "version = 1\n");
  const env = { XDG_CONFIG_HOME: path.join(root, "xdg") };
  await withConfig({ cwd: root, env }, async () => {
    await expect(applyConfigCore({ http: { port: 9 } })).rejects.toMatchObject({
      code: "configuration_migration_required",
    });
  });
});

test("rejects empty core patches, duplicate path ids, and invalid TOML writes", async () => {
  const root = await project("ast-mcp-config-write-errors-");
  const file = path.join(root, "ast-mcp.toml");
  await writeFile(file, v2Source());
  const env = { XDG_CONFIG_HOME: path.join(root, "xdg") };
  await withConfig({ cwd: root, env }, async () => {
    await expect(applyConfigCore({})).rejects.toMatchObject({
      code: "configuration_empty_patch",
    });
    await expect(
      approveNext(() =>
        applyConfigPaths({
          operations: [
            {
              op: "add",
              rule: {
                id: "workspace",
                path: ".",
                policies: { read: "allow", write: "allow" },
              },
            },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: "configuration_path_duplicate" });
    await approveNext(() =>
      applyConfigPaths({
        operations: [
          {
            id: "workspace",
            op: "update",
            rule: { includes: ["src/**"] },
          },
        ],
      }),
    );
  });
  expect(await readFile(file, "utf8")).toContain('includes = ["src/**"]');
});

test("deep merges mcp.configuration across global and project layers", async () => {
  const root = await project("ast-mcp-config-write-mcp-merge-");
  const globalHome = path.join(root, "xdg");
  const globalFile = path.join(globalHome, "ast-mcp", "ast-mcp.toml");
  await mkdir(path.dirname(globalFile), { recursive: true });
  await writeFile(
    globalFile,
    "version = 2\n[mcp.configuration]\nenabled = false\n",
  );
  await writeFile(
    path.join(root, "ast-mcp.toml"),
    "version = 2\n[mcp.configuration]\nrequire_approval = false\n",
  );
  const config = await resolveConfig({
    cwd: root,
    env: { XDG_CONFIG_HOME: globalHome },
  });
  expect(config.mcp.configuration).toEqual({
    enabled: false,
    requireApproval: false,
  });
  expect(config.provenance).toMatchObject({
    "mcp.configuration.enabled": "global",
    "mcp.configuration.require_approval": "project",
  });
});

test("config_core updates grouped workspace, files, and formatting keys", async () => {
  const root = await project("ast-mcp-config-write-grouped-");
  const file = path.join(root, "ast-mcp.toml");
  await writeFile(file, v2Source());
  const env = { XDG_CONFIG_HOME: path.join(root, "xdg") };
  await withConfig({ cwd: root, env }, async () => {
    await approveNext(() =>
      applyConfigCore({
        dependencies: { ast_bro_binary: "/tmp/ast-bro" },
        files: {
          patch: { strategies: ["ast"] },
          read: { modes: ["ast"] },
        },
        formatting: { enabled: false, fallback: "reject" },
        safety: { hook: { enabled: false } },
        workspace: { worktrees: "request" },
      }),
    );
  });
  const source = await readFile(file, "utf8");
  expect(source).toContain('worktrees = "request"');
  expect(source).toContain('strategies = ["ast"]');
  expect(source).toContain('modes = ["ast"]');
  expect(source).toContain('fallback = "reject"');
  expect(source).toContain('ast_bro_binary = "/tmp/ast-bro"');
});

test("missing configuration files and invalid writes fail closed", async () => {
  const root = await project("ast-mcp-config-write-invalid-");
  const env = { XDG_CONFIG_HOME: path.join(root, "xdg") };
  await withConfig({ cwd: root, env }, async () => {
    await expect(
      applyConfigCore({ http: { port: 9 }, target: "global" }),
    ).rejects.toMatchObject({ code: "configuration_missing" });
  });
  expect(() =>
    validateConfigSource("version = 2\n[[[", path.join(root, "broken.toml")),
  ).toThrow(/invalid TOML/i);
  expect(() =>
    validateConfigSource(
      "version = 2\n[http]\nport = 0\n",
      path.join(root, "broken.toml"),
    ),
  ).toThrow(/invalid configuration/i);
  const file = path.join(root, "ast-mcp.toml");
  await writeFile(file, v2Source());
  await expect(
    writeConfigSource(file, "version = 2\n[http]\nport = 0\n"),
  ).rejects.toMatchObject({ code: "configuration_invalid" });
});

test("config_paths writes follow_symlinks, excludes, and quoted ids", async () => {
  const root = await project("ast-mcp-config-write-path-keys-");
  const file = path.join(root, "ast-mcp.toml");
  await writeFile(
    file,
    v2Source().replace('id = "workspace"', "id = 'workspace'"),
  );
  const env = { XDG_CONFIG_HOME: path.join(root, "xdg") };
  await withConfig({ cwd: root, env }, async () => {
    await approveNext(() =>
      applyConfigPaths({
        operations: [
          {
            id: "workspace",
            op: "update",
            rule: { excludes: [".git/**"], follow_symlinks: true },
          },
        ],
      }),
    );
  });
  const source = await readFile(file, "utf8");
  expect(source).toContain("follow_symlinks = true");
  expect(source).toContain('excludes = [".git/**"]');
});

test("config_paths merges partial policy updates", async () => {
  const root = await project("ast-mcp-config-write-policy-merge-");
  const file = path.join(root, "ast-mcp.toml");
  await writeFile(file, v2Source());
  const env = { XDG_CONFIG_HOME: path.join(root, "xdg") };
  await withConfig({ cwd: root, env }, async () => {
    await approveNext(() =>
      applyConfigPaths({
        operations: [
          {
            id: "workspace",
            op: "update",
            rule: { policies: { write: "request" } },
          },
        ],
      }),
    );
  });
  const source = await readFile(file, "utf8");
  expect(source).toContain('read = "allow"');
  expect(source).toContain('write = "request"');
  expect(source).toContain('delete = "deny"');
});

test("parses escaped quoted path ids and mixed policy scalars", () => {
  const source = `[[paths]]
id = "work\\"tree"
path = "."
policies = { read = "al\\"low", write = 'request', delete = deny }
`;
  expect(pathTableIds(source)).toEqual(['work"tree']);
  expect(existingPathPolicies(source, 'work"tree')).toEqual({
    delete: "deny",
    read: 'al"low',
    write: "request",
  });
});
