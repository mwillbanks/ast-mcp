import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import platforms from "../../bin/npm-platforms.json";

const root = path.resolve(import.meta.dir, "../..");
type Target = keyof typeof platforms;

function target(value: string): Target {
  if (!Object.hasOwn(platforms, value))
    throw new Error(`Unknown standalone npm target: ${value}`);
  return value as Target;
}

async function execute(argv: string[]) {
  const child = Bun.spawn(argv, {
    cwd: root,
    env: { ...process.env, COPYFILE_DISABLE: "1" },
    stderr: "inherit",
    stdout: "inherit",
  });
  assert.equal(await child.exited, 0, `${argv[0]} failed`);
}

async function sha256(file: string) {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of createReadStream(file)) hasher.update(chunk);
  return hasher.digest("hex");
}

export async function verifyArchive(file: string) {
  const [expected] = (await Bun.file(file + ".sha256").text())
    .trim()
    .split(/\s+/u);
  assert.match(expected ?? "", /^[a-f0-9]{64}$/u, "Invalid archive checksum");
  assert.equal(await sha256(file), expected, `Checksum mismatch for ${file}`);
}

async function packageArchive(
  stage: string,
  destination: string,
  platformPackage: boolean,
) {
  await mkdir(path.dirname(destination), { recursive: true });
  // Keep runtime/node_modules verbatim. npm packlist normally filters dependency trees.
  const temporary = await mkdtemp(
    path.join(path.dirname(destination), ".npm-pack-"),
  );
  try {
    const archive = path.join(temporary, "package.tgz");
    await execute(["tar", "-C", stage, "-czf", archive, "package"]);
    if (platformPackage) {
      const maximumBytes = 200_000_000;
      const bytes = Bun.file(archive).size;
      assert(
        bytes <= maximumBytes,
        `${destination} is ${bytes} bytes, exceeding the ${maximumBytes}-byte npm platform package budget`,
      );
    }
    const digest = await sha256(archive);
    await rename(archive, destination);
    await Bun.write(
      destination + ".sha256",
      digest +
        (platformPackage ? "  " + path.basename(destination) : "") +
        "\n",
    );
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
}

async function rootArchive(stage: string, destination: string) {
  const baseArchive = path.join(stage, "fallback.tgz");
  await execute([process.execPath, "pm", "pack", "--filename", baseArchive]);
  await execute(["tar", "-xzf", baseArchive, "-C", stage]);
  const manifestFile = path.join(stage, "package", "package.json");
  const manifest = await Bun.file(manifestFile).json();
  assert.equal(manifest.name, "@mwillbanks/ast-mcp");
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/u);
  manifest.optionalDependencies = {
    ...manifest.optionalDependencies,
    ...Object.fromEntries(
      Object.keys(platforms).map((name) => [
        `${manifest.name}-${name}`,
        manifest.version,
      ]),
    ),
  };
  await Bun.write(manifestFile, JSON.stringify(manifest, null, 2) + "\n");
  await packageArchive(stage, destination, false);
}

async function platformArchive(
  stage: string,
  destination: string,
  platform: Target,
  standaloneArchive: string,
) {
  await verifyArchive(standaloneArchive);
  const packageDirectory = path.join(stage, "package");
  await mkdir(packageDirectory);
  await execute(["tar", "-xzf", standaloneArchive, "-C", packageDirectory]);
  const sourceManifest = await Bun.file(path.join(root, "package.json")).json();
  const executable = path.join(
    packageDirectory,
    platform === "windows-x64" ? "ast-mcp-bytecode.exe" : "ast-mcp-bytecode",
  );
  await chmod(executable, 0o755);
  await copyFile(
    path.join(root, "LICENSE"),
    path.join(packageDirectory, "LICENSE"),
  );
  const metadata = platforms[platform];
  await Bun.write(
    path.join(packageDirectory, "package.json"),
    JSON.stringify(
      {
        name: `${sourceManifest.name}-${platform}`,
        version: sourceManifest.version,
        description: `AST-MCP standalone executable for ${platform}`,
        os: [metadata.os],
        cpu: [metadata.cpu],
        ...("libc" in metadata ? { libc: [metadata.libc] } : {}),
        license: sourceManifest.license,
        repository: sourceManifest.repository,
        publishConfig: { access: "public" },
      },
      null,
      2,
    ) + "\n",
  );
  await packageArchive(stage, destination, true);
}

if (import.meta.main) {
  const [mode, destination, platform, standaloneArchive, ...extra] =
    process.argv.slice(2);
  assert(
    destination &&
      extra.length === 0 &&
      ((mode === "root" && !platform && !standaloneArchive) ||
        (mode === "platform" && platform && standaloneArchive)),
    "Usage: pack-npm.ts root <output.tgz> | platform <output.tgz> <target> <standalone.tar.gz>",
  );
  const stage = await mkdtemp(path.join(tmpdir(), "ast-mcp-npm-pack-"));
  try {
    if (mode === "root") await rootArchive(stage, path.resolve(destination));
    else
      await platformArchive(
        stage,
        path.resolve(destination),
        target(platform!),
        path.resolve(standaloneArchive!),
      );
  } finally {
    await rm(stage, { force: true, recursive: true });
  }
}
