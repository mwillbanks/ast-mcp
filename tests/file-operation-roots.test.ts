import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { currentConfig, withConfig, withResolvedConfig } from "../src/config";
import {
  WorkspaceRegistry,
  withWorkspaceContext,
} from "../src/intelligence/workspace";
import { fileOperationRootForPath, rootForPath } from "../src/runtime/paths";
import { hermeticConfig } from "./support/hermetic-config";

test("external cleanup roots honor filesystem mode without widening intelligence roots", async () => {
  const parent = await mkdtemp(
    path.join(os.tmpdir(), "ast-mcp-cleanup-roots-"),
  );
  const project = path.join(parent, "project");
  const external = path.join(parent, "external");
  try {
    await mkdir(path.join(project, ".git"), { recursive: true });
    await mkdir(external);
    await writeFile(
      path.join(project, "ast-mcp.toml"),
      'version = 2\n[safety]\nfilesystem = "restricted"\n',
    );
    const outside = path.join(await realpath(external), "value.txt");
    await withConfig(hermeticConfig(project), async () => {
      const config = await currentConfig();
      const registry = new WorkspaceRegistry();
      const workspace = await registry.open({
        directory: project,
        configurationGeneration: config.generation,
      });
      await withWorkspaceContext(workspace, async () => {
        expect(
          await fileOperationRootForPath(
            path.join(workspace.checkoutRoot, "inside.txt"),
          ),
        ).toBe(workspace.checkoutRoot);
        await expect(fileOperationRootForPath(outside)).rejects.toMatchObject({
          code: "workspace_mismatch",
        });
        await withResolvedConfig(
          {
            ...config,
            safety: { ...config.safety, filesystem: "unrestricted" },
          },
          async () => {
            expect(await fileOperationRootForPath(outside)).toBe(
              path.dirname(outside),
            );
            await expect(rootForPath(outside)).rejects.toMatchObject({
              code: "workspace_mismatch",
            });
          },
        );
      });
      await expect(fileOperationRootForPath(outside)).rejects.toThrow(
        "outside configured file-operation roots",
      );
      await withResolvedConfig(
        { ...config, safety: { ...config.safety, allowAnyPath: true } },
        async () => {
          expect(await fileOperationRootForPath(outside)).toBe(
            path.dirname(outside),
          );
        },
      );
    });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
