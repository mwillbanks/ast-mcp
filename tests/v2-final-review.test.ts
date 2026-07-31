import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { clearConfigCache, resolveConfig, withConfig } from "../src/config";
import {
  assertReadableTree,
  evaluatePolicyForCheck,
} from "../src/runtime/path-policy";
import { primaryRoot } from "../src/runtime/paths";

const roots: string[] = [];

async function temporaryWorkspace(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  await mkdir(path.join(root, ".git"));
  return root;
}

afterEach(async () => {
  clearConfigCache();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

test("recursive reads preserve Bun glob and exclusion semantics", async () => {
  const project = await temporaryWorkspace("ast-mcp-final-project-");
  const external = await temporaryWorkspace("ast-mcp-final-external-");
  const canonicalExternal = await realpath(external);
  const globalHome = path.join(project, "xdg");
  await mkdir(path.join(globalHome, "ast-mcp"), { recursive: true });
  await writeFile(
    path.join(globalHome, "ast-mcp/ast-mcp.toml"),
    [
      "version = 2",
      "[[paths]]",
      'id = "external"',
      `path = ${JSON.stringify(canonicalExternal)}`,
      'policies = { read = "allow", write = "deny", delete = "deny" }',
      'includes = ["**/*"]',
      "[[paths]]",
      'id = "nested-deny"',
      `path = ${JSON.stringify(canonicalExternal)}`,
      'policies = { read = "deny", write = "deny", delete = "deny" }',
      'includes = ["allowed/foo*/secret/**", "{brace/deep,other}/secret/**"]',
      "[[paths]]",
      'id = "union-excluded"',
      `path = ${JSON.stringify(canonicalExternal)}`,
      'policies = { read = "deny", write = "deny", delete = "deny" }',
      'includes = ["{union-a,union-b}/**", "[cd]/**", "{partial-a,partial-b}/**", "{desc-a,desc-b}/**", "team-*/**", "[e-f]/**"]',
      'excludes = ["union-a/**", "union-b/**", "c/**", "d/**", "partial-a/**", "desc-a/private/**", "team-*/private/**", "[e-f]/private/**"]',
      "",
    ].join("\n"),
  );
  const config = await resolveConfig({
    cwd: project,
    env: { XDG_CONFIG_HOME: globalHome },
  });
  expect(() =>
    assertReadableTree(
      config,
      path.join(canonicalExternal, "allowed", "foobar"),
    ),
  ).toThrow(/nested-deny/);
  expect(() =>
    assertReadableTree(config, path.join(canonicalExternal, "brace", "deep")),
  ).toThrow(/nested-deny/);
  expect(() =>
    assertReadableTree(config, path.join(canonicalExternal, "union-a")),
  ).not.toThrow();
  expect(() =>
    assertReadableTree(config, path.join(canonicalExternal, "c")),
  ).not.toThrow();
  expect(() =>
    assertReadableTree(config, path.join(canonicalExternal, "partial-a")),
  ).not.toThrow();
  expect(() =>
    assertReadableTree(config, path.join(canonicalExternal, "partial-b")),
  ).toThrow(/union-excluded/);
  expect(() =>
    assertReadableTree(
      config,
      path.join(canonicalExternal, "desc-a", "private"),
    ),
  ).not.toThrow();
  expect(() =>
    assertReadableTree(
      config,
      path.join(canonicalExternal, "desc-a", "public"),
    ),
  ).toThrow(/union-excluded/);
  expect(() =>
    assertReadableTree(
      config,
      path.join(canonicalExternal, "team-a", "private"),
    ),
  ).not.toThrow();
  expect(() =>
    assertReadableTree(
      config,
      path.join(canonicalExternal, "team-a", "public"),
    ),
  ).toThrow(/union-excluded/);
  expect(() =>
    assertReadableTree(config, path.join(canonicalExternal, "e", "private")),
  ).not.toThrow();
});

test("disjoint configured roots remain the effective workspace", async () => {
  const project = await temporaryWorkspace("ast-mcp-final-root-project-");
  const external = await temporaryWorkspace("ast-mcp-final-root-external-");
  const canonicalExternal = await realpath(external);
  await writeFile(
    path.join(project, "ast-mcp.toml"),
    [
      "version = 2",
      "[workspace]",
      `roots = [${JSON.stringify(canonicalExternal)}]`,
      "[[paths]]",
      'id = "external"',
      `path = ${JSON.stringify(canonicalExternal)}`,
      'policies = { read = "allow", write = "request", delete = "request" }',
      "",
    ].join("\n"),
  );
  const options = {
    cwd: project,
    env: { XDG_CONFIG_HOME: path.join(project, "xdg") },
  };
  const config = await resolveConfig(options);
  await withConfig(options, async () => {
    expect(await primaryRoot()).toBe(canonicalExternal);
  });
  expect(
    await evaluatePolicyForCheck(config, "src/value.ts", "read"),
  ).toMatchObject({
    canonicalPath: path.join(canonicalExternal, "src/value.ts"),
  });
});
