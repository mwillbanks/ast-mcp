import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { clearConfigCache } from "../src/config";
import { currentWorkspace } from "../src/intelligence/workspace/context";
import { configuredExecution } from "../src/tools/configured";

const folders: string[] = [];
afterEach(async () => {
  clearConfigCache();
  await Promise.all(
    folders.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function executor(roots?: string[]) {
  return configuredExecution({
    server: {
      getClientCapabilities: () => (roots === undefined ? {} : { roots: {} }),
      listRoots: async () => ({
        roots: roots?.map((root) => ({ uri: pathToFileURL(root).href })) ?? [],
      }),
      setNotificationHandler: () => {},
    },
  } as never);
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-revision-guard-"));
  folders.push(root);
  await mkdir(path.join(root, ".git"));
  await writeFile(
    path.join(root, "ast-mcp.toml"),
    "version = 2\n[formatting]\nenabled = false\n",
  );
  return root;
}

test("explicit revisions cannot fall through to unscoped working-tree callbacks", async () => {
  for (const roots of [undefined, []]) {
    const execute = executor(roots);
    for (const revision of [
      { kind: "working" },
      { kind: "index" },
      { kind: "commit", oid: "a".repeat(40) },
      { kind: "branch", name: "main" },
      { kind: "tag", name: "v1" },
    ]) {
      for (const tool of ["file_read", "file_hash", "file_patch", "map"]) {
        let called = false;
        await expect(
          execute(
            { revision, filePath: "/unselected/value.ts" },
            async () => {
              called = true;
            },
            undefined,
            tool,
          ),
        ).rejects.toMatchObject({
          code: "workspace_required",
          retryable: true,
          suggestedNextCall: "workspace_open",
        });
        expect(called).toBe(false);
      }
    }
  }
});

test("unscoped requests without revisions retain their fallback", async () => {
  expect(
    await executor()(
      {},
      async () => currentWorkspace(),
      undefined,
      "file_hash",
    ),
  ).toBeUndefined();
});

test("a single advertised root retains explicit working-revision selection", async () => {
  const root = await fixture();
  const execute = executor([root]);
  const workspace = await execute(
    { revision: { kind: "working" } },
    async () => currentWorkspace(),
    undefined,
    "file_hash",
  );
  expect(workspace?.selectedRevision.selector).toEqual({ kind: "working" });
  expect(workspace?.checkoutRoot).toBe(
    await import("node:fs/promises").then(({ realpath }) => realpath(root)),
  );
});

test("multiple advertised roots retain ambiguity before operation dispatch", async () => {
  const roots = await Promise.all([fixture(), fixture()]);
  let called = false;
  await expect(
    executor(roots)(
      { revision: { kind: "working" } },
      async () => {
        called = true;
      },
      undefined,
      "file_hash",
    ),
  ).rejects.toMatchObject({ code: "workspace_ambiguous" });
  expect(called).toBe(false);
});
