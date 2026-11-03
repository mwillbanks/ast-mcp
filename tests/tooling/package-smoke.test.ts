import { test as bunTest, expect } from "bun:test";
import path from "node:path";

import {
  consumerBun,
  consumerEnvironment,
} from "../support/consumer-environment";

bunTest(
  "consumer environments preserve Windows Path while removing runtime overrides",
  () => {
    const environment = consumerEnvironment({
      Path: "system-bin",
      NODE_PATH: "repository-modules",
      NODE_OPTIONS: "--require=repository-hook",
      NAPI_RS_NATIVE_LIBRARY_PATH: "native-override",
      AST_MCP_PACKAGE_ARCHIVE: "archive",
    });
    expect(environment.PATH).toBe(
      [path.dirname(consumerBun), "system-bin"].join(path.delimiter),
    );
    expect(environment.Path).toBeUndefined();
    for (const key of [
      "NODE_PATH",
      "NODE_OPTIONS",
      "NAPI_RS_NATIVE_LIBRARY_PATH",
      "AST_MCP_PACKAGE_ARCHIVE",
    ])
      expect(environment[key]).toBeUndefined();
    expect(environment.BUN_CONFIG_NO_AUTO_INSTALL).toBe("1");
  },
);
