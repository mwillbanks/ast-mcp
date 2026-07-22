import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const platform = `${process.platform}-${process.arch}`;
const executable = (name: string) =>
  process.platform === "win32" ? `${name}.exe` : name;

function packagedBinary(name: string): string | undefined {
  return [
    path.join(import.meta.dir, "native", platform, executable(name)),
    path.resolve(
      import.meta.dir,
      "../../dist/native",
      platform,
      executable(name),
    ),
  ].find(existsSync);
}

const astBroPackage = path.dirname(
  require.resolve("@ast-bro/cli/package.json"),
);
const astBroInstaller = require(path.join(astBroPackage, "bin/install.js")) as {
  getBinaryPath: () => string;
};

const dprintPackage = path.dirname(
  require.resolve(
    `@dprint/${process.platform === "linux" ? `linux-${process.arch}-glibc` : `${process.platform}-${process.arch}`}/package.json`,
  ),
);

export const AST_BRO_BINARY =
  process.env.AST_BRO_BINARY ??
  packagedBinary("ast-bro") ??
  astBroInstaller.getBinaryPath();

export const DPRINT_BINARY =
  process.env.DPRINT_BINARY ??
  packagedBinary("dprint") ??
  path.join(dprintPackage, executable("dprint"));
