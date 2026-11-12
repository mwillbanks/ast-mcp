import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

import platforms from "../../bin/npm-platforms.json";
import { commandForPlatform } from "../../src/runtime/subprocess";
import { verifyArchive } from "./pack-npm";

const packageName = "@mwillbanks/ast-mcp";
type Target = keyof typeof platforms;

async function runResult(argv: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const [file, ...arguments_] = argv;
  assert(file);
  const { args, command, windowsVerbatimArguments } = commandForPlatform(
    file,
    arguments_,
  );
  const child = Bun.spawn([command, ...args], {
    cwd,
    env,
    stderr: "pipe",
    stdin: "ignore",
    stdout: "pipe",
    timeout: 300_000,
    windowsVerbatimArguments,
  });
  const [code, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  return { code, stderr, stdout: stdout.trim() };
}

async function run(argv: string[], cwd: string, env = process.env) {
  const { code, stderr, stdout } = await runResult(argv, cwd, env);
  assert.equal(code, 0, `${argv.join(" ")}: ${stderr}\n${stdout}`);
  return stdout;
}

async function packument(archive: string) {
  await verifyArchive(archive);
  // GNU tar interprets Windows drive prefixes as remote archive hosts.
  const manifest = JSON.parse(
    await run(
      ["tar", "-xOzf", path.basename(archive), "package/package.json"],
      path.dirname(archive),
    ),
  );
  const integrity = new Bun.CryptoHasher("sha512");
  for await (const chunk of createReadStream(archive)) integrity.update(chunk);
  return {
    archive,
    integrity: "sha512-" + integrity.digest("base64"),
    manifest,
  };
}

async function candidateRegistry(rootArchive: string, matrix: string) {
  const artifacts = await Promise.all([
    packument(rootArchive),
    ...Object.keys(platforms).map((target) =>
      packument(
        path.join(
          matrix,
          `standalone-bun-${target}`,
          `ast-mcp-npm-${target}.tgz`,
        ),
      ),
    ),
  ]);
  const version = artifacts[0]?.manifest.version;
  assert.match(version, /^\d+\.\d+\.\d+$/u);
  assert(artifacts.every((artifact) => artifact.manifest.version === version));
  const names = new Map(
    artifacts.map((artifact) => [artifact.manifest.name, artifact]),
  );
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const prefix = "/tarballs/";
      if (url.pathname.startsWith(prefix)) {
        const name = decodeURIComponent(url.pathname.slice(prefix.length));
        const artifact = names.get(name);
        if (!artifact) return new Response(null, { status: 404 });
        return new Response(Bun.file(artifact.archive), {
          headers: { "Content-Type": "application/octet-stream" },
        });
      }
      const name = decodeURIComponent(url.pathname.slice(1));
      const artifact = names.get(name);
      if (!artifact) return new Response(null, { status: 404 });
      return Response.json({
        name,
        "dist-tags": { latest: version },
        versions: {
          [version]: {
            ...artifact.manifest,
            dist: {
              integrity: artifact.integrity,
              tarball: new URL(prefix + encodeURIComponent(name), url).href,
            },
          },
        },
      });
    },
  });
  return { server, version };
}

function resolveInstalledNative(
  modules: string,
  version: string,
  target: Target,
) {
  const packageManifest = path.join(modules, packageName, "package.json");
  const requireInstalled = createRequire(packageManifest);
  assert.equal(requireInstalled(packageManifest).version, version);
  const name = `${packageName}-${target}`;
  const manifest = requireInstalled.resolve(`${name}/package.json`);
  assert.equal(requireInstalled(manifest).version, version);
  for (const other of Object.keys(platforms)) {
    if (other === target) continue;
    assert.throws(
      () => requireInstalled.resolve(`${packageName}-${other}/package.json`),
      { code: "MODULE_NOT_FOUND" },
    );
  }
  return path.dirname(manifest);
}

