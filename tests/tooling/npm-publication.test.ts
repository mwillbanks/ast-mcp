import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { publishNpmRelease } from "../../scripts/release/npm-publication.ts";
import { removeTempDirectory } from "../support/temp-directory.ts";

const base = "@mwillbanks/ast-mcp";
const version = "1.2.3";
const tag = "ast-mcp-v" + version;
const targets = [
  "darwin-arm64",
  "linux-arm64",
  "linux-x64",
  "linux-arm64-musl",
  "linux-x64-musl",
  "windows-x64",
];
const scratch: string[] = [];

afterEach(async () => {
  await Promise.all(scratch.splice(0).map(removeTempDirectory));
});

async function releaseFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "ast-mcp-npm-publish-"));
  scratch.push(directory);
  const root = path.join(directory, "ast-mcp.tgz");
  const matrix = path.join(directory, "matrix");
  const platforms = targets.map((target) => ({
    name: base + "-" + target,
    file: path.join(
      matrix,
      "standalone-bun-" + target,
      "ast-mcp-npm-" + target + ".tgz",
    ),
  }));
  const archives = [...platforms, { name: base, file: root }];
  const manifests = new Map<
    string,
    {
      name: string;
      version: string;
      dist: { integrity: string };
    }
  >();
  for (const { name, file } of archives) {
    const bytes = Buffer.from(name + " candidate archive");
    await mkdir(path.dirname(file), { recursive: true });
    await Bun.write(file, bytes);
    await Bun.write(
      file + ".sha256",
      new Bun.CryptoHasher("sha256").update(bytes).digest("hex") +
        "  " +
        path.basename(file) +
        "\n",
    );
    manifests.set(name, {
      name,
      version,
      dist: {
        integrity:
          "sha512-" +
          new Bun.CryptoHasher("sha512").update(bytes).digest("base64"),
      },
    });
  }

  const registry = "https://registry.npmjs.org";
  function packageAt(url: string) {
    const parsed = new URL(url);
    expect(parsed.origin).toBe(registry);
    const [, encoded, actualVersion] = parsed.pathname.split("/");
    expect(actualVersion).toBe(version);
    return decodeURIComponent(encoded!);
  }
  const commands: string[][] = [];
  const delays: number[] = [];
  const queries: string[] = [];
  const visible = new Set<string>();
  let publishCode = 0;
  let deferVisibility = false;
  let registryError: Response | undefined;
  const io = {
    fetch: async (url: string) => {
      const name = packageAt(url);
      queries.push(name);
      if (registryError) return registryError;
      if (!visible.has(name)) return new Response(null, { status: 404 });
      return Response.json(manifests.get(name));
    },
    publish: async (command: string[]) => {
      commands.push(command);
      const archive = archives.find(
        (candidate) => candidate.file === command[2],
      );
      if (!archive) throw new Error("Unexpected archive");
      if (!deferVisibility) visible.add(archive.name);
      return publishCode;
    },
    delay: async (milliseconds: number) => {
      delays.push(milliseconds);
    },
  };
  return {
    archives,
    args: [tag, root, matrix],
    registry,
    manifests,
    commands,
    delays,
    queries,
    visible,
    io,
    setPublishCode: (code: number) => {
      publishCode = code;
    },
    deferPublishVisibility: () => {
      deferVisibility = true;
    },
    setRegistryError: (response: Response) => {
      registryError = response;
    },
  };
}

test("publishes exact platform archives before the main package", async () => {
  const fixture = await releaseFixture();
  await publishNpmRelease(fixture.args, fixture.io);
  expect(fixture.commands).toEqual(
    fixture.archives.map(({ file }) => [
      "npm",
      "publish",
      file,
      "--access",
      "public",
      "--provenance",
      "--ignore-scripts",
      "--registry",
      fixture.registry,
    ]),
  );
  expect(fixture.queries).toEqual(
    fixture.archives.flatMap(({ name }) => [name, name]),
  );
  expect(fixture.delays).toEqual([]);
});

test("rejects invalid arguments and a bad platform checksum before registry activity", async () => {
  const fixture = await releaseFixture();
  await expect(
    publishNpmRelease(["bad-tag", ...fixture.args.slice(1)], fixture.io),
  ).rejects.toThrow("Usage: publish-npm.ts");
  const last = fixture.archives[targets.length - 1]!;
  await Bun.write(last.file, "modified after qualification");
  await expect(publishNpmRelease(fixture.args, fixture.io)).rejects.toThrow(
    "Archive checksum mismatch for " + last.name,
  );
  expect(fixture.queries).toEqual([]);
  expect(fixture.commands).toEqual([]);
});

test("reuses exact registry versions and rejects differing digests", async () => {
  const fixture = await releaseFixture();
  for (const { name } of fixture.archives) fixture.visible.add(name);
  await publishNpmRelease(fixture.args, fixture.io);
  expect(fixture.queries).toEqual(fixture.archives.map(({ name }) => name));
  expect(fixture.commands).toEqual([]);

  const name = fixture.archives[0]!.name;
  fixture.manifests.get(name)!.dist.integrity = "sha512-unexpected";
  await expect(publishNpmRelease(fixture.args, fixture.io)).rejects.toThrow(
    "npm registry artifact mismatch for " + name,
  );
  expect(fixture.commands).toEqual([]);
});

test("fails closed on registry errors and an unverified publish failure", async () => {
  const fixture = await releaseFixture();
  fixture.setRegistryError(new Response(null, { status: 503 }));
  await expect(publishNpmRelease(fixture.args, fixture.io)).rejects.toThrow(
    "npm registry returned 503",
  );
  expect(fixture.commands).toEqual([]);

  const failure = await releaseFixture();
  failure.setPublishCode(1);
  failure.deferPublishVisibility();
  await expect(publishNpmRelease(failure.args, failure.io)).rejects.toThrow(
    "Could not publish " + failure.archives[0]!.name,
  );
  expect(failure.commands.map((command) => command[2])).toEqual([
    failure.archives[0]!.file,
  ]);
});

test("recognizes a matching version published concurrently despite a nonzero npm exit", async () => {
  const fixture = await releaseFixture();
  fixture.setPublishCode(1);
  await publishNpmRelease(fixture.args, fixture.io);
  expect(fixture.commands).toHaveLength(fixture.archives.length);
  expect(fixture.delays).toEqual([]);
});

test("bounds registry visibility retries and leaves the main package unpublished", async () => {
  const fixture = await releaseFixture();
  fixture.deferPublishVisibility();
  await expect(publishNpmRelease(fixture.args, fixture.io)).rejects.toThrow(
    "npm registry has yet to expose " + fixture.archives[0]!.name,
  );
  expect(fixture.delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000]);
  expect(fixture.commands.map((command) => command[2])).toEqual([
    fixture.archives[0]!.file,
  ]);
});
