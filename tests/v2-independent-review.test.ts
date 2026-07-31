import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { clearConfigCache, resolveConfig, withConfig } from "../src/config";
import { patchFiles, writeFilesSafely } from "../src/patch/engine";
import { sha256 } from "../src/runtime/hash";
import {
  assertReadableTree,
  evaluatePolicyForCheck,
} from "../src/runtime/path-policy";
import { primaryRoot } from "../src/runtime/paths";
import registerLifecycleTools from "../src/tools/lifecycle";

const roots: string[] = [];

async function workspace(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  await mkdir(path.join(root, ".git"));
  await writeFile(
    path.join(root, "ast-mcp.toml"),
    [
      "version = 2",
      "[formatting]",
      "enabled = false",
      'fallback = "preserve"',
      "[[paths]]",
      'id = "workspace"',
      'path = "."',
      'policies = { read = "allow", write = "allow", delete = "allow" }',
      "",
    ].join("\n"),
  );
  return root;
}

afterEach(async () => {
  clearConfigCache();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

test("AST execution root follows the project selected by an absolute request", async () => {
  const first = await workspace("ast-mcp-review-root-a-");
  const second = await workspace("ast-mcp-review-root-b-");
  await withConfig(
    {
      clientRoots: [first, second],
      cwd: os.tmpdir(),
      env: { XDG_CONFIG_HOME: path.join(first, "xdg") },
      requestPaths: [path.join(second, "src/value.ts")],
    },
    async () => {
      expect(await primaryRoot()).toBe(await realpath(second));
    },
  );
});

test("explicit workspace roots anchor AST execution and policy checks", async () => {
  const root = await workspace("ast-mcp-review-workspace-root-");
  const nested = path.join(root, "packages/foo");
  await mkdir(nested, { recursive: true });
  await writeFile(
    path.join(root, "ast-mcp.toml"),
    [
      "version = 2",
      "[workspace]",
      'roots = ["./packages/foo"]',
      "[[paths]]",
      'id = "workspace"',
      'path = "."',
      'policies = { read = "allow", write = "allow", delete = "allow" }',
      "",
    ].join("\n"),
  );
  const options = {
    cwd: root,
    env: { XDG_CONFIG_HOME: path.join(root, "xdg") },
  };
  const config = await resolveConfig(options);
  await withConfig(options, async () => {
    expect(await primaryRoot()).toBe(await realpath(nested));
  });
  expect(
    await evaluatePolicyForCheck(config, "src/value.ts", "read"),
  ).toMatchObject({
    canonicalPath: path.join(await realpath(nested), "src/value.ts"),
    policy: "allow",
  });
});

test("recursive reads require complete selector coverage outside the baseline", async () => {
  const root = await workspace("ast-mcp-review-selector-root-");
  const external = await workspace("ast-mcp-review-selector-external-");
  const canonicalExternal = await realpath(external);
  await mkdir(path.join(external, "allowed"));
  const globalHome = path.join(root, "xdg");
  await mkdir(path.join(globalHome, "ast-mcp"), { recursive: true });
  await writeFile(
    path.join(globalHome, "ast-mcp/ast-mcp.toml"),
    [
      "version = 2",
      "[[paths]]",
      'id = "partial-external"',
      `path = ${JSON.stringify(canonicalExternal)}`,
      'policies = { read = "allow", write = "deny", delete = "deny" }',
      'includes = ["allowed/**"]',
      'excludes = ["secret/**"]',
      "",
    ].join("\n"),
  );
  const config = await resolveConfig({
    cwd: root,
    env: { XDG_CONFIG_HOME: globalHome },
  });
  expect(() => assertReadableTree(config, canonicalExternal)).toThrow(
    /not fully covered/,
  );
  expect(() =>
    assertReadableTree(config, path.join(canonicalExternal, "allowed")),
  ).not.toThrow();
});

test("recursive read preflight honors exclusions that cover a subtree", async () => {
  const root = await workspace("ast-mcp-review-exclusion-");
  await writeFile(
    path.join(root, "ast-mcp.toml"),
    [
      "version = 2",
      "[[paths]]",
      'id = "excluded-deny"',
      'path = "."',
      'policies = { read = "deny", write = "deny" }',
      'includes = ["excluded/**"]',
      'excludes = ["excluded/**"]',
      "",
    ].join("\n"),
  );
  const config = await resolveConfig({
    cwd: root,
    env: { XDG_CONFIG_HOME: path.join(root, "xdg") },
  });
  expect(() =>
    assertReadableTree(config, path.join(root, "excluded")),
  ).not.toThrow();
});

test("patch and write batches preflight all hashes before the first commit", async () => {
  const root = await workspace("ast-mcp-review-batch-");
  const first = path.join(root, "first.txt");
  const second = path.join(root, "second.txt");
  await writeFile(first, "first-before\n");
  await writeFile(second, "second-before\n");
  const options = {
    cwd: root,
    env: { XDG_CONFIG_HOME: path.join(root, "xdg") },
  };

  await expect(
    withConfig(options, () =>
      patchFiles({
        [first]: {
          aiderBlocks: [{ replace: "first-after", search: "first-before" }],
          expectedSha256: sha256("first-before\n"),
          patchStrategy: "aider_block",
        },
        [second]: {
          aiderBlocks: [{ replace: "second-after", search: "second-before" }],
          expectedSha256: "0".repeat(64),
          patchStrategy: "aider_block",
        },
      }),
    ),
  ).rejects.toThrow("Stale file context");
  expect(await readFile(first, "utf8")).toBe("first-before\n");

  await expect(
    withConfig(options, () =>
      writeFilesSafely({
        [first]: {
          content: "first-written\n",
          expectedSha256: sha256("first-before\n"),
        },
        [second]: {
          content: "second-written\n",
          expectedSha256: "0".repeat(64),
        },
      }),
    ),
  ).rejects.toThrow("Stale file context");
  expect(await readFile(first, "utf8")).toBe("first-before\n");
});

test("file_chattr validates the complete batch before changing metadata", async () => {
  const root = await workspace("ast-mcp-review-chattr-");
  const first = path.join(root, "first.txt");
  const second = path.join(root, "second.txt");
  await writeFile(first, "first\n");
  await writeFile(second, "second\n");
  await chmod(first, 0o640);
  const handlers = new Map<
    string,
    (args: Record<string, unknown>) => Promise<{
      isError?: boolean;
      structuredContent?: Record<string, unknown>;
    }>
  >();
  const server = {
    registerTool(
      name: string,
      _definition: unknown,
      handler: (args: Record<string, unknown>) => Promise<never>,
    ) {
      handlers.set(name, handler);
    },
  };
  const execute = async <T>(
    _args: unknown,
    operation: () => Promise<T>,
  ): Promise<T> =>
    withConfig(
      {
        cwd: root,
        env: { XDG_CONFIG_HOME: path.join(root, "xdg") },
      },
      operation,
    );
  registerLifecycleTools(server as never, execute as never);
  const result = await (
    handlers.get("file_chattr") as NonNullable<ReturnType<typeof handlers.get>>
  )({
    files: {
      [first]: {
        chattr: { chmod: 0o600 },
        expectedSha256: sha256("first\n"),
      },
      [second]: {
        chattr: { chmod: 0o600 },
        expectedSha256: "0".repeat(64),
      },
    },
  });
  expect(result.isError).toBeTrue();
  expect((await stat(first)).mode & 0o777).toBe(0o640);
});