const [mode, targetName, input, matrix] = process.argv.slice(2);
assert(targetName && Object.hasOwn(platforms, targetName));
assert(
  input && (mode === "registry" || (mode === "candidate" && matrix)),
  "Usage: qualify-npm.ts <registry|candidate> <target> <version|root-archive> [matrix-directory]",
);
const target = targetName as Target;
const node = Bun.which("node");
const npm = Bun.which("npm");
const git = Bun.which("git");
assert(
  node && npm && git,
  "Node, npm, and Git are required for the test harness",
);
const windows = process.platform === "win32";
const cwd = await realpath(
  await mkdtemp(path.join(tmpdir(), "ast-mcp-npm-test-")),
);
let registry: Awaited<ReturnType<typeof candidateRegistry>> | undefined;
try {
  if (matrix && mode !== "registry") {
    registry = await candidateRegistry(
      path.resolve(input),
      path.resolve(matrix),
    );
  }
  const version = registry?.version ?? input;
  const bin = path.join(cwd, "path");
  await mkdir(bin);
  if (!windows) {
    await symlink(node, path.join(bin, "node"));
    await symlink(git, path.join(bin, "git"));
  }
  const env = {
    ...(windows
      ? {
          APPDATA: path.join(cwd, "appdata"),
          LOCALAPPDATA: path.join(cwd, "local-appdata"),
          ComSpec: process.env.ComSpec,
          PATHEXT: process.env.PATHEXT,
          SystemRoot: process.env.SystemRoot,
          WINDIR: process.env.WINDIR,
          TEMP: cwd,
          TMP: cwd,
          USERPROFILE: cwd,
        }
      : {}),
    AST_MCP_EXPERIMENT_NATIVE_ONLY: "1",
    BUN_CONFIG_NO_AUTO_INSTALL: "1",
    DO_NOT_TRACK: "1",
    HOME: cwd,
    PATH: windows
      ? [path.dirname(node), path.dirname(git)].join(path.delimiter)
      : bin,
    XDG_CONFIG_HOME: path.join(cwd, "config"),
    npm_config_cache: path.join(cwd, "npm-cache"),
    npm_config_ignore_scripts: "true",
    npm_config_userconfig: path.join(cwd, ".npmrc"),
  };
  assert.equal(Bun.which("bun", { PATH: env.PATH }), null);
  if (registry)
    await Bun.write(
      env.npm_config_userconfig,
      `@mwillbanks:registry=${registry.server.url}\n`,
    );
  const spec = `${packageName}@${version}`;
  const install = [
    npm,
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
  ];
  const local = path.join(cwd, "local");
  const prefix = path.join(cwd, "global");
  await mkdir(local);
  await run([...install, spec], local, env);
  await run([...install, "--global", "--prefix", prefix, spec], cwd, env);
  const global = await run(
    [npm, "root", "--global", "--prefix", prefix],
    cwd,
    env,
  );
  const localModules = path.join(local, "node_modules");
  const shim = windows ? "ast-mcp.cmd" : "ast-mcp";
  const globalBin = windows ? prefix : path.join(prefix, "bin");
  const localShim = path.join(localModules, ".bin", shim);
  const globalShim = path.join(globalBin, shim);
  const platformDirectory = resolveInstalledNative(
    localModules,
    version,
    target,
  );
  const globalPlatform = resolveInstalledNative(global, version, target);
  const binaryName = windows ? "ast-mcp-bytecode.exe" : "ast-mcp-bytecode";
  const localBinary = path.join(platformDirectory, binaryName);
  const globalBinary = path.join(globalPlatform, binaryName);
  for (const executable of [localShim, globalShim, localBinary, globalBinary])
    assert.equal(await run([executable, "--version"], local, env), version);
  // The binary can run the embedded package manager. The Node entry point would
  // need Node to start before reaching the same code.
  assert.equal(
    await run([localBinary, "--version"], local, { ...env, BUN_BE_BUN: "1" }),
    Bun.version,
  );
  for (const folder of [platformDirectory, globalPlatform])
    assert(
      await Bun.file(
        path.join(
          folder,
          "runtime",
          "node_modules",
          "@ast-grep",
          "napi",
          "package.json",
        ),
      ).exists(),
    );
  const runtime = path.join(platformDirectory, "runtime");
  const unavailable = path.join(cwd, "unavailable");
  await rename(runtime, unavailable);
  try {
    const broken = await runResult([localShim, "--version"], local, env);
    assert.equal(broken.code, 1);
    assert.match(broken.stderr, /Broken installation/);
  } finally {
    await rename(unavailable, runtime);
  }
  await rename(platformDirectory, unavailable);
  try {
    const absent = await runResult([localShim, "--version"], local, env);
    assert.equal(absent.code, 1);
    assert.match(absent.stderr, /Install Bun to run the bundled CLI/);
  } finally {
    await rename(unavailable, platformDirectory);
  }
  const gitOnlyPath = path.join(cwd, "git-only");
  await mkdir(gitOnlyPath);
  if (!windows) await symlink(git, path.join(gitOnlyPath, "git"));
  const nativeEnv = {
    ...env,
    PATH: windows ? path.dirname(git) : gitOnlyPath,
    npm_config_prefix: prefix,
  };
  assert.equal(Bun.which("node", { PATH: nativeEnv.PATH }), null);
  for (const [scope, executable, binary, configRoot] of [
    ["local", localShim, localBinary, local],
    ["global", globalShim, globalBinary, cwd],
  ] as const) {
    const args = ["--scope", scope, "--target", "codex", "--output", "json"];
    const shimEnv = { ...env, npm_config_prefix: prefix };
    await run([executable, "install", ...args], configRoot, shimEnv);
    await run([executable, "update", ...args], configRoot, shimEnv);
    const config = Bun.TOML.parse(
      await Bun.file(path.join(configRoot, ".codex", "config.toml")).text(),
    ) as { mcp_servers?: Record<string, { args: string[]; command: string }> };
    const launch = config.mcp_servers?.["ast-mcp"];
    assert(launch, `Missing ${scope} Codex configuration`);
    assert.deepEqual(launch.args, ["mcp"]);
    const configured = path.resolve(configRoot, launch.command);
    assert.equal(await realpath(configured), await realpath(binary));
    assert.equal(
      await run([configured, ...launch.args], configRoot, nativeEnv),
      "",
    );
  }
  const qualify = path.join(import.meta.dir, "qualify-standalone.ts");
  const result = await run(
    [
      process.execPath,
      qualify,
      platformDirectory,
      "--bytecode-only",
      "--with-pm",
    ],
    local,
  );
  console.log(
    JSON.stringify({ mode, target, version, qualified: JSON.parse(result) }),
  );
} finally {
  if (registry) await registry.server.stop(true);
  await rm(cwd, { force: true, recursive: true });
}
