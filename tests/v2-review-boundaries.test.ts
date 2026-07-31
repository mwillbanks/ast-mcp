import { afterEach, expect, test } from "bun:test";
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
import { currentConfig, withConfig } from "../src/config";
import { migrateConfigSource } from "../src/config-migrate";
import { ConfigRegistry } from "../src/config-registry";
import { patchFile } from "../src/patch/engine";
import {
  authorizeRequestedDecision,
  clearSessionApprovals,
  InputRequiredSignal,
  withApprovalContext,
} from "../src/runtime/approval";
import { deleteFilesSafely } from "../src/runtime/file-delete";
import { sha256File } from "../src/runtime/hash";
import { assertReadableTree, evaluatePolicy } from "../src/runtime/path-policy";
import { assertSingleProjectRoot } from "../src/runtime/paths";
import registerConfigurationTools from "../src/tools/configuration";
import type { ConfiguredExecution } from "../src/tools/configured";

const temporaryRoots: string[] = [];

afterEach(async () => {
  clearSessionApprovals();
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true })),
  );
});

async function temporaryRoot(prefix: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(root);
  await mkdir(path.join(root, ".git"));
  return root;
}

function isolatedEnvironment(root: string): NodeJS.ProcessEnv {
  return { XDG_CONFIG_HOME: path.join(root, ".xdg") };
}

type ToolResult = {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
};
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

function fakeServer() {
  const handlers = new Map<string, ToolHandler>();
  return {
    handlers,
    server: {
      registerTool(name: string, _definition: unknown, handler: ToolHandler) {
        handlers.set(name, handler);
      },
      server: {
        getClientCapabilities: () => ({ roots: {} }),
        listRoots: async () => ({ roots: [] }),
      },
    },
  };
}

