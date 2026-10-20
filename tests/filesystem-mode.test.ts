import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  clearConfigCache,
  globalConfigPath,
  resolveConfig,
  withConfig,
  withResolvedConfig,
} from "../src/config";
import { configRegistry } from "../src/config-registry";
import { toolFailure } from "../src/helpers/mcp-schema";
import { withWorkspaceContext } from "../src/intelligence/workspace/context";
import { WorkspaceRegistry } from "../src/intelligence/workspace/registry";
import { applyAiderBlock } from "../src/patch/aider";
import { patchFiles, writeFileSafely } from "../src/patch/engine";
import {
  clearSessionApprovals,
  InputRequiredSignal,
  withApprovalContext,
} from "../src/runtime/approval";
import { applyConfigCore } from "../src/runtime/config-write";
import { deleteFilesSafely } from "../src/runtime/file-delete";
import { renameFilesSafely } from "../src/runtime/file-rename";
import { sha256 } from "../src/runtime/hash";
import {
  assertReadableTree,
  evaluatePolicy,
  evaluatePolicyForCheck,
} from "../src/runtime/path-policy";
import {
  intelligenceRoot,
  resolveWorkspacePath,
  resolveWritablePath,
  rootForPath,
} from "../src/runtime/paths";
import registerNativeCodeIntelligenceTools from "../src/tools/code-intelligence";
import { configuredExecution } from "../src/tools/configured";
import { hermeticConfig } from "./support/hermetic-config";

test("configured file tools retain advertised intelligence roots while accessing external files", async () => {
  const { root, external } = await fixture(
    '[safety]\nfilesystem = "unrestricted"\n',
  );
  const server = {
    server: {
      getClientCapabilities: () => ({ roots: {}, elicitation: {} }),
      listRoots: async () => ({
        roots: [{ uri: new URL("file://" + root).href }],
      }),
      setNotificationHandler: () => {},
    },
  };
  const execute = configuredExecution(server as never);
  const workspace = await execute.openWorkspace?.({ directory: root });
  const file = path.join(external, "value.txt");
  const context = (inputResponses?: unknown) =>
    ({ sessionId: "configured-files", mcpReq: { inputResponses } }) as never;
  const operation = (inputResponses?: unknown) =>
    execute(
      { workspaceId: workspace?.workspaceId, filePath: file },
      () => resolveWorkspacePath(file),
      context(inputResponses),
      "file_read",
    );
  let responseKey = "";
  try {
    await operation();
  } catch (error) {
    if (!(error instanceof InputRequiredSignal)) throw error;
    responseKey = Object.keys(
      (error.result as { inputRequests: Record<string, unknown> })
        .inputRequests,
    )[0];
  }
  expect(responseKey).not.toBe("");
  expect(
    await operation({
      [responseKey]: {
        action: "accept",
        content: { decision: "allow_session" },
      },
    }),
  ).toBe(path.join(await realpath(external), "value.txt"));
  expect(
    await execute(
      { filePath: file },
      () => resolveWorkspacePath(file),
      context(),
      "file_read",
    ),
  ).toBe(path.join(await realpath(external), "value.txt"));
  await expect(
    execute(
      { workspaceId: workspace?.workspaceId, paths: [file] },
      () => intelligenceRoot([file]),
      context(),
      "map",
    ),
  ).rejects.toMatchObject({ code: "workspace_mismatch" });
});

test("policy checking project unrestricted access reports approval without requesting input", async () => {
  const { external, options } = await fixture(
    '[safety]\nfilesystem = "unrestricted"\n',
  );
  const config = await resolveConfig(options);
  expect(
    await evaluatePolicyForCheck(
      config,
      path.join(external, "value.txt"),
      "write",
    ),
  ).toMatchObject({ policy: "request", source: "project" });
});

