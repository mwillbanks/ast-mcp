import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  lstat,
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
import { clearConfigCache, resolveConfig, withConfig } from "../src/config";
import { runConfigCli } from "../src/config-cli";
import {
  migrateConfigSource,
  writeMigratedConfig,
} from "../src/config-migrate";
import { ConfigRegistry, configRegistry } from "../src/config-registry";
import { patchFiles, writeFileSafely } from "../src/patch/engine";
import {
  authorizeRequestedDecision,
  clearSessionApprovals,
  InputRequiredSignal,
  withApprovalContext,
} from "../src/runtime/approval";
import { renameFilesSafely } from "../src/runtime/file-rename";
import { formatContent } from "../src/runtime/format";
import { sha256File } from "../src/runtime/hash";
import {
  assertPolicy,
  assertReadableTree,
  evaluatePolicy,
  evaluatePolicyForCheck,
  PathPolicyError,
} from "../src/runtime/path-policy";
import {
  pathsShareRoot,
  referenceRootForPath,
  resolveWorkspacePath,
} from "../src/runtime/paths";

const created: string[] = [];

async function project(prefix: string, source?: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  created.push(root);
  await mkdir(path.join(root, ".git"));
  if (source !== undefined)
    await writeFile(path.join(root, "ast-mcp.toml"), source);
  return root;
}

afterEach(async () => {
  clearConfigCache();
  clearSessionApprovals();
  await Promise.all(
    created.splice(0).map((item) => rm(item, { force: true, recursive: true })),
  );
});

test("registry keys preserve advertised root priority", async () => {
  const first = await project("ast-mcp-v2-order-a-");
  const second = await project("ast-mcp-v2-order-b-");
  await writeFile(path.join(first, "ast-mcp.toml"), "[http]\nport = 4101\n");
  await writeFile(path.join(second, "ast-mcp.toml"), "[http]\nport = 4102\n");
  const registry = new ConfigRegistry();
  try {
    const options = {
      cwd: os.tmpdir(),
      env: { XDG_CONFIG_HOME: path.join(first, "xdg") },
    };
    expect(
      (await registry.get({ ...options, clientRoots: [first, second] })).http
        .port,
    ).toBe(4101);
    expect(
      (await registry.get({ ...options, clientRoots: [second, first] })).http
        .port,
    ).toBe(4102);
    expect(
      (
        await registry.get({
          ...options,
          clientRoots: [first, second],
          cwd: second,
          requestPaths: ["relative.ts"],
        })
      ).http.port,
    ).toBe(4101);
    expect(
      (
        await registry.get({
          ...options,
          clientRoots: [first, second],
          cwd: second,
          requestPaths: [path.join(second, "absolute.ts")],
        })
      ).http.port,
    ).toBe(4102);
  } finally {
    registry.close();
  }
});

test("mixed configuration layers retain v1 compatibility without v2 temp access", async () => {
  const v1Project = await project(
    "ast-mcp-v2-mixed-project-",
    "[safety]\nallow_any_path = true\nallow_temp_directory = false\n",
  );
  const v2GlobalHome = path.join(v1Project, "global-v2");
  await mkdir(path.join(v2GlobalHome, "ast-mcp"), { recursive: true });
  await writeFile(
    path.join(v2GlobalHome, "ast-mcp/ast-mcp.toml"),
    'version = 2\n[formatting]\nfallback = "preserve"\n',
  );
  const mixedProject = await resolveConfig({
    cwd: v1Project,
    env: { XDG_CONFIG_HOME: v2GlobalHome },
  });
  expect(mixedProject.version).toBe(1);
  expect(mixedProject.safety.allowAnyPath).toBeTrue();
  expect(mixedProject.safety.allowTempDirectory).toBeFalse();

  const v2Project = await project(
    "ast-mcp-v2-mixed-global-",
    [
      "version = 2",
      "[[paths]]",
      'id = "workspace"',
      'path = "."',
      'policies = { read = "allow", write = "request" }',
      "",
    ].join("\n"),
  );
  const v1GlobalHome = path.join(v2Project, "global-v1");
  await mkdir(path.join(v1GlobalHome, "ast-mcp"), { recursive: true });
  await writeFile(
    path.join(v1GlobalHome, "ast-mcp/ast-mcp.toml"),
    "[safety]\nallow_any_path = true\n",
  );
  const mixedGlobal = await resolveConfig({
    cwd: v2Project,
    env: { XDG_CONFIG_HOME: v1GlobalHome },
  });
  expect(mixedGlobal.version).toBe(1);
  expect(mixedGlobal.safety.allowAnyPath).toBeTrue();
  expect(mixedGlobal.paths).toHaveLength(1);

  const pureV2 = await project(
    "ast-mcp-v2-no-temp-",
    'version = 2\n[formatting]\nfallback = "preserve"\n',
  );
  const v2 = await resolveConfig({
    cwd: pureV2,
    env: { XDG_CONFIG_HOME: path.join(pureV2, "xdg") },
  });
  expect(v2.version).toBe(2);
  expect(v2.safety.allowTempDirectory).toBeFalse();
});

