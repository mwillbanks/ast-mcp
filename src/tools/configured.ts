import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { configRequestPaths, withResolvedConfig } from "../config";
import { configRegistry } from "../config-registry";
import type {
  RevisionSelector,
  StoragePlacement,
} from "../intelligence/contracts/index.ts";
import type { GenerationDependencies } from "../intelligence/generation/index.ts";
import {
  currentWorkspace,
  type WorkspaceHandle,
  WorkspaceRegistry,
  withWorkspaceContext,
} from "../intelligence/workspace/index.ts";
import { withApprovalContext } from "../runtime/approval";
import { assertReadableTree } from "../runtime/path-policy";

export interface OpenConfiguredWorkspace {
  directory: string;
  revision?: RevisionSelector;
  storage?: StoragePlacement;
}

export interface ConfiguredExecution {
  clientRoots?(): Promise<string[]>;
  generationDependencies?: GenerationDependencies;
  openWorkspace?(
    input: OpenConfiguredWorkspace,
    context?: ServerContext,
  ): Promise<WorkspaceHandle>;
  refreshRoots?(): void;
  workspaceRegistry?: WorkspaceRegistry;
  workspaceStatus?(
    workspaceId?: string,
    context?: ServerContext,
  ): Promise<Awaited<ReturnType<WorkspaceRegistry["status"]>>>;
  <T>(
    args: unknown,
    operation: () => Promise<T>,
    context?: ServerContext,
    tool?: string,
  ): Promise<T>;
}

export const localExecution: ConfiguredExecution = async (args, operation) =>
  withResolvedConfig(
    await configRegistry.get({ requestPaths: configRequestPaths(args) }),
    operation,
  );

async function configuredWorkspace(
  registry: WorkspaceRegistry,
  input: OpenConfiguredWorkspace,
  clientRoots: string[],
  approval: {
    context?: ServerContext;
    server: McpServer;
    tool: string;
  },
): Promise<{
  config: Awaited<ReturnType<typeof configRegistry.get>>;
  workspace: WorkspaceHandle;
}> {
  if (clientRoots.length)
    await registry.selectDirectory(clientRoots, [input.directory]);
  let config = await configRegistry.get({
    clientRoots,
    requestPaths: [input.directory],
  });
  await withResolvedConfig(config, () =>
    withApprovalContext(approval, async () => {
      assertReadableTree(config, input.directory);
    }),
  );
  let workspace = await registry.open({
    configurationGeneration: config.generation,
    directory: input.directory,
    revision: input.revision,
    storage: input.storage,
  });
  config = await configRegistry.get({
    clientRoots,
    cwd: input.directory,
    requestPaths: [input.directory],
    revisionId: workspace.selectedRevision.revisionId,
    storageDomainId: workspace.storageDomain.domainId,
    workspaceId: workspace.workspaceId,
  });
  if (config.generation !== workspace.configurationGeneration)
    workspace = await registry.open({
      configurationGeneration: config.generation,
      directory: workspace.checkoutRoot,
      revision: input.revision,
      storage: input.storage,
    });
  await registry.get(workspace.workspaceId, {
    configurationGeneration: config.generation,
    revisionId: workspace.selectedRevision.revisionId,
    storageDomainId: workspace.storageDomain.domainId,
  });
  return { config, workspace };
}

export function configuredExecution(server: McpServer): ConfiguredExecution {
  const registry = new WorkspaceRegistry();
  let rootsPromise: Promise<string[]> | undefined;
  const clientRoots = () => {
    if (!rootsPromise) {
      const capabilities = server.server.getClientCapabilities();
      rootsPromise = capabilities?.roots
        ? server.server
            .listRoots()
            .then(({ roots }) => roots.map((root) => root.uri))
        : Promise.resolve([]);
    }
    return rootsPromise;
  };
  const execute: ConfiguredExecution = async (
    args,
    operation,
    context,
    tool = "ast-mcp",
  ) => {
    const roots = await clientRoots();
    const requestPaths = configRequestPaths(args);
    const request = registry.request(args);
    let workspace =
      request.workspaceId === undefined
        ? undefined
        : await registry.get(request.workspaceId);
    if (workspace) {
      registry.validateRequestPaths(workspace, requestPaths);
      const current = await configRegistry.get({
        clientRoots: roots,
        cwd: workspace.checkoutRoot,
        requestPaths: [workspace.checkoutRoot],
        revisionId: workspace.selectedRevision.revisionId,
        storageDomainId: workspace.storageDomain.domainId,
        workspaceId: workspace.workspaceId,
      });
      workspace = await registry.get(workspace.workspaceId, {
        configurationGeneration: current.generation,
        revisionId: workspace.selectedRevision.revisionId,
        storageDomainId: workspace.storageDomain.domainId,
      });
    }
    const directory =
      workspace?.checkoutRoot ??
      (await registry.selectDirectory(roots, requestPaths));
    if (!directory) {
      const config = await configRegistry.get({ requestPaths });
      return withResolvedConfig(config, () =>
        withApprovalContext({ context, server, tool }, operation),
      );
    }

    const opened = await configuredWorkspace(
      registry,
      {
        directory,
        revision: request.revision ?? workspace?.selectedRevision.selector,
        storage: workspace?.storageDomain.placement,
      },
      roots,
      { context, server, tool },
    );
    workspace = opened.workspace;
    registry.validateRequestPaths(workspace, requestPaths);
    return withResolvedConfig(opened.config, () =>
      withWorkspaceContext(workspace, () =>
        withApprovalContext({ context, server, tool }, operation),
      ),
    );
  };
  execute.clientRoots = clientRoots;
  execute.generationDependencies = {
    mcpClients: {
      host: {
        capabilities: {
          get sampling() {
            return server.server.getClientCapabilities()?.sampling;
          },
        },
        createMessage: (request, context) =>
          server.server.createMessage(request, context),
      },
    },
  };
  execute.openWorkspace = async (input, context) =>
    (
      await configuredWorkspace(registry, input, await clientRoots(), {
        context,
        server,
        tool: "workspace_open",
      })
    ).workspace;
  execute.refreshRoots = () => {
    rootsPromise = undefined;
  };
  execute.workspaceRegistry = registry;
  execute.workspaceStatus = async (workspaceId, context) => {
    if (workspaceId)
      return execute(
        { workspaceId },
        () => registry.status(currentWorkspace()?.workspaceId),
        context,
        "workspace_status",
      );
    const statuses = await Promise.all(
      registry
        .workspaceIds()
        .map((id) =>
          execute(
            { workspaceId: id },
            () => registry.status(currentWorkspace()?.workspaceId),
            context,
            "workspace_status",
          ),
        ),
    );
    return {
      selected: null,
      workspaces: statuses.flatMap((status) => status.workspaces),
    };
  };
  server.server.setNotificationHandler("notifications/roots/list_changed", () =>
    execute.refreshRoots?.(),
  );
  return execute;
}
