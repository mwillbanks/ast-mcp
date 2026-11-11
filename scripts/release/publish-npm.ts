import path from "node:path";

const packageName = "@mwillbanks/ast-mcp";
const registry = "https://registry.npmjs.org";
const targets = [
  "darwin-arm64",
  "linux-arm64",
  "linux-x64",
  "linux-arm64-musl",
  "linux-x64-musl",
  "windows-x64",
];

type Archive = { name: string; file: string; integrity: string };

async function verifyArchive(name: string, file: string): Promise<Archive> {
  const checksum = (await Bun.file(file + ".sha256").text())
    .trim()
    .split(/\s+/u)[0];
  const sha256 = new Bun.CryptoHasher("sha256");
  const sha512 = new Bun.CryptoHasher("sha512");
  for await (const chunk of Bun.file(file).stream()) {
    sha256.update(chunk);
    sha512.update(chunk);
  }
  if (sha256.digest("hex") !== checksum)
    throw new Error(`Archive checksum mismatch for ${name}`);
  return { name, file, integrity: "sha512-" + sha512.digest("base64") };
}

async function verifyRegistry(
  { name, integrity }: Archive,
  version: string,
): Promise<boolean> {
  const response = await fetch(
    `${registry}/${encodeURIComponent(name)}/${version}`,
    {
      headers: { "Cache-Control": "no-cache" },
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (response.status === 404) return false;
  if (!response.ok)
    throw new Error(
      `npm registry returned ${response.status} for ${name}@${version}`,
    );
  const manifest = (await response.json()) as {
    name?: string;
    version?: string;
    dist?: { integrity?: string };
  };
  if (
    manifest.name !== name ||
    manifest.version !== version ||
    manifest.dist?.integrity !== integrity
  )
    throw new Error(`npm registry artifact mismatch for ${name}@${version}`);
  return true;
}

async function publish(archive: Archive, version: string): Promise<void> {
  if (await verifyRegistry(archive, version)) {
    console.log(`Verified existing ${archive.name}@${version}`);
    return;
  }

  const command = Bun.spawn(
    [
      "npm",
      "publish",
      path.resolve(archive.file),
      "--access",
      "public",
      "--provenance",
      "--ignore-scripts",
      "--registry",
      registry,
    ],
    { stdout: "inherit", stderr: "inherit" },
  );
  const exitCode = await command.exited;
  if (exitCode !== 0) {
    if (await verifyRegistry(archive, version)) return;
    throw new Error(
      `Could not publish ${archive.name}@${version}. New platform packages require an authenticated first publish of the qualified tarball by the npm scope owner.`,
    );
  }

  for (const delay of [0, 1_000, 2_000, 4_000, 8_000, 16_000]) {
    if (delay) await Bun.sleep(delay);
    if (await verifyRegistry(archive, version)) return;
  }
  throw new Error(`npm registry has yet to expose ${archive.name}@${version}`);
}

const [tag, rootArchive, matrix] = Bun.argv.slice(2);
if (!tag || !/^ast-mcp-v\d+\.\d+\.\d+$/u.test(tag) || !rootArchive || !matrix)
  throw new Error(
    "Usage: publish-npm.ts <release-tag> <root-archive> <matrix-directory>",
  );

const version = tag.slice("ast-mcp-v".length);
const root = await verifyArchive(packageName, rootArchive);
const platforms = [];
for (const target of targets)
  platforms.push(
    await verifyArchive(
      `${packageName}-${target}`,
      path.join(
        matrix,
        `standalone-bun-${target}`,
        `ast-mcp-npm-${target}.tgz`,
      ),
    ),
  );
for (const platform of platforms) await publish(platform, version);
await publish(root, version);