test("approval flow fails closed and supports once, session, and persistent grants", async () => {
  const root = await project("ast-mcp-v2-approval-");
  const decision = {
    canonicalPath: path.join(await realpath(root), "value.txt"),
    operation: "write" as "delete" | "read" | "write",
    policy: "request" as const,
    reason: "test approval",
    ruleId: "test-rule",
    source: "project" as const,
    specificity: 1,
    symlinks: false,
  };
  const approvalScope = (
    inputResponses?: unknown,
    capabilities: Record<string, unknown> = { elicitation: {} },
    sessionId = "session-1",
  ) =>
    ({
      context: { mcpReq: { inputResponses }, sessionId },
      server: { server: { getClientCapabilities: () => capabilities } },
      tool: "file_write",
    }) as never;
  const challengeKey = async (
    requestedDecision: typeof decision,
    generation: number,
  ) => {
    try {
      await withApprovalContext(approvalScope(), async () =>
        authorizeRequestedDecision(requestedDecision, generation),
      );
    } catch (error) {
      if (!(error instanceof InputRequiredSignal)) throw error;
      return Object.keys(
        (error.result as { inputRequests: Record<string, unknown> })
          .inputRequests,
      )[0] as string;
    }
    throw new Error("Expected an approval challenge");
  };
  const approve = async (
    requestedDecision: typeof decision,
    generation: number,
    choice: "allow_once" | "allow_session" | "always_allow",
  ) => {
    const responseKey = await challengeKey(requestedDecision, generation);
    return withApprovalContext(
      approvalScope({
        [responseKey]: { action: "accept", content: { decision: choice } },
      }),
      async () => {
        expect(
          authorizeRequestedDecision(requestedDecision, generation),
        ).toBeTrue();
        return authorizeRequestedDecision(requestedDecision, generation);
      },
    );
  };

  await expect(
    withApprovalContext(approvalScope(undefined, {}), async () => {
      authorizeRequestedDecision(decision, 1);
    }),
  ).rejects.toMatchObject({ code: "approval_required" });
  const onceKey = await challengeKey(decision, 1);
  const onceResponses = {
    [onceKey]: {
      action: "accept",
      content: { decision: "allow_once" },
    },
  };
  expect(
    await withApprovalContext(approvalScope(onceResponses), async () => [
      authorizeRequestedDecision(decision, 1),
      authorizeRequestedDecision(decision, 1),
    ]),
  ).toEqual([true, true]);
  await expect(
    withApprovalContext(approvalScope(onceResponses), async () =>
      authorizeRequestedDecision(decision, 1),
    ),
  ).rejects.toBeInstanceOf(InputRequiredSignal);
  expect(await approve(decision, 2, "allow_session")).toBeTrue();
  expect(
    await withApprovalContext(
      approvalScope(undefined, { elicitation: {} }),
      async () => authorizeRequestedDecision(decision, 2),
    ),
  ).toBeTrue();

  const otherDecision = {
    ...decision,
    canonicalPath: path.join(root, "other.txt"),
  };
  const wrongResponseKey = await challengeKey(decision, 3);
  await expect(
    withApprovalContext(
      approvalScope({
        [wrongResponseKey]: {
          action: "accept",
          content: { decision: "allow_once" },
        },
      }),
      async () => authorizeRequestedDecision(otherDecision, 3),
    ),
  ).rejects.toBeInstanceOf(InputRequiredSignal);

  const denialKey = await challengeKey(decision, 4);
  await expect(
    withApprovalContext(
      approvalScope({
        [denialKey]: { action: "decline", content: { decision: "deny" } },
      }),
      async () => authorizeRequestedDecision(decision, 4),
    ),
  ).rejects.toMatchObject({ code: "approval_denied" });

  const previousXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = path.join(root, "global");
  const registryOptions = {
    cwd: root,
    env: { ...process.env },
  };
  await configRegistry.snapshot(registryOptions);
  try {
    expect(await approve(decision, 5, "always_allow")).toBeTrue();
    const refreshed = await configRegistry.get(registryOptions);
    expect({
      global: refreshed.sources.global,
      paths: refreshed.paths?.map((rule) => ({
        id: rule.id,
        path: rule.path,
      })),
      version: refreshed.version,
    }).toEqual({
      global: path.join(await realpath(root), "global/ast-mcp/ast-mcp.toml"),
      paths: expect.arrayContaining([
        expect.objectContaining({ path: decision.canonicalPath }),
      ]),
      version: 2,
    });
    const persisted = await readFile(
      path.join(root, "global/ast-mcp/ast-mcp.toml"),
      "utf8",
    );
    expect(persisted).toContain("version = 2");
    expect(persisted).toContain(decision.canonicalPath);
    expect(persisted).toContain('write = "allow"');
    const readDecision = { ...decision, operation: "read" as const };
    expect(await approve(readDecision, 6, "always_allow")).toBeTrue();
    const mergedApproval = await configRegistry.get(registryOptions);
    expect(
      evaluatePolicy(mergedApproval, decision.canonicalPath, "read").policy,
    ).toBe("allow");
    expect(
      evaluatePolicy(mergedApproval, decision.canonicalPath, "write").policy,
    ).toBe("allow");
    const mergedPersistentSource = await readFile(
      path.join(root, "global/ast-mcp/ast-mcp.toml"),
      "utf8",
    );
    expect(mergedPersistentSource).toContain(
      'policies = { read = "allow", write = "allow", delete = "deny" }',
    );
    const lockPath = path.join(
      root,
      "global/ast-mcp/ast-mcp.toml.approval.lock",
    );
    await writeFile(lockPath, "locked");
    const blockedDecision = {
      ...decision,
      canonicalPath: path.join(root, "blocked.txt"),
    };
    await expect(
      approve(blockedDecision, 7, "always_allow"),
    ).rejects.toMatchObject({ code: "approval_persistence_busy" });
    expect(await readFile(lockPath, "utf8")).toBe("locked");
    await rm(lockPath);
  } finally {
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
  }
});

