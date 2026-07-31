import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { configRequestPaths, withResolvedConfig } from "../config";
import { configRegistry } from "../config-registry";
import { withApprovalContext } from "../runtime/approval";

export interface ConfiguredExecution {
  refreshRoots?(): void;
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

export function configuredExecution(server: McpServer): ConfiguredExecution {
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
    const config = await configRegistry.get({
      clientRoots: await clientRoots(),
      requestPaths: configRequestPaths(args),
    });
    return withResolvedConfig(config, () =>
      withApprovalContext({ context, server: server, tool }, operation),
    );
  };
  execute.refreshRoots = () => {
    rootsPromise = undefined;
  };
  server.server.setNotificationHandler("notifications/roots/list_changed", () =>
    execute.refreshRoots?.(),
  );
  return execute;
}
