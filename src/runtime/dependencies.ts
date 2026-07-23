import { accessSync, constants, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

export const PACKAGE_ROOT = path.resolve(
  import.meta.dir,
  path.basename(import.meta.dir) === "dist" ? ".." : "../..",
);

const require = createRequire(import.meta.url);

interface BinaryResolutionOptions {
  globalBinDirectories?: string[];
  packageBinary?: string;
  packageRoot?: string;
  pathValue?: string;
  platform?: NodeJS.Platform;
}

function executableNames(name: string, platform: NodeJS.Platform) {
  if (platform !== "win32") return [name];
  const extensions = (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
    .split(";")
    .filter(Boolean);
  return [name, ...extensions.map((extension) => `${name}${extension}`)];
}

function isExecutable(file: string, platform: NodeJS.Platform) {
  try {
    accessSync(
      file,
      platform === "win32" ? constants.F_OK : constants.F_OK | constants.X_OK,
    );
    return true;
  } catch {
    return false;
  }
}

function packageBinary(packageName: string, binaryName: string) {
  try {
    const manifestPath = require.resolve(`${packageName}/package.json`);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      bin?: string | Record<string, string>;
    };
    const relative =
      typeof manifest.bin === "string"
        ? manifest.bin
        : manifest.bin?.[binaryName];
    return relative
      ? path.resolve(path.dirname(manifestPath), relative)
      : undefined;
  } catch {
    return undefined;
  }
}

function commandOutput(command: string, args: string[]) {
  try {
    const result = Bun.spawnSync([command, ...args], {
      stderr: "ignore",
      stdout: "pipe",
    });
    return result.exitCode === 0 ? result.stdout.toString().trim() : "";
  } catch {
    return "";
  }
}

function globalBinDirectories(binaryName: string, platform: NodeJS.Platform) {
  const directories = new Set<string>();
  const add = (value: string | undefined) => {
    if (value) directories.add(path.resolve(value));
  };
  const yarnBinary = commandOutput("yarn", ["bin", binaryName]);
  if (yarnBinary) add(path.dirname(yarnBinary));
  add(process.env.BUN_INSTALL && path.join(process.env.BUN_INSTALL, "bin"));
  add(process.env.PNPM_HOME);
  add(
    process.env.npm_config_prefix &&
      (platform === "win32"
        ? process.env.npm_config_prefix
        : path.join(process.env.npm_config_prefix, "bin")),
  );
  add(path.join(os.homedir(), ".bun/bin"));
  add(path.join(os.homedir(), ".bun/install/global/node_modules/.bin"));

  add(commandOutput("bun", ["pm", "bin", "-g"]));
  add(commandOutput("pnpm", ["bin", "-g"]));
  add(commandOutput("yarn", ["global", "bin"]));
  const npmPrefix = commandOutput("npm", ["prefix", "-g"]);
  add(
    npmPrefix &&
      (platform === "win32" ? npmPrefix : path.join(npmPrefix, "bin")),
  );
  return [...directories];
}

export function resolveDependencyBinary(
  binaryName: string,
  packageName = binaryName,
  options: BinaryResolutionOptions = {},
) {
  const platform = options.platform ?? process.platform;
  const packageRoot = options.packageRoot ?? PACKAGE_ROOT;
  const names = executableNames(binaryName, platform);
  const candidates: string[] = [];

  for (
    let current = packageRoot;
    path.dirname(current) !== current;
    current = path.dirname(current)
  )
    for (const name of names)
      candidates.push(path.join(current, "node_modules/.bin", name));

  const directPackageBinary =
    options.packageBinary ?? packageBinary(packageName, binaryName);
  if (directPackageBinary) candidates.push(directPackageBinary);
  const local = candidates.find((candidate) =>
    isExecutable(candidate, platform),
  );
  if (local) return local;

  const globalDirectories =
    options.globalBinDirectories ?? globalBinDirectories(binaryName, platform);
  candidates.length = 0;
  for (const directory of globalDirectories)
    for (const name of names) candidates.push(path.join(directory, name));
  const global = candidates.find((candidate) =>
    isExecutable(candidate, platform),
  );
  if (global) return global;

  candidates.length = 0;
  for (const directory of (options.pathValue ?? process.env.PATH ?? "").split(
    path.delimiter,
  ))
    if (directory)
      for (const name of names) candidates.push(path.join(directory, name));

  return candidates.find((candidate) => isExecutable(candidate, platform));
}

export const AST_BRO_VERSION = "3.0.0";
export const AST_BRO_BINARY =
  process.env.AST_BRO_BINARY ??
  resolveDependencyBinary("ast-bro", "@ast-bro/cli") ??
  "ast-bro";

export function assertAstBroAvailable(
  binary = AST_BRO_BINARY,
  platform: NodeJS.Platform = process.platform,
  arch = process.arch,
): void {
  let version = "";
  let cause = "binary not found";
  try {
    const result = Bun.spawnSync([binary, "--version"], {
      stderr: "pipe",
      stdout: "pipe",
    });
    version = result.stdout.toString().trim();
    if (result.exitCode === 0 && version === `ast-bro ${AST_BRO_VERSION}`)
      return;
    cause = result.stderr.toString().trim() || version || cause;
  } catch (error) {
    cause = error instanceof Error ? error.message : String(error);
  }
  const environment =
    platform === "win32"
      ? `$env:AST_BRO_BINARY = "$HOME\\.cargo\\bin\\ast-bro.exe"\n[Environment]::SetEnvironmentVariable("AST_BRO_BINARY", "$HOME\\.cargo\\bin\\ast-bro.exe", "User")`
      : `export AST_BRO_BINARY="$HOME/.cargo/bin/ast-bro"\nprintf '%s\\n' 'export AST_BRO_BINARY="$HOME/.cargo/bin/ast-bro"' >> "$HOME/.profile"\n# For zsh login shells, persist the same line in "$HOME/.zprofile" instead.`;
  const packageRecovery =
    platform === "darwin" && arch === "arm64"
      ? "The npm package includes a macOS Apple Silicon binary. If Bun blocked its installer, run:\n  bun pm trust @ast-bro/cli\nThen rerun ast-mcp install."
      : `No precompiled ast-bro ${AST_BRO_VERSION} binary is published for ${platform}-${arch}. Install Rust from https://rustup.rs, then run:`;

  throw new Error(
    `ast-bro ${AST_BRO_VERSION} is required before ast-mcp can configure a host.\nResolved binary: ${binary}\nFailure: ${cause}\n\n${packageRecovery}\n  cargo install ast-bro --version ${AST_BRO_VERSION} --locked\n\nSet AST_BRO_BINARY before rerunning the installer and persist it for the host process:\n${environment}\n\nRestart the host after installation so it receives the environment variable. GUI-launched hosts must be started from that configured environment or receive AST_BRO_BINARY through their launcher.`,
  );
}

export const DPRINT_BINARY =
  process.env.DPRINT_BINARY ??
  resolveDependencyBinary("dprint", "dprint") ??
  "dprint";