test("preview receipts bind session, current mode, and bounded candidates", async () => {
  const root = await project(
    "ast-mcp-v2-receipt-",
    'version = 2\n[formatting]\nenabled = false\nfallback = "preserve"\n',
  );
  const file = path.join(root, "value.txt");
  await writeFile(file, "before");
  const options = {
    cwd: root,
    env: { XDG_CONFIG_HOME: path.join(root, "xdg") },
  };
  const scope = (sessionId: string) =>
    ({ context: { mcpReq: {}, sessionId }, tool: "file_patch" }) as never;
  await withConfig(options, async () => {
    const preview = await withApprovalContext(
      scope("preview-session"),
      async () =>
        patchFiles({
          [file]: {
            aiderBlocks: [{ replace: "after", search: "before" }],
            expectedSha256: await sha256File(file),
            patchStrategy: "aider_block",
            preview: true,
          },
        }),
    );
    const token = Object.values(
      preview.files as Record<string, { previewReceipt: string }>,
    )[0].previewReceipt;
    expect(await readFile(file, "utf8")).toBe("before");
    await chmod(file, 0o640);
    await expect(
      withApprovalContext(scope("other-session"), () =>
        patchFiles({ [file]: { previewReceipt: token } }),
      ),
    ).rejects.toThrow("different MCP session");
    const committed = await withApprovalContext(scope("preview-session"), () =>
      patchFiles({ [file]: { previewReceipt: token } }),
    );
    expect(
      Object.values(committed.files as Record<string, unknown>),
    ).toContainEqual(
      expect.objectContaining({
        receiptCommitted: true,
        sha256: await sha256File(file),
      }),
    );
    expect(await readFile(file, "utf8")).toBe("after");
    expect((await lstat(file)).mode & 0o777).toBe(0o640);
    await expect(
      withApprovalContext(scope("preview-session"), () =>
        patchFiles({ [file]: { previewReceipt: token } }),
      ),
    ).rejects.toThrow("unknown or has already been used");

    const oversized = path.join(root, "oversized.txt");
    await writeFile(oversized, "before");
    await expect(
      withApprovalContext(scope("preview-session"), async () =>
        patchFiles({
          [oversized]: {
            aiderBlocks: [
              {
                replace: `after${"x".repeat(4 * 1024 * 1024)}`,
                search: "before",
              },
            ],
            expectedSha256: await sha256File(oversized),
            patchStrategy: "aider_block",
            preview: true,
          },
        }),
      ),
    ).rejects.toMatchObject({
      code: "preview_receipt_limit",
      retryable: true,
    });
  });
  const identityFile = path.join(root, "identity.txt");
  await writeFile(identityFile, "before");
  await writeFile(
    path.join(root, "ast-mcp.toml"),
    'version = 2\n[formatting]\nenabled = false\nfallback = "preserve"\n',
  );
  clearConfigCache();
  const identityPreview = await withConfig(options, () =>
    withApprovalContext(scope("identity-session"), async () =>
      patchFiles({
        [identityFile]: {
          aiderBlocks: [{ replace: "after", search: "before" }],
          expectedSha256: await sha256File(identityFile),
          patchStrategy: "aider_block",
          preview: true,
        },
      }),
    ),
  );
  const identityToken = Object.values(
    identityPreview.files as Record<string, { previewReceipt: string }>,
  )[0].previewReceipt;
  await writeFile(
    path.join(root, "ast-mcp.toml"),
    'version = 2\n[formatting]\nenabled = false\nfallback = "reject"\n',
  );
  clearConfigCache();
  await expect(
    withConfig(options, () =>
      withApprovalContext(scope("identity-session"), () =>
        patchFiles({ [identityFile]: { previewReceipt: identityToken } }),
      ),
    ),
  ).rejects.toThrow("configuration changed");
  expect(await readFile(identityFile, "utf8")).toBe("before");
});

