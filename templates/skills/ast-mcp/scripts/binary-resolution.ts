import { accessSync, constants } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface GlobalBinaryResolutionOptions {
  globalBinDirectories?: string[];
  home?: string;
  platform?: NodeJS.Platform;
}

export function executableNames(name: string, platform: NodeJS.Platform) {
  if (platform !== "win32") return [name];
  const extensions = (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
    .split(";")
    .filter(Boolean);
  return [name, ...extensions.map((extension) => `${name}${extension}`)];
}

export function isExecutable(
  file: string,
  platform: NodeJS.Platform = process.platform,
) {
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
