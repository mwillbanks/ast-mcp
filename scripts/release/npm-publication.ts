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

function submit(archive: Archive, publish: PublicationIo["publish"]) {
  return publish([
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
}

type Submission = { archive: Archive; exitCode: number };

async function verifyPublished(
  submissions: Submission[],
  version: string,
  io: PublicationIo,
): Promise<void> {
  const interval = 20_000;
  const maxWait = 20 * 60_000;
  let pending = submissions;
  for (let waited = 0; pending.length > 0; waited += interval) {
    if (waited > 0) await io.delay(interval);
    const visible = await Promise.all(
      pending.map(({ archive }) => verifyRegistry(archive, version, io.fetch)),
    );
    pending = pending.filter((_, index) => !visible[index]);
    if (waited === maxWait) break;
  }
  if (pending.length > 0) {
    const packages = pending.map(({ archive, exitCode }) =>
      exitCode === 0
        ? `${archive.name}@${version}`
        : `${archive.name}@${version} (npm publish exited ${exitCode})`,
    );
    throw new Error(`npm registry has yet to expose ${packages.join(", ")}`);
  }
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
  archives.push(root);
  const existing = await Promise.all(
    archives.map((archive) => verifyRegistry(archive, version, io.fetch)),
  );
  let submissions: Submission[] = [];
  for (const [index, archive] of archives.entries()) {
    if (existing[index]) {
      console.log(`Verified existing ${archive.name}@${version}`);
      continue;
    }
    if (archive === root) {
      // A nonzero exit can mean another run uploaded this exact version.
      const failedPlatforms = submissions.filter(
        ({ exitCode }) => exitCode !== 0,
      );
      await verifyPublished(failedPlatforms, version, io);
      submissions = submissions.filter(({ exitCode }) => exitCode === 0);
    }
    submissions.push({ archive, exitCode: await submit(archive, io.publish) });
  }
  await verifyPublished(submissions, version, io);
}