test("aider failures return structured recovery evidence", async () => {
  const root = await project(
    "ast-mcp-v2-aider-error-",
    'version = 2\n[formatting]\nenabled = false\nfallback = "preserve"\n',
  );
  const file = path.join(root, "value.txt");
  await writeFile(file, "alpha");
  await withConfig(
    { cwd: root, env: { XDG_CONFIG_HOME: path.join(root, "xdg") } },
    async () => {
      await expect(
        patchFiles({
          [file]: {
            aiderBlocks: [{ replace: "omega", search: "missing" }],
            expectedSha256: await sha256File(file),
            patchStrategy: "aider_block",
          },
        }),
      ).rejects.toMatchObject({
        code: "aider_no_match",
        details: { operation: 1, searchPreview: "missing" },
        retryable: true,
        suggestedNextCall: "file_read",
      });
    },
  );
});

test("config migrate CLI previews, checks, writes, and validates options", async () => {
  const root = await project("ast-mcp-v2-cli-");
  const file = path.join(root, "ast-mcp.toml");
  await writeFile(file, "[formatting]\nenabled = false\n");
  const output: string[] = [];
  expect(
    await runConfigCli(["migrate", `--root=${root}`], (text) =>
      output.push(text),
    ),
  ).toBe(0);
  expect(JSON.parse(output.join(""))).toMatchObject({
    changed: true,
    fromVersion: 1,
    written: false,
  });
  expect(
    await runConfigCli(["migrate", "--root", root, "--check"], () => {}),
  ).toBe(2);
  expect(
    await runConfigCli(
      ["migrate", "--file", file, "--to", "2", "--write", "--no-backup"],
      () => {},
    ),
  ).toBe(0);
  expect(await Bun.file(`${file}.v1.bak`).exists()).toBeFalse();
  expect(
    await runConfigCli(["migrate", "--file", file, "--check"], () => {}),
  ).toBe(0);
  await expect(runConfigCli(["migrate", "--to", "3"])).rejects.toThrow(
    "Only --to 2 is supported",
  );
  await expect(
    runConfigCli(["migrate", "--file", file, "--global"]),
  ).rejects.toThrow("Choose only one");
  await expect(
    runConfigCli(["migrate", "--file", file, "--check", "--write"]),
  ).rejects.toThrow("cannot be combined");
  await expect(runConfigCli(["show", "--check"])).rejects.toThrow(
    "Migration options require",
  );
});

