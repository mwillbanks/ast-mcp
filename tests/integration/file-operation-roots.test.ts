import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { McpServer, ServerContext } from "@modelcontextprotocol/server";

import {
  currentConfig,
  withConfig,
  withResolvedConfig,
} from "../../src/config";
import { ConfigRegistry } from "../../src/config/registry";
import {
  WorkspaceRegistry,
  withWorkspaceContext,
} from "../../src/intelligence/workspace";
import {
  authorizeRequestedDecision,
  clearSessionApprovals,
  InputRequiredSignal,
  withApprovalContext,
} from "../../src/runtime/approval";
import { fileOperationRootForPath, rootForPath } from "../../src/runtime/paths";
import { hermeticConfig } from "../support/hermetic-config";

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

test("directory activity preserves an opened workspace and its session approval until configuration changes", async () => {
  const parent = await mkdtemp(
    path.join(os.tmpdir(), "ast-mcp-workspace-config-noise-"),
  );
  const project = path.join(parent, "project");
  const registry = new ConfigRegistry(1);
  const workspaces = new WorkspaceRegistry();
  const server = {
    server: { getClientCapabilities: () => ({ elicitation: { form: {} } }) },
  } as unknown as McpServer;
  const context = { sessionId: "directory-noise", mcpReq: {} } as ServerContext;
  const options = {
    launchCwd: parent,
    env: { CLAUDE_PROJECT_DIR: project },
    home: path.join(parent, "home"),
  };
  try {
    await mkdir(path.join(project, ".git"), { recursive: true });
    const configPath = path.join(project, "ast-mcp.toml");
    await writeFile(configPath, "version = 2\n");
    const initial = await registry.get(options);
    const workspace = await workspaces.open({
      directory: project,
      configurationGeneration: initial.generation,
      home: options.home,
      env: {},
    });
    const decision = {
      canonicalPath: path.join(workspace.checkoutRoot, "ordinary.txt"),
      operation: "write" as const,
      policy: "request" as const,
      source: "project" as const,
      reason: "test request policy",
      ruleId: "ordinary",
      specificity: 1,
      symlinks: false,
    };
    const authorize = (
      generation: number,
      inputResponses?: ServerContext["mcpReq"]["inputResponses"],
    ) =>
      withApprovalContext(
        {
          server,
          context: { ...context, mcpReq: { inputResponses } } as ServerContext,
          tool: "file_write",
        },
        async () => authorizeRequestedDecision(decision, generation),
      );
    let challenge: InputRequiredSignal | undefined;
    try {
      await authorize(initial.generation);
    } catch (error) {
      expect(error).toBeInstanceOf(InputRequiredSignal);
      challenge = error as InputRequiredSignal;
    }
    const key = Object.keys(challenge!.result.inputRequests!)[0]!;
    expect(
      await authorize(initial.generation, {
        [key]: { action: "accept", content: { decision: "allow_session" } },
      }),
    ).toBeTrue();
    const original = path.join(project, "ordinary.txt");
    const renamed = path.join(project, "renamed.txt");
    const activities = [
      () => writeFile(original, "value"),
      () => rename(original, renamed),
      () => rm(renamed),
      () => writeFile(path.join(project, ".git", "cache"), "value"),
    ];
    for (const activity of activities) {
      await activity();
      await registry.reconcile();
      await Bun.sleep(20);
      const current = await registry.get(options);
      expect(current.generation).toBe(initial.generation);
      expect(
        await workspaces.get(workspace.workspaceId, {
          configurationGeneration: current.generation,
        }),
      ).toBe(workspace);
      expect(await authorize(current.generation)).toBeTrue();
    }
    await writeFile(configPath, "version = 2\n[telemetry]\nenabled = false\n");
    await registry.reload();
    const changed = await registry.get(options);
    expect(changed.generation).toBeGreaterThan(initial.generation);
    await expect(
      workspaces.get(workspace.workspaceId, {
        configurationGeneration: changed.generation,
      }),
    ).rejects.toMatchObject({ code: "workspace_mismatch" });
    await expect(authorize(changed.generation)).rejects.toBeInstanceOf(
      InputRequiredSignal,
    );
  } finally {
    clearSessionApprovals(context.sessionId, server);
    registry.close();
    await rm(parent, { recursive: true, force: true });
  }
});