test("unrestricted file access does not expand explicit intelligence paths without client roots", async () => {
  const { root, external, options } = await fixture(
    '[safety]\nfilesystem = "unrestricted"\n',
    true,
  );
  const source = path.join(external, "outside.ts");
  const before = "export const outside = 1;\n";
  await writeFile(source, before);
  const names = ["AST_MCP_PROJECT_ROOT", "XDG_CONFIG_HOME", "APPDATA"] as const;
  const previous = Object.fromEntries(
    names.map((name) => [name, process.env[name]]),
  );
  process.env.AST_MCP_PROJECT_ROOT = root;
  process.env.XDG_CONFIG_HOME = options.env?.XDG_CONFIG_HOME;
  process.env.APPDATA = options.env?.APPDATA;
  const handlers = new Map<
    string,
    (input: Record<string, unknown>, context: unknown) => Promise<unknown>
  >();
  const server = {
    registerTool: (
      name: string,
      _definition: unknown,
      handler: (
        input: Record<string, unknown>,
        context: unknown,
      ) => Promise<unknown>,
    ) => handlers.set(name, handler),
    server: {
      getClientCapabilities: () => ({}),
      setNotificationHandler: () => {},
    },
  };
  const context = { sessionId: "no-roots", mcpReq: {} } as never;
  try {
    clearConfigCache();
    const execute = configuredExecution(server as never);
    registerNativeCodeIntelligenceTools(server as never, execute);
    const result = await handlers.get("map")?.({ paths: [source] }, context);
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "path_denied" }, ok: false },
    });
    expect(
      await execute(
        { filePath: source },
        () => resolveWorkspacePath(source),
        context,
        "file_read",
      ),
    ).toBe(await realpath(source));
    await execute(
      { files: { [source]: {} } },
      () =>
        patchFiles({
          [source]: {
            expectedSha256: sha256(before),
            patchStrategy: "aider_block",
            aiderBlocks: [{ search: "outside = 1", replace: "outside = 2" }],
          },
        }),
      context,
      "file_patch",
    );
    expect(await readFile(source, "utf8")).toBe("export const outside = 2;\n");
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
    clearConfigCache();
  }
});

const folders: string[] = [];
afterEach(async () => {
  clearConfigCache();
  clearSessionApprovals();
  await Promise.all(
    folders
      .splice(0)
      .map((folder) => rm(folder, { recursive: true, force: true })),
  );
});

async function fixture(extra = "", global = false) {
  const base = await mkdtemp(
    path.join(os.tmpdir(), "ast-mcp-filesystem-contract-"),
  );
  folders.push(base);
  const root = path.join(base, "project");
  const external = path.join(base, "external");
  await mkdir(path.join(root, ".git"), { recursive: true });
  await mkdir(external);
  const options = hermeticConfig(root);
  const source = "version = 2\n[formatting]\nenabled = false\n" + extra;
  if (global) {
    const file = globalConfigPath(options);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, source);
    await writeFile(path.join(root, "ast-mcp.toml"), "version = 2\n");
  } else await writeFile(path.join(root, "ast-mcp.toml"), source);
  return { base, external, options, root };
}

test("global unrestricted mode bypasses denials and symlinks while intelligence remains scoped", async () => {
  const { external, options, root } = await fixture(
    '[safety]\nfilesystem = "unrestricted"\n[[paths]]\nid = "deny"\npath = "."\npolicies = {read = "deny", write = "deny"}\n',
    true,
  );
  const file = path.join(external, "value.txt");
  await writeFile(file, "before");
  const workspace = {
    checkoutRoot: await realpath(root),
    writeEligibility: { eligible: true },
  } as never;
  await withConfig(options, () =>
    withWorkspaceContext(workspace, async () => {
      expect(await resolveWritablePath(file)).toBe(await realpath(file));
      expect(await resolveWorkspacePath(file)).toBe(await realpath(file));
      await expect(
        writeFileSafely({ filePath: file, content: "after" }),
      ).rejects.toMatchObject({ code: "missing_hash" });
      await writeFileSafely({
        filePath: file,
        content: "after",
        expectedSha256: sha256("before"),
      });
      expect(await readFile(file, "utf8")).toBe("after");
      await expect(intelligenceRoot([file])).rejects.toMatchObject({
        code: "workspace_mismatch",
      });
      if (process.platform !== "win32") {
        const link = path.join(root, "link.txt");
        await symlink(file, link);
        expect(await resolveWritablePath(link)).toBe(await realpath(file));
      }
    }),
  );
});