test("migrates v1 source without discarding comments or legacy behavior", async () => {
  const root = await project("ast-mcp-v2-migrate-");
  const file = path.join(root, "ast-mcp.toml");
  const source = [
    "# keep this comment",
    "[workspace]",
    'roots = [".", "./packages/app"]',
    "",
    "[formatting]",
    "enabled = true",
    "",
    "[[formatting.formatters]]",
    'command = "formatter"',
    'extensions = [".ts"]',
    "",
    "[safety]",
    "allow_any_path = true",
    "allow_temp_directory = false",
    "follow_symlinks = true",
    "require_hash = false",
    "",
  ].join("\r\n");
  await writeFile(file, source);

  const preview = migrateConfigSource(source, file);
  expect(preview).toMatchObject({
    changed: true,
    fromVersion: 1,
    toVersion: 2,
  });
  expect(preview.source).toContain("# keep this comment\r\n");
  expect(preview.source).toContain('fallback = "dprint"');
  expect(preview.source).toContain('mode = "stdout"');
  expect(preview.source).toContain('id = "legacy-1"');
  expect(preview.source).toContain('id = "legacy-unrestricted"');
  expect(preview.source).not.toContain("allow_any_path");
  expect(preview.warnings.join(" ")).toContain("UNRESTRICTED");

  await chmod(file, 0o640);
  const backup = await writeMigratedConfig(file, preview.source);
  expect(backup).toBe(`${file}.v1.bak`);
  expect(await readFile(backup as string, "utf8")).toBe(source);
  expect((await lstat(file)).mode & 0o777).toBe(0o640);
  expect((await resolveConfig({ cwd: root, env: {} })).version).toBe(2);

  const current = migrateConfigSource(await readFile(file, "utf8"), file);
  expect(current.changed).toBeFalse();
  expect(() => migrateConfigSource("version = 99\n", file)).toThrow(
    "Unsupported ast-mcp.toml version",
  );
  expect(() => migrateConfigSource("value = [\n", file)).toThrow(
    "Invalid TOML",
  );
});

test("migration preserves inline comments on versions and table headers", () => {
  const source = [
    "version = 1 # version note",
    "[formatting] # formatting note",
    "enabled = true",
    "[[formatting.formatters]] # formatter note",
    'command = "formatter"',
    'extensions = [".ts"]',
    "",
  ].join("\n");
  const migrated = migrateConfigSource(
    source,
    "/tmp/project/ast-mcp.toml",
  ).source;
  expect(migrated).toContain("version = 2 # version note");
  expect(migrated).toContain("[formatting] # formatting note");
  expect(migrated).toContain("[[formatting.formatters]] # formatter note");
  expect(migrated.match(/^\[formatting\]/gm)).toHaveLength(1);
  expect(migrated).toContain('fallback = "dprint"');
  expect(migrated).toContain('id = "legacy-1"');
  expect(migrated).toContain("enabled = true");
  expect(migrated).toContain('mode = "stdout"');
});

test("migration restores source mode after umask-filtered staging", async () => {
  const root = await project("ast-mcp-v2-migrate-mode-");
  const file = path.join(root, "ast-mcp.toml");
  const source = "[formatting]\nenabled = false\n";
  await writeFile(file, source);
  await chmod(file, 0o666);
  const migrated = migrateConfigSource(source, file);
  const previousUmask = process.umask(0o077);
  try {
    await writeMigratedConfig(file, migrated.source, false);
  } finally {
    process.umask(previousUmask);
  }
  expect((await lstat(file)).mode & 0o777).toBe(0o666);
});

