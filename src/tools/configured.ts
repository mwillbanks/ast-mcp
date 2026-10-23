import path from "node:path";

import type { McpServer, ServerContext } from "@modelcontextprotocol/server";

import { configRequestPaths, withResolvedConfig } from "../config";
import { configRegistry } from "../config/registry";
import type {
  RevisionSelector,
  StoragePlacement,
} from "../intelligence/contracts/index.ts";
import type { GenerationDependencies } from "../intelligence/generation/index.ts";
import { withWorkspaceGitContext } from "../intelligence/workspace/git.ts";
import {
  currentWorkspace,
  type WorkspaceHandle,
  WorkspaceRegistry,
  withWorkspaceContext,
} from "../intelligence/workspace/index.ts";
import { withApprovalContext } from "../runtime/approval";
import { assertReadableTree } from "../runtime/path-policy";
import { canonicalPathWithin } from "../runtime/path-utils";
import type { Telemetry } from "../runtime/telemetry";

export interface OpenConfiguredWorkspace {
  directory: string;
  revision?: RevisionSelector;
  storage?: StoragePlacement;
}

export interface ConfiguredExecution {
  clientRoots?(context?: ServerContext): Promise<string[]>;
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
    operation: (signal?: AbortSignal) => Promise<T>,
    context?: ServerContext,
    tool?: string,
  ): Promise<T>;
}

function requestSignal(context?: ServerContext): AbortSignal | undefined {
  return (
    context?.mcpReq?.signal ??
    (context as { signal?: AbortSignal } | undefined)?.signal
  );
}

export const localExecution: ConfiguredExecution = async (
  args,
  operation,
  context,
) =>
  withWorkspaceGitContext({ signal: requestSignal(context) }, async () =>
    withResolvedConfig(
      await configRegistry.get({ requestPaths: configRequestPaths(args) }),
      () => {
        requestSignal(context)?.throwIfAborted();
        return operation(requestSignal(context));
      },
    ),
  );

async function configuredWorkspace(
  registry: WorkspaceRegistry,
  input: OpenConfiguredWorkspace,
  clientRoots: string[],
  approval: {
    context?: ServerContext;
    server: McpServer;
    tool: string;
    requestScoped?: boolean;
  },
  fileOperation = false,
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
  if (!fileOperation)
    await withResolvedConfig(config, () =>
      withApprovalContext(approval, async () => {
        assertReadableTree(config, input.directory);
      }),
    );
  let workspace = await registry.open({
    configurationGeneration: config.generation,
    directory: input.directory,
    revision: input.revision,
    storage: input.storage ?? config.intelligence.storage.placement,
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
      storage: input.storage ?? config.intelligence.storage.placement,
    });
  await registry.get(workspace.workspaceId, {
    configurationGeneration: config.generation,
    revisionId: workspace.selectedRevision.revisionId,
    storageDomainId: workspace.storageDomain.domainId,
  });
  return { config, workspace };
}

function fileSelectionPaths(roots: string[], requestPaths: string[]): string[] {
  const directories = roots.map((root) =>
    root.startsWith("file:") ? Bun.fileURLToPath(new URL(root)) : root,
  );
  return requestPaths.filter(
    (request) =>
      !path.isAbsolute(request) ||
      directories.some((root) => canonicalPathWithin(root, request)),
  );
}

function isFileOperation(tool: string): boolean {
  return (
    tool.startsWith("file_") ||
    tool === "document_query" ||
    tool === "policy_check"
  );
}

export interface ExecutionOptions {
  clientRootsTimeoutMs?: number;
  workspaceRegistry?: WorkspaceRegistry;
  requestScoped?: boolean;
}

