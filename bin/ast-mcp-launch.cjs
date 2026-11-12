#!/usr/bin/env node

const { spawn } = require("node:child_process");
const { lstatSync, statSync } = require("node:fs");
const { dirname, join } = require("node:path");
const platforms = require("./npm-platforms.json");

function platformPackage() {
  const { platform, arch } = process;
  const libc =
    platform === "linux"
      ? process.report.getReport().header.glibcVersionRuntime
        ? "glibc"
        : "musl"
      : undefined;
  const target = Object.entries(platforms).find(
    ([, entry]) =>
      entry.os === platform && entry.cpu === arch && entry.libc === libc,
  );
  return target && `@mwillbanks/ast-mcp-${target[0]}`;
}

function resolveManifest(packageName) {
  try {
    return require.resolve(`${packageName}/package.json`);
  } catch (error) {
    if (error.code !== "MODULE_NOT_FOUND") throw error;
    for (const directory of require.resolve.paths(packageName) ?? []) {
      try {
        lstatSync(join(directory, packageName));
      } catch (cause) {
        if (cause.code === "ENOENT" || cause.code === "ENOTDIR") continue;
        throw cause;
      }
      throw new Error(
        `${packageName} is installed without its package manifest`,
      );
    }
    return undefined;
  }
}

function nativeCommand(rootManifest) {
  const packageName = platformPackage();
  if (!packageName || !rootManifest.optionalDependencies?.[packageName])
    return undefined;
  const manifestFile = resolveManifest(packageName);
  if (!manifestFile) return undefined;
  const manifest = require(manifestFile);
  if (
    manifest.name !== packageName ||
    manifest.version !== rootManifest.version
  )
    throw new Error(`Invalid or mismatched installation of ${packageName}`);
  const directory = dirname(manifestFile);
  const command = join(
    directory,
    process.platform === "win32" ? "ast-mcp-bytecode.exe" : "ast-mcp-bytecode",
  );
  try {
    const metadata = statSync(command);
    if (
      !metadata.isFile() ||
      (process.platform !== "win32" && (metadata.mode & 0o111) === 0) ||
      !statSync(join(directory, "runtime")).isDirectory()
    )
      throw new Error("Missing executable or runtime assets");
  } catch (cause) {
    throw new Error(`Broken installation of ${packageName}: ${cause.message}`);
  }
  return command;
}

function reportError(error) {
  process.stderr.write(`ast-mcp: ${error.message}\n`);
  process.exitCode = 1;
}

function launch(command, args, missingBun) {
  const child = spawn(command, args, { stdio: "inherit", windowsHide: true });
  const signals =
    process.platform === "win32"
      ? ["SIGINT", "SIGTERM"]
      : ["SIGINT", "SIGTERM", "SIGHUP"];
  const handlers = new Map(
    signals.map((signal) => [signal, () => child.kill(signal)]),
  );
  for (const [signal, handler] of handlers) process.on(signal, handler);
  const removeHandlers = () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  };
  child.once("error", (error) => {
    removeHandlers();
    reportError(
      missingBun && error.code === "ENOENT"
        ? new Error(
            "No native executable is installed for this platform. Install Bun to run the bundled CLI.",
          )
        : error,
    );
  });
  child.once("exit", (code, signal) => {
    removeHandlers();
    if (signal && process.platform !== "win32")
      process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
}

try {
  const args = process.argv.slice(2);
  const command = nativeCommand(require("../package.json"));
  if (command) launch(command, args, false);
  else {
    const runningWithBun = Boolean(process.versions.bun);
    launch(
      runningWithBun ? process.execPath : "bun",
      [join(__dirname, "ast-mcp.js"), ...args],
      !runningWithBun,
    );
  }
} catch (error) {
  reportError(error);
}
