import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import {
  directoryBinaryCandidates,
  executableCandidate,
  executableNames,
  globalBinDirectories,
  resolveGlobalBinaryAlias,
  resolveLocalBinaryAlias,
} from "../../templates/skills/ast-mcp/scripts/binary-resolution";
import { currentConfig } from "../config";

export {
  globalBinDirectories,
  resolveGlobalBinaryAlias,
  resolveLocalBinaryAlias,
};

const PACKAGE_ROOT = path.resolve(
  import.meta.dir,
  path.basename(import.meta.dir) === "dist" ? ".." : "../..",
);

const require = createRequire(import.meta.url);

interface BinaryResolutionOptions {
  globalBinDirectories?: string[];
  home?: string;
  packageBinary?: string;
  packageRoot?: string;
  pathValue?: string;
  platform?: NodeJS.Platform;
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

function ancestorBinaryCandidates(packageRoot: string, names: string[]) {
  const candidates: string[] = [];
  for (
    let current = packageRoot;
    path.dirname(current) !== current;
    current = path.dirname(current)
  ) {
    for (const name of names)
      candidates.push(path.join(current, "node_modules/.bin", name));
  }
  return candidates;
}

export function resolveDependencyBinary(
  binaryName: string,
  packageName = binaryName,
  options: BinaryResolutionOptions = {},
) {
  const platform = options.platform ?? process.platform;
  const packageRoot = options.packageRoot ?? PACKAGE_ROOT;
  const names = executableNames(binaryName, platform);
  const localCandidates = ancestorBinaryCandidates(packageRoot, names);
  const directPackageBinary =
    options.packageBinary ?? packageBinary(packageName, binaryName);
  if (directPackageBinary) localCandidates.push(directPackageBinary);
  const local = executableCandidate(localCandidates, platform);
  if (local) return local;
  const globalDirectories =
    options.globalBinDirectories ??
    globalBinDirectories(binaryName, platform, options.home);
  const global = executableCandidate(
    directoryBinaryCandidates(globalDirectories, names),
    platform,
  );
  if (global) return global;
  const pathDirectories = (options.pathValue ?? process.env.PATH ?? "").split(
    path.delimiter,
  );
  return executableCandidate(
    directoryBinaryCandidates(pathDirectories, names),
    platform,
  );
}

export const DPRINT_BINARY =
  process.env.DPRINT_BINARY ??
  resolveDependencyBinary("dprint", "dprint") ??
  "dprint";

export async function configuredDprintBinary(): Promise<string> {
  return (await currentConfig()).dependencies.dprintBinary ?? DPRINT_BINARY;
}