test("external file mutations preserve selected workspace routing and hash guards", async () => {
  for (const unrestricted of [false, true]) {
    const { external, options, root } = await fixture();
    const globalFile = globalConfigPath(options);
    await mkdir(path.dirname(globalFile), { recursive: true });
    await writeFile(
      globalFile,
      unrestricted
        ? 'version = 2\n[safety]\nfilesystem = "unrestricted"\n'
        : 'version = 2\n[[paths]]\nid = "external"\npath = ' +
            JSON.stringify(external) +
            '\npolicies = {read = "allow", write = "allow", delete = "allow"}\n',
    );
    const workspace = await new WorkspaceRegistry().open({
      configurationGeneration: 1,
      directory: root,
      storage: { kind: "explicit", path: path.join(root, ".test-index") },
    });
    const source = path.join(external, "source.txt");
    const destination = path.join(external, "destination.txt");
    await writeFile(source, "guarded");
    await withConfig(options, () =>
      withWorkspaceContext(workspace, async () => {
        await expect(rootForPath(source)).rejects.toMatchObject({
          code: "workspace_mismatch",
        });
        await expect(
          renameFilesSafely({
            [source]: { destination, expectedSha256: sha256("stale") },
          }),
        ).rejects.toThrow();
        expect(await readFile(source, "utf8")).toBe("guarded");
        await renameFilesSafely({
          [source]: { destination, expectedSha256: sha256("guarded") },
        });
        expect(await readFile(destination, "utf8")).toBe("guarded");
        await expect(
          deleteFilesSafely({
            [destination]: { expectedSha256: sha256("stale") },
          }),
        ).rejects.toThrow();
        expect(await readFile(destination, "utf8")).toBe("guarded");
        await deleteFilesSafely({
          [destination]: { expectedSha256: sha256("guarded") },
        });
        expect(await Bun.file(destination).exists()).toBe(false);
        expect(await Bun.file(globalFile).exists()).toBe(true);
        await expect(rootForPath(destination)).rejects.toMatchObject({
          code: "workspace_mismatch",
        });
      }),
    );
  }
});

test("restricted selected workspace honors user-global external path rules", async () => {
  const { external, options, root } = await fixture();
  const globalFile = globalConfigPath(options);
  await mkdir(path.dirname(globalFile), { recursive: true });
  await writeFile(
    globalFile,
    'version = 2\n[[paths]]\nid = "external"\npath = ' +
      JSON.stringify(external) +
      '\npolicies = {read = "allow", write = "allow"}\n',
  );
  await withConfig(options, () =>
    withWorkspaceContext(
      { checkoutRoot: root, writeEligibility: { eligible: true } } as never,
      async () => {
        expect(await resolveWritablePath(path.join(external, "new.txt"))).toBe(
          path.join(await realpath(external), "new.txt"),
        );
      },
    ),
  );
});

