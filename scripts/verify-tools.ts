import { createRequire } from "node:module";
import path from "node:path";

interface AstBroInstaller {
  downloadBinary(): string;
}

const installer = createRequire(import.meta.url)(
  path.resolve(import.meta.dir, "../node_modules/@ast-bro/cli/bin/install.js"),
) as AstBroInstaller;

function run(command: string[]): string {
  const result = Bun.spawnSync(command, { stderr: "pipe", stdout: "pipe" });
  const stderr = result.stderr.toString().trim();
  if (result.exitCode !== 0)
    throw new Error(
      `${command.join(" ")} failed with exit code ${result.exitCode}${stderr ? `: ${stderr}` : ""}`,
    );
  return result.stdout.toString().trim();
}

const astBroVersion = run([installer.downloadBinary(), "--version"]);
if (astBroVersion !== "ast-bro 3.0.0")
  throw new Error(
    `Unexpected ast-bro version: ${astBroVersion || "no output"}`,
  );
const dprintVersion = run(["dprint", "--version"]);
if (dprintVersion !== "dprint 0.55.2")
  throw new Error(`Unexpected dprint version: ${dprintVersion || "no output"}`);
run(["dprint", "check", "README.md"]);
console.log(astBroVersion);
console.log(dprintVersion);
