import { realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

export interface GlobalBinaryResolutionOptions {
  globalBinDirectories?: string[];
  home?: string;
  platform?: NodeJS.Platform;
}

export interface PlatformCommand {
  args: string[];
  command: string;
  windowsVerbatimArguments?: boolean;
}

function batchArgument(value: string) {
  if (/[\0\r\n"%!^]/u.test(value))
    throw new Error(
      "Windows batch command arguments cannot contain quotes, expansion characters, or control characters",
    );
  if (/^[A-Za-z0-9_./:\\=-]+$/u.test(value)) return value;
  return `"${value}"`;
}

export function commandForPlatform(
  command: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  comspec = process.env.ComSpec ?? "cmd.exe",
): PlatformCommand {
  if (platform !== "win32" || !/\.(?:cmd|bat)$/iu.test(command))
    return { args, command };
  return {
    args: [
      "/d",
      "/v:off",
      "/s",
      "/c",
      `call ${[command, ...args].map(batchArgument).join(" ")}`,
    ],
    command: comspec,
    windowsVerbatimArguments: true,
  };
}

export function executableNames(name: string, platform: NodeJS.Platform) {
  if (platform !== "win32") return [name];
  const extensions = (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
    .split(";")
    .filter(Boolean)
    .map((extension) =>
      extension.startsWith(".") ? extension : `.${extension}`,
    );
  return [
    ...new Set([...extensions.map((extension) => `${name}${extension}`), name]),
  ];
}

export function isExecutable(
  file: string,
  platform: NodeJS.Platform = process.platform,
) {
  try {
    const metadata = statSync(file);
    if (!metadata.isFile()) return false;
    if (platform === "win32") return true;
    return (metadata.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

export function npmNativeBinaries(
  alias: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string[] {
  const directory = path.dirname(alias);
  const modules =
    path.basename(directory) === ".bin"
      ? path.dirname(directory)
      : path.join(directory, "node_modules");
  const roots = new Set([path.join(modules, "@mwillbanks", "ast-mcp")]);
  try {
    const entry = realpathSync(alias);
    if (path.basename(entry) === "ast-mcp-launch.cjs")
      roots.add(path.dirname(path.dirname(entry)));
  } catch {
    // The npm shim can be absent while checking a previous installation.
  }
  const names =
    platform === "win32"
      ? [`windows-${arch}`]
      : [
          `${platform}-${arch}`,
          ...(platform === "linux" ? [`linux-${arch}-musl`] : []),
        ];
  const binaries = new Set<string>();
  for (const root of roots) {
    const packageManifest = path.join(root, "package.json");
    try {
      const requireInstalled = createRequire(packageManifest);
      const installed = requireInstalled(packageManifest) as {
        name?: string;
        optionalDependencies?: Record<string, string>;
        version?: string;
      };
      if (installed.name !== "@mwillbanks/ast-mcp") continue;
      for (const target of names) {
        const name = `@mwillbanks/ast-mcp-${target}`;
        if (
          !installed.version ||
          installed.optionalDependencies?.[name] !== installed.version
        )
          continue;
        try {
          const manifest = realpathSync(
            requireInstalled.resolve(`${name}/package.json`),
          );
          // Versioned pnpm or Yarn paths can change on every upgrade.
          // Those managers retain their existing stable bin aliases.
          if (
            manifest
              .split(path.sep)
              .some((segment) => segment === ".pnpm" || segment === ".yarn")
          )
            continue;
          const native = requireInstalled(manifest) as {
            name?: string;
            version?: string;
          };
          if (native.name !== name || native.version !== installed.version)
            continue;
          const executable = path.join(
            path.dirname(manifest),
            platform === "win32" ? "ast-mcp-bytecode.exe" : "ast-mcp-bytecode",
          );
          if (isExecutable(executable, platform)) binaries.add(executable);
        } catch {
          // An optional package for another libc need not be installed.
        }
      }
    } catch {
      // Other managers can expose an alias without npm package metadata.
    }
  }
  return [...binaries];
}

function commandOutput(command: string, args: string[]) {
  try {
    const result = Bun.spawnSync([command, ...args], {
      stdin: "ignore",
      stderr: "ignore",
      stdout: "pipe",
      timeout: 1000,
      killSignal: "SIGKILL",
      maxBuffer: 64 * 1024,
    });
    return result.exitCode === 0 ? result.stdout.toString().trim() : "";
  } catch {
    return "";
  }
}

export function globalBinDirectories(
  binaryName: string,
  platform: NodeJS.Platform,
  home = os.homedir(),
  discover = true,
) {
  const directories = new Set<string>();
  const add = (value: string | undefined) => {
    if (value) directories.add(path.resolve(value));
  };
  const yarnBinary = discover ? commandOutput("yarn", ["bin", binaryName]) : "";
  if (yarnBinary) add(path.dirname(yarnBinary));
  add(process.env.BUN_INSTALL && path.join(process.env.BUN_INSTALL, "bin"));
  add(process.env.PNPM_HOME);
  add(
    process.env.npm_config_prefix &&
      (platform === "win32"
        ? process.env.npm_config_prefix
        : path.join(process.env.npm_config_prefix, "bin")),
  );
  add(path.join(home, ".bun/bin"));
  add(path.join(home, ".bun/install/global/node_modules/.bin"));
  if (!discover) return [...directories];
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

export function directoryBinaryCandidates(
  directories: string[],
  names: string[],
) {
  const candidates: string[] = [];
  for (const directory of directories) {
    if (!directory) continue;
    for (const name of names) candidates.push(path.join(directory, name));
  }
  return candidates;
}

export function executableCandidate(
  candidates: string[],
  platform: NodeJS.Platform,
) {
  return candidates.find((candidate) => isExecutable(candidate, platform));
}

export function resolveLocalBinaryAlias(
  binaryName: string,
  root: string,
  platform: NodeJS.Platform = process.platform,
) {
  return executableCandidate(
    directoryBinaryCandidates(
      [path.join(root, "node_modules/.bin")],
      executableNames(binaryName, platform),
    ),
    platform,
  );
}

export function resolveGlobalBinaryAlias(
  binaryName: string,
  options: GlobalBinaryResolutionOptions = {},
) {
  const platform = options.platform ?? process.platform;
  const names = executableNames(binaryName, platform);
  if (!options.globalBinDirectories) {
    const known = executableCandidate(
      directoryBinaryCandidates(
        globalBinDirectories(binaryName, platform, options.home, false),
        names,
      ),
      platform,
    );
    if (known) return known;
  }
  const directories =
    options.globalBinDirectories ??
    globalBinDirectories(binaryName, platform, options.home);
  return executableCandidate(
    directoryBinaryCandidates(directories, names),
    platform,
  );
}
