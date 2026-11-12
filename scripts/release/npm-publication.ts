import path from "node:path";

import platforms from "../../bin/npm-platforms.json";

const packageName = "@mwillbanks/ast-mcp";
const registry = "https://registry.npmjs.org";

type PublicationIo = {
  fetch: (url: string) => Promise<Response>;
  publish: (command: string[]) => Promise<number>;
  delay: (milliseconds: number) => Promise<void>;
};

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
  fetchRegistry: PublicationIo["fetch"],
): Promise<boolean> {
  const response = await fetchRegistry(
    `${registry}/${encodeURIComponent(name)}/${version}`,
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

async function publish(
  archive: Archive,
  version: string,
  io: PublicationIo,
): Promise<void> {
  if (await verifyRegistry(archive, version, io.fetch)) {
    console.log(`Verified existing ${archive.name}@${version}`);
    return;
  }

  const exitCode = await io.publish([
    "npm",
    "publish",
    path.resolve(archive.file),
    "--access",
    "public",
    "--provenance",
    "--ignore-scripts",
    "--registry",
    registry,
  ]);
  for (const delay of [0, 1_000, 2_000, 4_000, 8_000, 16_000]) {
    if (delay) await io.delay(delay);
    if (await verifyRegistry(archive, version, io.fetch)) return;
  }
  if (exitCode !== 0)
    throw new Error(
      `Could not publish ${archive.name}@${version}. New platform packages require an authenticated first publish of the qualified tarball by the npm scope owner.`,
    );
  throw new Error(`npm registry has yet to expose ${archive.name}@${version}`);
}

export async function publishNpmRelease(
  args: readonly string[],
  io: PublicationIo,
): Promise<void> {
  const [tag, rootArchive, matrix] = args;
  if (
    args.length !== 3 ||
    !tag ||
    !/^ast-mcp-v\d+\.\d+\.\d+$/u.test(tag) ||
    !rootArchive ||
    !matrix
  )
    throw new Error(
      "Usage: publish-npm.ts <release-tag> <root-archive> <matrix-directory>",
    );

  const version = tag.slice("ast-mcp-v".length);
  const root = await verifyArchive(packageName, rootArchive);
  const archives = [];
  for (const target of Object.keys(platforms))
    archives.push(
      await verifyArchive(
        `${packageName}-${target}`,
        path.join(
          matrix,
          `standalone-bun-${target}`,
          `ast-mcp-npm-${target}.tgz`,
        ),
      ),
    );
  for (const archive of archives) await publish(archive, version, io);
  await publish(root, version, io);
}
