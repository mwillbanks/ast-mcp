const AST_BRO_VERSION = "4.2.0";
const GRAPHIFY_DISTRIBUTION = "graphifyy";
const GRAPHIFY_EXECUTABLE = "graphify";
const GRAPHIFY_VERSION = "0.9.53";

export function astBroProvisionCommand(
  platform: NodeJS.Platform,
  arch: string,
): string[] {
  if (platform === "darwin" && arch === "arm64")
    return ["bun", "add", "--global", `@ast-bro/cli@${AST_BRO_VERSION}`];
  return [
    "cargo",
    "install",
    "ast-bro",
    "--version",
    AST_BRO_VERSION,
    "--locked",
    "--force",
  ];
}

export function graphifyProvisionCommand(python: string): string[] {
  return [
    python,
    "-m",
    "pip",
    "install",
    "--disable-pip-version-check",
    `${GRAPHIFY_DISTRIBUTION}==${GRAPHIFY_VERSION}`,
  ];
}

export type ComparatorCommandRunner = (command: string[]) => Promise<string>;

export interface ComparatorProvisionDependencies {
  findExecutable?: (name: string) => string | null;
  run?: ComparatorCommandRunner;
}

export async function runComparatorCommand(command: string[]): Promise<string> {
  const child = Bun.spawn(command, {
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  if (exitCode !== 0)
    throw new Error(
      `${command.join(" ")} failed with exit ${exitCode}: ${stderr.trim()}`,
    );
  return stdout.trim();
}

export async function provisionIntelligenceComparators(
  platform: NodeJS.Platform = process.platform,
  arch = process.arch,
  dependencies: ComparatorProvisionDependencies = {},
): Promise<{ astBro: string; graphify: string }> {
  if (platform !== "darwin" && platform !== "linux" && platform !== "win32")
    throw new Error(`Unsupported comparator platform: ${platform}-${arch}`);
  const findExecutable = dependencies.findExecutable ?? Bun.which;
  const python = findExecutable("python") ?? findExecutable("python3");
  if (!python) throw new Error("Python is required to provision graphify");
  const run = dependencies.run ?? runComparatorCommand;

  await run(astBroProvisionCommand(platform, arch));
  await run(graphifyProvisionCommand(python));

  const astBro = await run(["ast-bro", "--version"]);
  if (astBro !== `ast-bro ${AST_BRO_VERSION}`)
    throw new Error(
      `Expected ast-bro ${AST_BRO_VERSION}, received ${astBro || "<empty>"}`,
    );
  const graphify = await run([GRAPHIFY_EXECUTABLE, "--version"]);
  if (graphify !== `graphify ${GRAPHIFY_VERSION}`)
    throw new Error(
      `Expected graphify ${GRAPHIFY_VERSION}, received ${graphify || "<empty>"}`,
    );
  return { astBro, graphify };
}
