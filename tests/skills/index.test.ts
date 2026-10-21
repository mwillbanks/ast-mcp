import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { type Transport } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

import {
  exportSkills,
  runSkillsCli,
  SkillsUsageError,
} from "../../src/cli/skills";
import { createServer } from "../../src/server";
import { createSkillCatalog, SKILL_URI } from "../../src/skills";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function temporary() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-skills-"));
  roots.push(root);
  return root;
}
const meta = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
};
async function connection() {
  const server = createServer();
  let counter = 0;
  const pending = new Map<number, (message: any) => void>();
  const transport: Transport = {
    start: async () => {},
    close: async () => {},
    send: async (message) => {
      if ("id" in message) pending.get(Number(message.id))?.(message);
    },
  };
  const handle = serveStdio(() => server, { transport });
  return {
    server: handle,
    async request(
      method: string,
      params: Record<string, unknown> = {},
      metadata: Record<string, unknown> = meta,
    ) {
      const id = ++counter;
      const result = new Promise<any>((resolve) => pending.set(id, resolve));
      transport.onmessage?.({
        jsonrpc: "2.0",
        id,
        method,
        params: { ...params, _meta: metadata },
      });
      return await result;
    },
  };
}

test("Skills discovery and retrieval preserve byte integrity and recover after unknown URIs", async () => {
  const { server, request } = await connection();
  try {
    const discovered = await request("server/discover");
    expect(discovered.error, JSON.stringify(discovered)).toBeUndefined();
    expect(discovered.result.capabilities).toMatchObject({
      resources: {},
      extensions: { "io.modelcontextprotocol/skills": {} },
    });
    expect(
      discovered.result.capabilities.extensions[
        "io.modelcontextprotocol/skills"
      ].directoryRead,
    ).toBeUndefined();
    expect(
      (
        await request(
          "skills/list",
          {},
          { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
        )
      ).error.code,
    ).toBe(-32602);
    const direct = await request("skills/get", { uri: SKILL_URI });
    expect(direct.result).toMatchObject({
      resultType: "complete",
      ttlMs: 300000,
      cacheScope: "public",
      skill: { uri: SKILL_URI, frontmatter: { name: "ast-mcp" } },
    });
    const listed = await request("skills/list");
    expect(listed.result.skills).toEqual([direct.result.skill]);
    const manifests = direct.result.skill.resources;
    expect(manifests.length).toBeGreaterThan(10);
    for (const relative of [
      "SKILL.md",
      "scripts/check-install.ts",
      "references/installation.md",
      "references/agents-guidance.md",
      "references/hook-source.txt",
      "evals/evals.json",
    ]) {
      expect(
        manifests.some(
          (resource: { uri: string }) =>
            resource.uri === "skill://ast-mcp/" + relative,
        ),
      ).toBeTrue();
    }
    for (const resource of manifests) {
      const read = await request("resources/read", { uri: resource.uri });
      expect(read.error, JSON.stringify(read)).toBeUndefined();
      const bytes = Buffer.from(read.result.contents[0].text);
      expect(bytes.length).toBe(resource.size);
      expect("sha256:" + createHash("sha256").update(bytes).digest("hex")).toBe(
        resource.digest,
      );
      expect(read.result).toMatchObject({
        resultType: "complete",
        cacheScope: "public",
        ttlMs: 300000,
      });
    }
    let cursor: string | undefined;
    const uris: string[] = [];
    do {
      const page = await request("resources/list", cursor ? { cursor } : {});
      uris.push(
        ...page.result.resources.map(
          (resource: { uri: string }) => resource.uri,
        ),
      );
      cursor = page.result.nextCursor;
    } while (cursor);
    expect(uris).toEqual(
      manifests.map((resource: { uri: string }) => resource.uri),
    );
    for (const uri of [
      "skill://other/SKILL.md",
      "file:///etc/passwd",
      "skill://ast-mcp/../SKILL.md",
      "skill://ast-mcp/%2e%2e/SKILL.md",
      SKILL_URI + "?x=1",
      "skill://ast-mcp/scripts",
    ]) {
      expect((await request("resources/read", { uri })).error.code).toBe(
        -32602,
      );
    }
    expect(
      (await request("skills/get", { uri: "skill://missing/SKILL.md" })).error
        .code,
    ).toBe(-32602);
    expect((await request("skills/list", { cursor: "bad" })).error.code).toBe(
      -32602,
    );
    expect(
      (await request("resources/list", { cursor: "bad" })).error.code,
    ).toBe(-32602);
    expect(
      (await request("resources/templates/list")).result.resourceTemplates,
    ).toEqual([]);
    expect(
      (await request("skills/get", { uri: SKILL_URI })).result.skill.uri,
    ).toBe(SKILL_URI);
  } finally {
    await server.close();
  }
});

test("catalog preserves all frontmatter and snapshots exact bytes", async () => {
  const root = await temporary();
  const skill =
    "---\nname: ast-mcp\ndescription: Example\nmetadata:\n  version: 3\nallowed-tools: Read\n---\n\nBody\n";
  await writeFile(path.join(root, "SKILL.md"), skill);
  const catalog = await createSkillCatalog(root);
  expect(catalog.get(SKILL_URI).skill.frontmatter).toEqual({
    name: "ast-mcp",
    description: "Example",
    metadata: { version: 3 },
    "allowed-tools": "Read",
  });
  await writeFile(path.join(root, "SKILL.md"), "changed");
  expect(catalog.read(SKILL_URI).contents[0].text).toBe(skill);
  const returned = catalog.get(SKILL_URI);
  returned.skill.frontmatter.name = "mutated";
  expect(catalog.get(SKILL_URI).skill.frontmatter.name).toBe("ast-mcp");
  expect(() => catalog.get("other")).toThrow();
  expect(() => catalog.list("unexpected")).toThrow();
  expect(() => catalog.listResources("bad")).toThrow();
});

test("resource reads preserve UTF-8 BOM bytes declared in manifests", async () => {
  const root = await temporary();
  await writeFile(
    path.join(root, "SKILL.md"),
    "---\nname: ast-mcp\ndescription: Example\n---\n",
  );
  const original = Buffer.from("\uFEFFResource with a byte-order mark\n");
  await writeFile(path.join(root, "resource.txt"), original);
  const catalog = await createSkillCatalog(root);
  const uri = "skill://ast-mcp/resource.txt";
  const manifest = catalog
    .get(SKILL_URI)
    .skill.resources.find((entry) => entry.uri === uri)!;
  const returned = Buffer.from(catalog.read(uri).contents[0].text);
  expect(returned).toEqual(original);
  expect(returned.length).toBe(manifest.size);
  expect("sha256:" + createHash("sha256").update(returned).digest("hex")).toBe(
    manifest.digest,
  );
});

test("catalog rejects missing, malformed, mismatched and symlink resources", async () => {
  const root = await temporary();
  await expect(createSkillCatalog(root)).rejects.toThrow("missing SKILL.md");
  for (const content of [
    "no frontmatter",
    "---\nname: wrong\ndescription: x\n---\n",
    "---\nname: ast-mcp\ndescription: ''\n---\n",
    "---\n- bad\n---\n",
  ]) {
    await writeFile(path.join(root, "SKILL.md"), content);
    await expect(createSkillCatalog(root)).rejects.toThrow();
  }
  await writeFile(
    path.join(root, "SKILL.md"),
    "---\nname: ast-mcp\ndescription: x\n---\n",
  );
  await symlink(path.join(root, "SKILL.md"), path.join(root, "linked.md"));
  await expect(createSkillCatalog(root)).rejects.toThrow("symbolic links");
});

test("manual export preserves customized, unknown and symlink files", async () => {
  const parent = await temporary();
  const destination = path.join(parent, "ast-mcp");
  const first = await exportSkills(destination);
  expect(first.written).toContain("SKILL.md");
  expect(first.preserved).toEqual([]);
  await writeFile(path.join(destination, "SKILL.md"), "customized");
  await writeFile(path.join(destination, "custom.txt"), "user");
  const second = await exportSkills(destination);
  expect(second.written).toEqual([]);
  expect(second.preserved).toContain("SKILL.md");
  expect(await readFile(path.join(destination, "SKILL.md"), "utf8")).toBe(
    "customized",
  );
  expect(await readFile(path.join(destination, "custom.txt"), "utf8")).toBe(
    "user",
  );
  const linked = path.join(parent, "linked");
  await symlink(destination, linked);
  await expect(exportSkills(linked)).rejects.toThrow("symbolic links");
  const linkedFileRoot = path.join(parent, "linked-file");
  await mkdir(linkedFileRoot);
  await symlink(
    path.join(destination, "custom.txt"),
    path.join(linkedFileRoot, "SKILL.md"),
  );
  expect((await exportSkills(linkedFileRoot)).preserved).toContain("SKILL.md");
  expect(await readFile(path.join(destination, "custom.txt"), "utf8")).toBe(
    "user",
  );
  const unsafe = path.join(parent, "unsafe");
  await mkdir(unsafe);
  await symlink(destination, path.join(unsafe, "references"));
  await expect(exportSkills(unsafe)).rejects.toThrow("symbolic links");
});

test("skills CLI validates usage", async () => {
  const usage = new SkillsUsageError("Invalid export destination");
  expect(usage).toBeInstanceOf(Error);
  expect(usage.toString()).toBe("SkillsUsageError: Invalid export destination");
  const destination = path.join(await temporary(), "cli-export");
  const output: string[] = [];
  await runSkillsCli(["export", destination], {
    isTTY: false,
    write: (text) => output.push(text),
  });
  expect(JSON.parse(output.join(""))).toMatchObject({
    operation: "export",
    destination,
    preserved: [],
    written: expect.arrayContaining(["SKILL.md"]),
  });
  output.length = 0;
  await runSkillsCli(["export", destination, "--output=toml"], {
    write: (text) => output.push(text),
  });
  expect(Bun.TOML.parse(output.join(""))).toMatchObject({
    operation: "export",
    destination,
    written: [],
    preserved: expect.arrayContaining(["SKILL.md"]),
  });
  output.length = 0;
  await runSkillsCli(["export", destination], {
    isTTY: true,
    write: (text) => output.push(text),
  });
  expect(output.join("")).toContain("Skill export");
  for (const flags of [["--output=xml"], ["--output=json", "--output=human"]]) {
    const invalidDestination = path.join(destination, "must-not-exist");
    await expect(
      runSkillsCli(["export", invalidDestination, ...flags]),
    ).rejects.toThrow("--output");
    expect(
      await Bun.file(path.join(invalidDestination, "SKILL.md")).exists(),
    ).toBeFalse();
  }
  expect(await readFile(path.join(destination, "SKILL.md"), "utf8")).toContain(
    "name: ast-mcp",
  );
  for (const args of [
    [],
    ["list"],
    ["export"],
    ["export", "--force"],
    ["export", "x", "extra"],
  ])
    await expect(runSkillsCli(args)).rejects.toMatchObject({
      name: "SkillsUsageError",
    });
});
