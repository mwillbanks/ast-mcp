import type { McpServer } from "@modelcontextprotocol/server";
import { configRequestPaths, withConfig } from "../config";

export type ConfiguredExecution = <T>(
  args: unknown,
  operation: () => Promise<T>,
) => Promise<T>;

export const localExecution: ConfiguredExecution = (args, operation) =>
  withConfig({ requestPaths: configRequestPaths(args) }, operation);

export function configuredExecution(server: McpServer): ConfiguredExecution {
  return async (args, operation) => {
    const capabilities = server.server.getClientCapabilities();
    const clientRoots = capabilities?.roots
      ? await server.server
          .listRoots()
          .then(({ roots }) => roots.map((root) => root.uri))
      : [];
    return withConfig(
      {
        clientRoots,
        requestPaths: configRequestPaths(args),
      },
      operation,
    );
  };
}
