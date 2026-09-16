import { statSync } from "node:fs";
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

export function globalBinDirectories(
  binaryName: string,
  platform: NodeJS.Platform,
  home = os.homedir(),
) {
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
  add(path.join(home, ".bun/bin"));
  add(path.join(home, ".bun/install/global/node_modules/.bin"));
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
  const directories =
    options.globalBinDirectories ??
    globalBinDirectories(binaryName, platform, options.home);
  return executableCandidate(
    directoryBinaryCandidates(
      directories,
      executableNames(binaryName, platform),
    ),
    platform,
  );
}
