function run(command: string[]): string {
  const result = Bun.spawnSync(command, { stderr: "pipe", stdout: "pipe" });
  const stderr = result.stderr.toString().trim();
  if (result.exitCode !== 0)
    throw new Error(
      `${command.join(" ")} failed with exit code ${result.exitCode}${stderr ? `: ${stderr}` : ""}`,
    );
  return result.stdout.toString().trim();
}

// Quality gates use Bun's native formatter and TypeScript checker.
const manifest = await Bun.file(
  new URL("../../package.json", import.meta.url),
).json();
const expected = manifest.packageManager.replace(/^bun@/, "");
if (Bun.version !== expected)
  throw new Error(
    `Repository tooling requires Bun ${expected}; running ${Bun.version}`,
  );
run([process.execPath, "fmt", "--help"]);
run([process.execPath, "check", "--help"]);
