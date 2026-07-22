import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

export const PACKAGE_ROOT = path.resolve(
  import.meta.dir,
  path.basename(import.meta.dir) === "dist" ? ".." : "../..",
);

const astBroWrapper = path.join(PACKAGE_ROOT, "node_modules/.bin/ast-bro");
const astBroInstaller = createRequire(import.meta.url)(
  path.join(path.dirname(realpathSync(astBroWrapper)), "install.js"),
) as { getBinaryPath: () => string };

export const AST_BRO_BINARY =
  process.env.AST_BRO_BINARY ?? astBroInstaller.getBinaryPath();

export const DPRINT_BINARY =
  process.env.DPRINT_BINARY ??
  path.join(PACKAGE_ROOT, "node_modules/.bin/dprint");