export function configuredExecution(
  server: McpServer,
  telemetry?: Telemetry,
  options: ExecutionOptions = {},
): ConfiguredExecution {
  const registry = options.workspaceRegistry ?? new WorkspaceRegistry();
  let rootsPromise: Promise<string[]> | undefined;
  const cachedClientRoots = (context?: ServerContext) => {
    // Modern MCP carries request capabilities and does not permit legacy roots RPCs.
    if (context?.mcpReq?.envelope) return Promise.resolve([]);
    if (!rootsPromise) {
      const capabilities = server.server.getClientCapabilities();
      if (!capabilities?.roots) return Promise.resolve([]);
      const timeoutMs = options.clientRootsTimeoutMs ?? 5000;
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const request = Promise.resolve().then(() =>
        server.server.listRoots(undefined, {
          signal: controller.signal,
          timeout: timeoutMs,
        }),
      );
      const pending = Promise.race([
        request.then(({ roots }) => roots.map((root) => root.uri)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            const error = Object.assign(
              new Error(
                "Client roots request timed out; check the MCP connection and retry",
              ),
              {
                code: "timeout",
                retryable: true,
                suggestedNextCall: "workspace_open",
              },
            );
            reject(error);
            controller.abort(error);
          }, timeoutMs);
          timer.unref?.();
        }),
      ]).finally(() => clearTimeout(timer));
      rootsPromise = pending;
      void pending.catch(() => {
        if (rootsPromise === pending) rootsPromise = undefined;
      });
    }
    return rootsPromise;
  };
  const clientRoots = async (context?: ServerContext): Promise<string[]> => {
    const signal = requestSignal(context);
    signal?.throwIfAborted();
    const pending = cachedClientRoots(context);
    if (!signal) return pending;
    let abort: (() => void) | undefined;
    try {
      return await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          abort = () => reject(signal.reason);
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        }),
      ]);
    } finally {
      if (abort) signal.removeEventListener("abort", abort);
    }
  };
  const executeConfigured: ConfiguredExecution = async (
    args,
    operation,
    context,
    tool = "ast-mcp",
  ) => {
    const roots = await clientRoots(context);
    const requestPaths = configRequestPaths(args);
    const request = registry.request(args);
    let workspace =
      request.workspaceId === undefined
        ? undefined
        : await registry.get(request.workspaceId);
    if (workspace) {
      if (!isFileOperation(tool))
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
      (await registry.selectDirectory(
        roots,
        isFileOperation(tool)
          ? fileSelectionPaths(roots, requestPaths)
          : requestPaths,
      ));
    if (!directory) {
      if (request.revision !== undefined)
        throw Object.assign(
          new Error("Explicit revisions require a selected workspace"),
          {
            code: "workspace_required",
            retryable: true,
            suggestedNextCall: "workspace_open",
          },
        );
      const config = await configRegistry.get({ requestPaths });
      return withResolvedConfig(config, () => {
        telemetry?.select(config);
        return withApprovalContext(
          { context, server, tool, requestScoped: options.requestScoped },
          () => operation(requestSignal(context)),
        );
      });
    }

    const opened = await configuredWorkspace(
      registry,
      {
        directory,
        revision: request.revision ?? workspace?.selectedRevision.selector,
        storage: workspace?.storageDomain.placement,
      },
      roots,
      { context, server, tool, requestScoped: options.requestScoped },
      isFileOperation(tool),
    );
    workspace = opened.workspace;
    if (!isFileOperation(tool))
      registry.validateRequestPaths(workspace, requestPaths);
    return withResolvedConfig(opened.config, () => {
      telemetry?.select(opened.config);
      return withWorkspaceContext(workspace, () =>
        withApprovalContext(
          { context, server, tool, requestScoped: options.requestScoped },
          () => operation(requestSignal(context)),
        ),
      );
    });
  };
  const execute: ConfiguredExecution = (
    args,
    operation,
    context,
    tool = "ast-mcp",
  ) =>
    withWorkspaceGitContext({ signal: requestSignal(context) }, () =>
      telemetry
        ? telemetry.run(tool, () =>
            executeConfigured(args, operation, context, tool),
          )
        : executeConfigured(args, operation, context, tool),
    );
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
  execute.openWorkspace = (input, context) => {
    const open = async () => {
      const opened = await configuredWorkspace(
        registry,
        input,
        await clientRoots(context),
        {
          context,
          server,
          tool: "workspace_open",
          requestScoped: options.requestScoped,
        },
      );
      telemetry?.select(opened.config);
      return opened.workspace;
    };
    return withWorkspaceGitContext({ signal: requestSignal(context) }, () =>
      telemetry ? telemetry.run("workspace_open", open) : open(),
    );
  };
  execute.refreshRoots = () => {
    rootsPromise = undefined;
  };
  execute.workspaceRegistry = registry;
  const workspaceStatus: NonNullable<
    ConfiguredExecution["workspaceStatus"]
  > = async (workspaceId, context) => {
    if (workspaceId)
      return executeConfigured(
        { workspaceId },
        () => registry.status(currentWorkspace()?.workspaceId),
        context,
        "workspace_status",
      );
    if (options.requestScoped) return { selected: null, workspaces: [] };
    const statuses = await Promise.all(
      registry
        .workspaceIds()
        .map((id) =>
          executeConfigured(
            { workspaceId: id },
            () => registry.status(currentWorkspace()?.workspaceId),
            context,
            "workspace_status",
          ),
        ),
    );
    if (!statuses.length)
      telemetry?.select(
        await configRegistry.get({ clientRoots: await clientRoots(context) }),
      );
    return {
      selected: null,
      workspaces: statuses.flatMap((status) => status.workspaces),
    };
  };
  execute.workspaceStatus = (workspaceId, context) =>
    withWorkspaceGitContext({ signal: requestSignal(context) }, () =>
      telemetry
        ? telemetry.run("workspace_status", () =>
            workspaceStatus(workspaceId, context),
          )
        : workspaceStatus(workspaceId, context),
    );
  server.server.setNotificationHandler("notifications/roots/list_changed", () =>
    execute.refreshRoots?.(),
  );
  return execute;
}