test("migrated external roots reach the v2 policy engine", async () => {
  const root = await project("ast-mcp-v2-migrate-external-");
  const external = await mkdtemp(
    path.join(os.tmpdir(), "ast-mcp-v2-external-"),
  );
  created.push(external);
  const externalFile = path.join(external, "value.txt");
  await writeFile(externalFile, "value");
  const file = path.join(root, "ast-mcp.toml");
  const source = [
    "[workspace]",
    `roots = [${JSON.stringify(external)}]`,
    "[safety]",
    "allow_external_roots = true",
    "allow_temp_directory = false",
    "",
  ].join("\n");
  const migration = migrateConfigSource(source, file);
  await writeFile(file, migration.source);
  const options = {
    cwd: root,
    env: { XDG_CONFIG_HOME: path.join(root, "xdg") },
  };
  expect((await resolveConfig(options)).workspace.roots).toContain(external);
  await expect(
    withConfig(options, () => resolveWorkspacePath(externalFile)),
  ).rejects.toMatchObject({ code: "approval_required" });
});

test("v2 formatting supports selective stdout and adjacent in-place staging", async () => {
  const root = await project("ast-mcp-v2-format-");
  const configFile = path.join(root, "ast-mcp.toml");
  const bun = process.execPath.replaceAll("\\", "\\\\");
  const stdoutScript =
    "process.stdout.write((await Bun.stdin.text()).toUpperCase())";
  const inPlaceScript =
    "const file=process.argv[1]; await Bun.write(file,(await Bun.file(file).text())+'!')";
  await writeFile(
    configFile,
    [
      "version = 2",
      "[formatting]",
      "enabled = false",
      'fallback = "preserve"',
      "[[formatting.formatters]]",
      'id = "upper"',
      "enabled = true",
      'extensions = [".txt"]',
      `command = "${bun}"`,
      `args = ["-e", ${JSON.stringify(stdoutScript)}]`,
      'mode = "stdout"',
      "[[formatting.formatters]]",
      'id = "staged"',
      "enabled = true",
      'extensions = [".md"]',
      `command = "${bun}"`,
      `args = ["-e", ${JSON.stringify(inPlaceScript)}, "{file}"]`,
      'mode = "in_place"',
      "[[formatting.formatters]]",
      'id = "failing-stage"',
      "enabled = true",
      'extensions = [".fail"]',
      `command = "${bun}"`,
      `args = ["-e", "process.exit(7)", "{file}"]`,
      'mode = "in_place"',
      "",
    ].join("\n"),
  );
  const options = {
    cwd: root,
    env: { XDG_CONFIG_HOME: path.join(root, "xdg") },
  };
  expect(
    await withConfig(options, () =>
      formatContent(path.join(root, "a.txt"), "hello"),
    ),
  ).toBe("HELLO");
  expect(
    await withConfig(options, () =>
      formatContent(path.join(root, "a.md"), "hello"),
    ),
  ).toBe("hello!");
  expect(
    await withConfig(options, () =>
      formatContent(path.join(root, "a.yaml"), "hello"),
    ),
  ).toBe("hello");

  const nested = path.join(root, "nested/missing/value.md");
  await withConfig(options, () =>
    writeFileSafely({ content: "hello", filePath: nested }),
  );
  expect(await readFile(nested, "utf8")).toBe("hello!");

  const failedParent = path.join(root, "failed/missing");
  await expect(
    withConfig(options, () =>
      writeFileSafely({
        content: "hello",
        filePath: path.join(failedParent, "value.fail"),
      }),
    ),
  ).rejects.toThrow();
  expect(await Bun.file(failedParent).exists()).toBeFalse();
  expect(
    (await Bun.$`find ${root} -name '.ast-mcp-format-*'`.text()).trim(),
  ).toBe("");
});

