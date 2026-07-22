function run(command: string[]): string {
  const result = Bun.spawnSync(command, { stderr: "pipe", stdout: "pipe" });
  const stderr = result.stderr.toString().trim();
  if (result.exitCode !== 0)
    throw new Error(
      `${command.join(" ")} failed with exit code ${result.exitCode}${stderr ? `: ${stderr}` : ""}`,
    );
  return result.stdout.toString().trim();
}

const {
  AST_BRO_BINARY: astBroBinary,
  AST_BRO_VERSION,
  DPRINT_BINARY: dprintBinary,
} = await import("../src/runtime/dependencies");
const astBroVersion = run([astBroBinary, "--version"]);
if (astBroVersion !== `ast-bro ${AST_BRO_VERSION}`)
  throw new Error(
    `Unexpected ast-bro version: ${astBroVersion || "no output"}`,
  );
const dprintVersion = run([dprintBinary, "--version"]);
if (dprintVersion !== "dprint 0.55.2")
  throw new Error(`Unexpected dprint version: ${dprintVersion || "no output"}`);
run([dprintBinary, "check", "README.md"]);
console.log(astBroVersion);
console.log(dprintVersion);
