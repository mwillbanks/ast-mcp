import { chmod, copyFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const require = createRequire(import.meta.url);
const platform = `${process.platform}-${process.arch}`;
const executable = (name: string) =>
  process.platform === "win32" ? `${name}.exe` : name;
const nativeDirectory = path.join(root, "dist/native", platform);

const astBroPackage = path.dirname(
  require.resolve("@ast-bro/cli/package.json"),
);
const astBroInstaller = require(path.join(astBroPackage, "bin/install.js")) as {
  downloadBinary: () => string;
};
const astBroSource =
  process.env.AST_BRO_BINARY ?? astBroInstaller.downloadBinary();

const dprintPackage = path.dirname(require.resolve("dprint/package.json"));
const dprintSource = path.join(dprintPackage, executable("dprint"));

await mkdir(nativeDirectory, { recursive: true });
for (const [name, source] of [
  ["ast-bro", astBroSource],
  ["dprint", dprintSource],
] as const) {
  const destination = path.join(nativeDirectory, executable(name));
  await copyFile(source, destination);
  if (process.platform !== "win32") await chmod(destination, 0o755);
}

const result = await Bun.build({
  entrypoints: process.argv
    .slice(2)
    .map((entrypoint) => path.resolve(root, entrypoint)),
  format: "esm",
  minify: true,
  outdir: path.join(root, "dist"),
  sourcemap: "external",
  target: "bun",
});
if (!result.success)
  throw new AggregateError(result.logs, "Distribution build failed");