test("v2 policy resolves specificity, deny ties, exclusions, and protected config", async () => {
  const root = await project(
    "ast-mcp-v2-policy-",
    [
      "version = 2",
      "[safety]",
      "require_hash = true",
      "[[paths]]",
      'id = "workspace"',
      'path = "."',
      'policies = { read = "allow", write = "request" }',
      'includes = ["**/*"]',
      'excludes = ["private/**"]',
      "[[paths]]",
      'id = "source-deny"',
      'path = "src"',
      'policies = { read = "deny", write = "deny" }',
      "[[paths]]",
      'id = "source-allow-tie"',
      'path = "src"',
      'policies = { read = "allow", write = "allow" }',
      "",
    ].join("\n"),
  );
  const config = await resolveConfig({
    cwd: root,
    env: { XDG_CONFIG_HOME: path.join(root, "xdg") },
  });
  const canonicalRoot = await realpath(root);
  expect(
    evaluatePolicy(config, path.join(canonicalRoot, "src/value.ts"), "read"),
  ).toMatchObject({
    policy: "deny",
    ruleId: "source-deny",
  });
  expect(
    evaluatePolicy(config, path.join(canonicalRoot, "value.ts"), "write"),
  ).toMatchObject({
    policy: "request",
    ruleId: "workspace",
  });
  expect(
    evaluatePolicy(config, path.join(canonicalRoot, "private/key.txt"), "read")
      .policy,
  ).toBe("allow");
  expect(
    evaluatePolicy(config, path.join(canonicalRoot, "ast-mcp.toml"), "write"),
  ).toMatchObject({
    policy: "request",
    source: "configuration",
  });
  const allowedDecision = evaluatePolicy(
    config,
    path.join(canonicalRoot, "private/key.txt"),
    "read",
  );
  expect(() => assertPolicy(allowedDecision)).not.toThrow();
  const deniedDecision = evaluatePolicy(
    config,
    path.join(canonicalRoot, "src/value.ts"),
    "read",
  );
  expect(() => assertPolicy(deniedDecision)).toThrow(PathPolicyError);
  const requestedDecision = evaluatePolicy(
    config,
    path.join(canonicalRoot, "value.ts"),
    "write",
  );
  expect(() => assertPolicy(requestedDecision)).toThrow(PathPolicyError);
  expect(
    evaluatePolicy(config, path.join(os.tmpdir(), "outside-v2.txt"), "read")
      .policy,
  ).toBe("deny");
  const windowsProtected = evaluatePolicy(
    config,
    path.join(canonicalRoot, "AST-MCP.TOML"),
    "write",
    "win32",
  );
  expect(windowsProtected).toMatchObject({
    policy: "request",
    source: "configuration",
  });
});

test("policy specificity counts only include patterns matching the target", async () => {
  const root = await project(
    "ast-mcp-v2-policy-includes-",
    [
      "version = 2",
      "[[paths]]",
      'id = "broad-allow"',
      'path = "."',
      'policies = { read = "allow", write = "allow" }',
      'includes = ["**/*", "unrelated/very/specific/**"]',
      "[[paths]]",
      'id = "scoped-deny"',
      'path = "."',
      'policies = { read = "deny", write = "deny" }',
      'includes = ["special/**"]',
      "",
    ].join("\n"),
  );
  const config = await resolveConfig({
    cwd: root,
    env: { XDG_CONFIG_HOME: path.join(root, "xdg") },
  });
  expect(
    evaluatePolicy(
      config,
      path.join(await realpath(root), "special/secret.ts"),
      "read",
    ),
  ).toMatchObject({ policy: "deny", ruleId: "scoped-deny" });
  const canonicalRoot = await realpath(root);
  expect(() =>
    assertReadableTree(config, path.join(canonicalRoot, "special")),
  ).toThrow(PathPolicyError);
  expect(() => assertReadableTree(config, canonicalRoot)).toThrow(
    PathPolicyError,
  );
});

test("policy checks preserve symlink identity and deny unpermitted links", async () => {
  const root = await project(
    "ast-mcp-v2-policy-symlink-",
    [
      "version = 2",
      "[[paths]]",
      'id = "workspace"',
      'path = "."',
      'policies = { read = "allow", write = "allow" }',
      "follow_symlinks = false",
      "",
    ].join("\n"),
  );
  const target = path.join(root, "target.txt");
  const link = path.join(root, "link.txt");
  await writeFile(target, "value");
  await symlink(target, link);
  const config = await resolveConfig({
    cwd: root,
    env: { XDG_CONFIG_HOME: path.join(root, "xdg") },
  });
  expect(await evaluatePolicyForCheck(config, link, "read")).toMatchObject({
    canonicalPath: path.join(await realpath(root), "link.txt"),
    policy: "deny",
  });
});