test("legacy AST_MCP_ROOTS registry keys follow the matched project root", async () => {
  const container = await temporaryRoot("ast-mcp-registry-legacy-");
  const first = path.join(container, "first");
  const second = path.join(container, "second");
  await Promise.all([
    mkdir(path.join(first, ".git"), { recursive: true }),
    mkdir(path.join(second, ".git"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      path.join(first, "ast-mcp.toml"),
      "version = 2\n[http]\nport = 4201\n",
    ),
    writeFile(
      path.join(second, "ast-mcp.toml"),
      "version = 2\n[http]\nport = 4202\n",
    ),
  ]);
  const registry = new ConfigRegistry(5, 20);
  const env = {
    AST_MCP_ROOTS: [first, second].join(path.delimiter),
    XDG_CONFIG_HOME: path.join(container, ".xdg"),
  };
  try {
    expect(
      (await registry.get({ cwd: container, env, requestPaths: [first] })).http
        .port,
    ).toBe(4201);
    expect(
      (await registry.get({ cwd: container, env, requestPaths: [second] })).http
        .port,
    ).toBe(4202);
  } finally {
    registry.close();
  }
});

test("global migration does not invent a workspace rooted at the config directory", async () => {
  const root = await temporaryRoot("ast-mcp-global-migration-");
  const preview = migrateConfigSource(
    "[safety]\nallow_temp_directory = false\n",
    path.join(root, "config", "ast-mcp.toml"),
  );
  expect(preview.source).not.toContain("legacy-workspace");
  expect(preview.source).not.toContain(
    `path = ${JSON.stringify(path.join(root, "config"))}`,
  );
});

test("recursive AST reads fail before scanning a denied descendant", async () => {
  const root = await temporaryRoot("ast-mcp-ast-policy-");
  const denied = path.join(root, "private");
  await mkdir(denied);
  await writeFile(
    path.join(root, "ast-mcp.toml"),
    `version = 2\n[[paths]]\nid = "workspace"\npath = "."\npolicies = { read = "allow", write = "allow" }\n[[paths]]\nid = "private"\npath = ${JSON.stringify(denied)}\npolicies = { read = "deny", write = "deny" }\n`,
  );
  const options = {
    cwd: root,
    env: isolatedEnvironment(root),
    requestPaths: [root],
  };
  const canonicalRoot = await realpath(root);
  const canonicalDenied = await realpath(denied);
  await expect(
    withConfig(options, async () => {
      const config = await currentConfig();
      expect(
        config.paths?.map((rule) => [rule.id, rule.path, rule.policies.read]),
      ).toEqual([
        ["workspace", canonicalRoot, "allow"],
        ["private", canonicalDenied, "deny"],
      ]);
      expect(evaluatePolicy(config, canonicalDenied, "read").policy).toBe(
        "deny",
      );
      assertReadableTree(config, canonicalRoot);
    }),
  ).rejects.toMatchObject({ code: "path_denied" });
});

test("delete reference scans require recursive read authorization", async () => {
  const root = await temporaryRoot("ast-mcp-delete-policy-");
  const target = path.join(root, "target.ts");
  await writeFile(target, "export const value = 1;\n");
  await writeFile(
    path.join(root, "ast-mcp.toml"),
    'version = 2\n[[paths]]\nid = "workspace"\npath = "."\npolicies = { read = "deny", write = "allow", delete = "allow" }\n',
  );
  await expect(
    withConfig(
      { cwd: root, env: isolatedEnvironment(root), requestPaths: [target] },
      () =>
        deleteFilesSafely({
          [target]: {
            expectedSha256: sha256File(target),
            forceReferences: true,
          },
        } as never),
    ),
  ).rejects.toMatchObject({ code: "path_denied" });
  expect(await readFile(target, "utf8")).toContain("value");
});

test("direct patchFile calls cannot bypass path policy resolution", async () => {
  const root = await temporaryRoot("ast-mcp-direct-patch-");
  const external = await temporaryRoot("ast-mcp-direct-patch-external-");
  const target = path.join(external, "target.txt");
  await writeFile(target, "before\n");
  await writeFile(
    path.join(root, "ast-mcp.toml"),
    `version = 2\n[[paths]]\nid = "workspace"\npath = "."\npolicies = { read = "allow", write = "allow" }\n[[paths]]\nid = "external"\npath = ${JSON.stringify(target)}\npolicies = { read = "deny", write = "deny" }\n`,
  );
  await expect(
    withConfig(
      { cwd: root, env: isolatedEnvironment(root), requestPaths: [target] },
      () =>
        patchFile({
          aiderBlock: { replace: "after", search: "before" },
          expectedSha256: undefined,
          filePath: target,
          patchStrategy: "aider_block",
        }),
    ),
  ).rejects.toMatchObject({ code: "path_denied" });
  expect(await readFile(target, "utf8")).toBe("before\n");
});

test("ambiguous TOML and YAML keys omit guessed source coordinates", async () => {
  const root = await temporaryRoot("ast-mcp-document-locations-");
  const options = {
    cwd: root,
    env: isolatedEnvironment(root),
    requestPaths: [root],
  };
  const execute: ConfiguredExecution = async (_args, operation) =>
    withConfig(options, operation);
  const { handlers, server } = fakeServer();
  registerConfigurationTools(server as never, execute);
  const documents = [
    ["data.toml", "[first]\nvalue = 4\n[second]\nvalue = 5\n", "/second/value"],
    ["data.yaml", "first:\n  value: 4\nsecond:\n  value: 5\n", "/second/value"],
  ] as const;
  for (const [name, source, selector] of documents) {
    const filePath = path.join(root, name);
    await writeFile(filePath, source);
    const result = await (handlers.get("document_query") as ToolHandler)({
      filePath,
      selectors: [selector],
    });
    expect(result.isError).not.toBeTrue();
    const values = (
      result.structuredContent as {
        data: { values: Array<{ location: Record<string, unknown> }> };
      }
    ).data.values;
    expect(values[0]?.location).toEqual({ selector });
  }
});

test("configuration invalidations serialize monotonically", async () => {
  const root = await temporaryRoot("ast-mcp-registry-serialize-");
  await writeFile(path.join(root, "ast-mcp.toml"), "version = 2\n");
  const registry = new ConfigRegistry(5, 20);
  const options = { cwd: root, env: isolatedEnvironment(root) };
  try {
    const initial = await registry.snapshot(options);
    registry.invalidate();
    registry.invalidate();
    const reloaded = await registry.snapshot(options);
    expect(reloaded.generation).toBe(initial.generation + 2);
    expect(reloaded.healthy).toBeTrue();
  } finally {
    registry.close();
  }
});

test("file deletion preflights every removable ancestor", async () => {
  const root = await temporaryRoot("ast-mcp-delete-ancestors-");
  const blocked = path.join(root, "blocked");
  const child = path.join(blocked, "child");
  const target = path.join(child, "target.ts");
  await mkdir(child, { recursive: true });
  await writeFile(target, "export const value = 1;\n");
  await writeFile(
    path.join(root, "ast-mcp.toml"),
    `version = 2\n[[paths]]\nid = "workspace"\npath = "."\npolicies = { read = "allow", write = "allow", delete = "allow" }\n[[paths]]\nid = "blocked"\npath = ${JSON.stringify(blocked)}\npolicies = { read = "allow", write = "deny", delete = "deny" }\n[[paths]]\nid = "leaf"\npath = ${JSON.stringify(target)}\npolicies = { read = "allow", write = "allow", delete = "allow" }\n`,
  );
  const expectedSha256 = await sha256File(target);
  await expect(
    withConfig(
      { cwd: root, env: isolatedEnvironment(root), requestPaths: [target] },
      () =>
        deleteFilesSafely({
          [target]: { expectedSha256, forceReferences: true },
        }),
    ),
  ).rejects.toMatchObject({ code: "path_denied" });
  expect(await readFile(target, "utf8")).toContain("value");
});

test("approval challenges are bounded per MCP session", async () => {
  clearSessionApprovals();
  const root = await temporaryRoot("ast-mcp-approval-limit-");
  const scope = {
    context: { mcpReq: {}, sessionId: "bounded-session" },
    server: { server: { getClientCapabilities: () => ({ elicitation: {} }) } },
    tool: "file_write",
  } as never;
  await withApprovalContext(scope, async () => {
    const request = (index: number) => {
      try {
        authorizeRequestedDecision(
          {
            canonicalPath: path.join(root, `${index}.txt`),
            operation: "write",
            policy: "request",
            reason: "bounded challenge test",
            ruleId: "bounded",
            source: "project",
            specificity: 1,
            symlinks: false,
          },
          1,
        );
      } catch (error) {
        return error;
      }
      return undefined;
    };
    for (let index = 0; index < 64; index += 1)
      expect(request(index)).toBeInstanceOf(InputRequiredSignal);
    expect(request(64)).toMatchObject({
      code: "approval_challenge_limit",
      retryable: true,
    });
  });
});

test("document_query rejects non-regular sources", async () => {
  const root = await temporaryRoot("ast-mcp-document-regular-");
  const options = {
    cwd: root,
    env: isolatedEnvironment(root),
    requestPaths: [root],
  };
  const execute: ConfiguredExecution = async (_args, operation) =>
    withConfig(options, operation);
  const { handlers, server } = fakeServer();
  registerConfigurationTools(server as never, execute);
  const result = await (handlers.get("document_query") as ToolHandler)({
    filePath: root,
    selectors: [""],
  });
  expect(result).toMatchObject({
    isError: true,
    structuredContent: {
      error: { code: "document_not_regular" },
      ok: false,
    },
  });
});

test("AST intelligence rejects requests spanning project roots", async () => {
  const first = await temporaryRoot("ast-mcp-ast-root-a-");
  const second = await temporaryRoot("ast-mcp-ast-root-b-");
  const canonicalFirst = await realpath(first);
  const canonicalSecond = await realpath(second);
  const sharedConfig = `version = 2\n[[paths]]\nid = "first"\npath = ${JSON.stringify(canonicalFirst)}\npolicies = { read = "allow", write = "allow" }\n[[paths]]\nid = "second"\npath = ${JSON.stringify(canonicalSecond)}\npolicies = { read = "allow", write = "allow" }\n`;
  await Promise.all([
    writeFile(path.join(first, "ast-mcp.toml"), sharedConfig),
    writeFile(path.join(second, "ast-mcp.toml"), sharedConfig),
  ]);
  await expect(
    withConfig(
      {
        clientRoots: [canonicalFirst, canonicalSecond],
        cwd: canonicalFirst,
        env: isolatedEnvironment(canonicalFirst),
        requestPaths: [canonicalFirst, canonicalSecond],
      },
      () => assertSingleProjectRoot([canonicalFirst, canonicalSecond]),
    ),
  ).rejects.toMatchObject({
    code: "cross_root_ast_request",
    retryable: true,
  });
});
