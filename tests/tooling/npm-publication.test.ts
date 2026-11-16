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
    [...fixture.archives, ...fixture.archives].map(({ name }) => name),
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

test("fails closed on registry errors and reports unverified npm exits", async () => {
  const fixture = await releaseFixture();
  fixture.setRegistryError(new Response(null, { status: 503 }));
  await expect(publishNpmRelease(fixture.args, fixture.io)).rejects.toThrow(
    "npm registry returned 503",
  );
  expect(fixture.commands).toEqual([]);

  const failure = await releaseFixture();
  const failedPlatform = failure.archives[0]!;
  failure.deferPublishVisibility();
  await expect(
    publishNpmRelease(failure.args, {
      ...failure.io,
      publish: async (command) => {
        await failure.io.publish(command);
        return command[2] === failedPlatform.file ? 1 : 0;
      },
    }),
  ).rejects.toThrow(`${failedPlatform.name}@${version} (npm publish exited 1)`);
  expect(failure.commands.map((command) => command[2])).toEqual(
    failure.archives.slice(0, -1).map(({ file }) => file),
  );
});

test("recognizes matching versions published concurrently despite nonzero npm exits", async () => {
  const fixture = await releaseFixture();
  fixture.setPublishCode(1);
  await publishNpmRelease(fixture.args, fixture.io);
  expect(fixture.commands).toHaveLength(fixture.archives.length);
  expect(fixture.delays).toEqual([]);
});

test("submits every missing archive before waiting for npm scans", async () => {
  const fixture = await releaseFixture();
  const [existing, early, ...later] = fixture.archives;
  fixture.visible.add(existing!.name);
  fixture.deferPublishVisibility();

  await publishNpmRelease(fixture.args, {
    ...fixture.io,
    delay: async (milliseconds) => {
      await fixture.io.delay(milliseconds);
      expect(fixture.commands.map((command) => command[2])).toEqual(
        [early!, ...later].map(({ file }) => file),
      );
      if (fixture.delays.length === 1) {
        fixture.visible.add(early!.name);
      } else {
        for (const { name } of later) fixture.visible.add(name);
      }
    },
  });

  expect(fixture.delays).toEqual([20_000, 20_000]);
  expect(
    fixture.queries.filter((name) => name === existing!.name),
  ).toHaveLength(1);
  expect(fixture.queries.filter((name) => name === early!.name)).toHaveLength(
    3,
  );
  expect(fixture.queries.filter((name) => name === base)).toHaveLength(4);
});

test("rejects a registry integrity mismatch after npm scans", async () => {
  const fixture = await releaseFixture();
  fixture.deferPublishVisibility();
  fixture.manifests.get(base)!.dist.integrity = "sha512-unexpected";
  await expect(
    publishNpmRelease(fixture.args, {
      ...fixture.io,
      delay: async () => {
        for (const { name } of fixture.archives) fixture.visible.add(name);
      },
    }),
  ).rejects.toThrow("npm registry artifact mismatch for " + base);
  expect(fixture.commands).toHaveLength(fixture.archives.length);
});

test("bounds the shared registry wait and reports only missing archives", async () => {
  const fixture = await releaseFixture();
  fixture.deferPublishVisibility();
  const missing = fixture.archives.at(-1)!;
  await expect(
    publishNpmRelease(fixture.args, {
      ...fixture.io,
      delay: async (milliseconds) => {
        await fixture.io.delay(milliseconds);
        for (const { name } of fixture.archives.slice(0, -1)) {
          fixture.visible.add(name);
        }
      },
    }),
  ).rejects.toThrow(
    "npm registry has yet to expose " + missing.name + "@1.2.3",
  );
  expect(fixture.delays).toEqual(Array.from({ length: 60 }, () => 20_000));
  expect(fixture.commands).toHaveLength(fixture.archives.length);
});
