import path from "node:path";
export const consumerBun = process.env.AST_MCP_CONSUMER_BUN || process.execPath;

export function consumerEnvironment(
  inherited = process.env,
): Record<string, string> {
  const inheritedPath = Object.entries(inherited).find(
    ([key]) => key.toUpperCase() === "PATH",
  )?.[1];
  const environment = Object.fromEntries(
    Object.entries(inherited).filter(
      ([key, value]) =>
        value !== undefined &&
        key.toUpperCase() !== "PATH" &&
        !/^(?:NODE_PATH|NODE_OPTIONS|BUN_OPTIONS|BUN_INSTALL|NAPI_RS_NATIVE_LIBRARY_PATH|AST_MCP_)/i.test(
          key,
        ),
    ),
  ) as Record<string, string>;
  environment.PATH = [path.dirname(consumerBun), inheritedPath]
    .filter(Boolean)
    .join(path.delimiter);
  environment.BUN_CONFIG_NO_AUTO_INSTALL = "1";
  environment.DO_NOT_TRACK = "1";
  return environment;
}