test("project unrestricted activation is session bound and safety changes revoke it", async () => {
  const { external, options } = await fixture(
    '[safety]\nfilesystem = "unrestricted"\n',
  );
  const config = await resolveConfig(options);
  const file = path.join(external, "new.txt");
  await expect(
    withResolvedConfig(config, () => resolveWritablePath(file)),
  ).rejects.toMatchObject({ code: "approval_required" });
  const server = {
    server: { getClientCapabilities: () => ({ elicitation: {} }) },
  };
  const scope = (tool: string, sessionId = "a", inputResponses?: unknown) =>
    ({
      server,
      tool,
      context: { sessionId, mcpReq: { inputResponses } },
    }) as never;
  let challenge: InputRequiredSignal | undefined;
  try {
    await withResolvedConfig(config, () =>
      withApprovalContext(scope("file_write"), () => resolveWritablePath(file)),
    );
  } catch (error) {
    expect(error).toBeInstanceOf(InputRequiredSignal);
    challenge = error as InputRequiredSignal;
  }
  const key = Object.keys(
    (challenge?.result as { inputRequests: Record<string, unknown> })
      .inputRequests,
  )[0];
  await withResolvedConfig(config, () =>
    withApprovalContext(
      scope("file_write", "a", {
        [key]: { action: "accept", content: { decision: "allow_session" } },
      }),
      () => resolveWritablePath(file),
    ),
  );
  await withResolvedConfig(config, () =>
    withApprovalContext(scope("file_read"), async () => {
      expect(await resolveWorkspacePath(file)).toBe(
        path.join(await realpath(external), "new.txt"),
      );
    }),
  );
  await expect(
    withResolvedConfig(config, () =>
      withApprovalContext(scope("file_read", "b"), () =>
        resolveWorkspacePath(file),
      ),
    ),
  ).rejects.toBeInstanceOf(InputRequiredSignal);
  const changed = {
    ...config,
    safety: { ...config.safety, requireHash: false },
  };
  await expect(
    withResolvedConfig(changed, () =>
      withApprovalContext(scope("file_read"), () => resolveWorkspacePath(file)),
    ),
  ).rejects.toBeInstanceOf(InputRequiredSignal);
});

test("unrestricted cannot mutate immutable revisions or expand recursive intelligence policy", async () => {
  const { external, options, root } = await fixture(
    '[safety]\nfilesystem = "unrestricted"\n',
    true,
  );
  const config = await resolveConfig(options);
  expect(() =>
    evaluatePolicy(config, path.join(external, "value"), "write"),
  ).not.toThrow();
  expect(() => assertReadableTree(config, external)).toThrow();
  await expect(
    withResolvedConfig(config, () =>
      withWorkspaceContext(
        { checkoutRoot: root, writeEligibility: { eligible: false } } as never,
        () => resolveWritablePath(path.join(external, "value")),
      ),
    ),
  ).rejects.toMatchObject({ code: "workspace_read_only" });
});

test("typed failures distinguish OS permissions, source conflicts, and unsafe encodings", async () => {
  expect(
    toolFailure(Object.assign(new Error("denied"), { code: "EACCES" })),
  ).toMatchObject({
    structuredContent: {
      error: { code: "permission_denied", details: { osCode: "EACCES" } },
    },
  });
  expect(
    toolFailure(Object.assign(new Error("missing"), { code: "ENOENT" })),
  ).toMatchObject({ structuredContent: { error: { code: "file_not_found" } } });
  const { root, options } = await fixture();
  const file = path.join(root, "value.txt");
  await writeFile(file, Buffer.from([0xff, 0xfe]));
  await expect(
    withConfig(options, () =>
      patchFiles({
        [file]: {
          expectedSha256: sha256(Buffer.from([0xff, 0xfe])),
          patchStrategy: "aider_block",
          aiderBlocks: [{ search: "before", replace: "after" }],
        },
      }),
    ),
  ).rejects.toMatchObject({ code: "invalid_text_encoding" });
  expect(await readFile(file)).toEqual(Buffer.from([0xff, 0xfe]));
});

test("relative indentation counts unique full matches and reports genuine ambiguity", () => {
  const result = applyAiderBlock(
    "  one()\n  two()\n  one()\n  other()",
    "    one()\n    two()",
    "changed()",
  );
  expect(result.method).toBe("relative-indentation");
  expect(result.content).toBe("changed()\n  one()\n  other()");
  expect(() =>
    applyAiderBlock(
      "  one()\n  two()\n  one()\n  two()",
      "    one()\n    two()",
      "changed()",
    ),
  ).toThrow("ambiguous");
});

