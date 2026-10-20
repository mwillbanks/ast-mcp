function run(command: string[]): string {
  const result = Bun.spawnSync(command, { stderr: "pipe", stdout: "pipe" });
  const stderr = result.stderr.toString().trim();
  if (result.exitCode !== 0)
    throw new Error(
      `${command.join(" ")} failed with exit code ${result.exitCode}${stderr ? `: ${stderr}` : ""}`,
    );
  return result.stdout.toString().trim();
}

// Repository quality gates use installed development tools; runtime formatters are optional.
for (const tool of ["oxfmt", "oxlint"]) {
  const executable = Bun.which(tool, {
    PATH: `${import.meta.dir}/../node_modules/.bin${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
  });
  if (!executable)
    throw new Error(`Missing repository tool: ${tool}; run bun install`);
  console.log(run([executable, "--version"]));
}