test("v2 endpoint policies permit cross-root rename and isolate exact-file scans", async () => {
  const root = await project("ast-mcp-v2-cross-root-project-", "version = 2\n");
  const sourceRoot = await project("ast-mcp-v2-cross-root-source-");
  const destinationRoot = await project("ast-mcp-v2-cross-root-destination-");
  const exactRoot = await project("ast-mcp-v2-exact-file-");
  const source = path.join(sourceRoot, "source.txt");
  const destination = path.join(destinationRoot, "destination.txt");
  const exactFile = path.join(exactRoot, "only.ts");
  await writeFile(source, "value");
  await writeFile(exactFile, "export const value = 1;\n");
  const sourceHash = await sha256File(source);
  const xdg = path.join(root, "xdg");
  await mkdir(path.join(xdg, "ast-mcp"), { recursive: true });
  await writeFile(
    path.join(xdg, "ast-mcp/ast-mcp.toml"),
    [
      "version = 2",
      "[[paths]]",
      'id = "source"',
      `path = ${JSON.stringify(sourceRoot)}`,
      'policies = { read = "allow", write = "deny", delete = "allow" }',
      "[[paths]]",
      'id = "destination"',
      `path = ${JSON.stringify(destinationRoot)}`,
      'policies = { read = "allow", write = "allow" }',
      "[[paths]]",
      'id = "exact"',
      `path = ${JSON.stringify(exactFile)}`,
      'policies = { read = "allow", write = "allow", delete = "allow" }',
      "",
    ].join("\n"),
  );
  const options = { cwd: root, env: { XDG_CONFIG_HOME: xdg } };
  await withConfig(options, () =>
    renameFilesSafely({
      [source]: { destination, expectedSha256: sourceHash },
    }),
  );
  expect(await readFile(destination, "utf8")).toBe("value");
  expect(
    await withConfig(options, () => pathsShareRoot(source, destination)),
  ).toBeTrue();
  expect(
    await withConfig(options, () => referenceRootForPath(exactFile)),
  ).toBeUndefined();
});

test("resident registry reloads create, invalid change, recovery, and deletion", async () => {
  const root = await project("ast-mcp-v2-registry-");
  const registry = new ConfigRegistry(5, 20);
  const options = {
    cwd: root,
    env: { XDG_CONFIG_HOME: path.join(root, "xdg") },
  };
  try {
    const initial = await registry.snapshot(options);
    expect(initial).toMatchObject({ generation: 1, healthy: true });
    expect(initial.config?.version).toBe(1);
    const sameRootDifferentTarget = await registry.snapshot({
      ...options,
      requestPaths: [path.join(root, "first.txt")],
    });
    const anotherTarget = await registry.snapshot({
      ...options,
      requestPaths: [path.join(root, "second.txt")],
    });
    expect(sameRootDifferentTarget).toBe(initial);
    expect(anotherTarget).toBe(initial);

    const file = path.join(root, "ast-mcp.toml");
    await writeFile(file, 'version = 2\n[formatting]\nfallback = "preserve"\n');
    await Bun.sleep(60);
    const createdSnapshot = await registry.snapshot(options);
    expect(createdSnapshot.healthy).toBeTrue();
    expect(createdSnapshot.config?.version).toBe(2);
    expect(createdSnapshot.generation).toBeGreaterThan(initial.generation);

    await writeFile(file, "version = 2\nunknown = true\n");
    await Bun.sleep(60);
    const unhealthy = await registry.snapshot(options);
    expect(unhealthy.healthy).toBeFalse();
    expect(unhealthy.config?.version).toBe(2);
    await registry.reconcile();
    await Bun.sleep(10);
    expect((await registry.snapshot(options)).generation).toBe(
      unhealthy.generation,
    );
    await expect(registry.get(options)).rejects.toThrow("Unrecognized key");

    await writeFile(file, 'version = 2\n[formatting]\nfallback = "reject"\n');
    await Bun.sleep(60);
    expect((await registry.get(options)).formatting.fallback).toBe("reject");

    await rm(file);
    await Bun.sleep(60);
    expect((await registry.get(options)).version).toBe(1);
    await registry.reconcile();
    registry.invalidate(options);
    await Bun.sleep(20);
    expect((await registry.snapshot(options)).healthy).toBeTrue();
  } finally {
    registry.close();
  }
});