test("config_core replaces formatter array tables and preserves following sections", async () => {
  const { root, options } = await fixture(
    '[mcp.configuration]\nrequire_approval = false\n[[formatting.formatters]]\nid = "old"\ncommand = "old"\nextensions = [".ts"]\n[http]\nport = 4000\n',
  );
  await withConfig(options, () =>
    applyConfigCore({
      formatting: {
        formatters: [
          { id: "new", command: "new", enabled: false, extensions: [".ts"] },
        ],
      },
    }),
  );
  const config = await resolveConfig(options);
  expect(config.formatting.formatters).toMatchObject([
    { id: "new", command: "new", enabled: false },
  ]);
  expect(config.http.port).toBe(4000);
  expect(await readFile(path.join(root, "ast-mcp.toml"), "utf8")).not.toContain(
    "[[formatting.formatters]]",
  );
});

test("config_core activation approval is reusable across tools", async () => {
  const { external, options } = await fixture();
  const server = {
    server: { getClientCapabilities: () => ({ elicitation: {} }) },
  };
  const scope = (tool: string, inputResponses?: unknown) =>
    ({
      server,
      tool,
      context: { sessionId: "config-activation", mcpReq: { inputResponses } },
    }) as never;
  const operation = async () =>
    withResolvedConfig(await configRegistry.get(options), () =>
      applyConfigCore({ safety: { filesystem: "unrestricted" } }),
    );
  let responseKey = "";
  try {
    await withApprovalContext(scope("config_core"), operation);
  } catch (error) {
    if (!(error instanceof InputRequiredSignal)) throw error;
    responseKey = Object.keys(
      (error.result as { inputRequests: Record<string, unknown> })
        .inputRequests,
    )[0];
  }
  expect(responseKey).not.toBe("");
  await withApprovalContext(
    scope("config_core", {
      [responseKey]: { action: "accept", content: { decision: "allow_once" } },
    }),
    operation,
  );
  const config = await resolveConfig(options);
  await withResolvedConfig(config, () =>
    withApprovalContext(scope("file_read"), async () => {
      expect(await resolveWorkspacePath(path.join(external, "value.txt"))).toBe(
        path.join(await realpath(external), "value.txt"),
      );
    }),
  );
});

test("receipt errors distinguish configuration changes and stale source bytes", async () => {
  const { root, options } = await fixture();
  const file = path.join(root, "value.txt");
  await writeFile(file, "before");
  const config = await resolveConfig(options);
  await withResolvedConfig(config, async () => {
    const results = await patchFiles({
      [file]: {
        patchStrategy: "aider_block",
        expectedSha256: sha256("before"),
        aiderBlocks: [{ search: "before", replace: "after" }],
        preview: true,
      },
    });
    const receipt = (
      results.files as Record<string, { previewReceipt: string }>
    )[file].previewReceipt;
    await expect(
      withResolvedConfig({ ...config, generation: config.generation + 1 }, () =>
        patchFiles({
          [file]: { expectedSha256: sha256("before"), previewReceipt: receipt },
        }),
      ),
    ).rejects.toMatchObject({ code: "preview_receipt_configuration_changed" });
    await writeFile(file, "concurrent");
    await expect(
      patchFiles({
        [file]: { expectedSha256: sha256("before"), previewReceipt: receipt },
      }),
    ).rejects.toMatchObject({ code: "stale_hash" });
    expect(await readFile(file, "utf8")).toBe("concurrent");
    await expect(
      patchFiles({
        [file]: {
          expectedSha256: sha256("concurrent"),
          previewReceipt: "missing",
        },
      }),
    ).rejects.toMatchObject({ code: "preview_receipt_unknown" });
  });
});

test("UTF-8 BOM hashes preserve raw bytes through patches", async () => {
  const { root, options } = await fixture();
  const file = path.join(root, "value.txt");
  const before = "\uFEFFbefore";
  await writeFile(file, before);
  await withConfig(options, () =>
    patchFiles({
      [file]: {
        expectedSha256: sha256(before),
        patchStrategy: "aider_block",
        aiderBlocks: [{ search: "before", replace: "after" }],
      },
    }),
  );
  expect(await readFile(file, "utf8")).toBe("\uFEFFafter");
});
