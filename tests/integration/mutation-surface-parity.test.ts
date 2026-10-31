import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import { withConfig } from "../../src/config";
import {
  withMutationLifecycle,
  LanceMutationLifecycle,
} from "../../src/intelligence/mutation";
import { refreshMutationIntelligence } from "../../src/intelligence/mutation/freshness";
import { LanceIntelligenceStore } from "../../src/intelligence/storage/store";
import {
  WorkspaceRegistry,
  withWorkspaceContext,
} from "../../src/intelligence/workspace";
import { sha256 } from "../../src/runtime/hash";
import registerLifecycleTools from "../../src/tools/lifecycle";
import { hermeticConfig } from "../support/hermetic-config";
import { spawnHttpMcpProcess } from "../support/live-process";
import { removeTempDirectory } from "../support/temp-directory";

const repository = path.resolve(import.meta.dir, "../..");
const configuration = `version = 2
[[paths]]
id = "fixture"
path = "."
policies = { read = "allow", write = "allow", delete = "allow" }
`;

async function git(root: string, ...args: string[]) {
  const child = Bun.spawn(["git", "-C", root, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);
  if (code) throw new Error(stderr);
}

type Result = {
  isError?: boolean;
  content?: unknown;
  structuredContent?: unknown;
};
type Call = (name: string, args: Record<string, unknown>) => Promise<Result>;
function successful(result: Result) {
  expect(result.isError, JSON.stringify(result)).not.toBeTrue();
}

test.each([25, 26, 50])(
  "durable rename executes %i requests and publishes current membership",
  async (count) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ast-durable-moves-"));
    const storagePath = path.join(root, ".index");
    let store: LanceIntelligenceStore | undefined;
    try {
      await writeFile(path.join(root, "ast-mcp.toml"), configuration);
      await mkdir(path.join(root, "source"));
      const files: Record<
        string,
        { destination: string; expectedSha256: string }
      > = {};
      for (let index = 0; index < count; index++) {
        const source = path.join(root, "source", `file${index}.ts`);
        const content = `export const marker${index} = ${index};\n`;
        await writeFile(source, content);
        files[source] = {
          destination: path.join(
            root,
            "nested",
            "destination",
            `file${index}.ts`,
          ),
          expectedSha256: sha256(content),
        };
      }
      await git(root, "init", "-b", "main");
      await git(root, "add", ".");
      await git(root, "commit", "-m", "fixture");
      const workspace = await new WorkspaceRegistry().open({
        configurationGeneration: 1,
        directory: root,
        storage: { kind: "explicit", path: storagePath },
      });
      store = await LanceIntelligenceStore.open(workspace.storageDomain);
      const initial = await withWorkspaceContext(workspace, () =>
        refreshMutationIntelligence({ store: store!, workspace }),
      );
      const lifecycle = new LanceMutationLifecycle(store, workspace);
      const handlers = new Map<string, (args: never) => Promise<Result>>();
      registerLifecycleTools(
        {
          registerTool(
            name: string,
            _definition: unknown,
            handler: (args: never) => Promise<Result>,
          ) {
            handlers.set(name, handler);
          },
        } as never,
        async (_args, operation) =>
          withConfig(hermeticConfig(root), () =>
            withWorkspaceContext(workspace, () =>
              withMutationLifecycle(lifecycle, operation),
            ),
          ),
      );
      const call: Call = (name, args) => handlers.get(name)!(args as never);
      successful(await call("file_rename", { files }));
      for (const [source, request] of Object.entries(files)) {
        expect(await Bun.file(source).exists()).toBe(false);
        expect(await readFile(request.destination, "utf8")).toContain(
          "export const marker",
        );
      }
      expect(
        (await readdir(path.join(root, "nested", "destination"))).sort(),
      ).toEqual(
        Object.values(files)
          .map((item) => path.basename(item.destination))
          .sort(),
      );
      const moved = await store.latestGeneration(workspace.workspaceId);
      expect(moved?.generationId).not.toBe(initial.generationId);
      async function members() {
        const generation = await store!.latestGeneration(workspace.workspaceId);
        expect(generation).not.toBeNull();
        const manifest = (await store!.rows("revision_manifests")).find(
          (row) => row.artifact_id === generation!.manifestArtifactId,
        );
        return (
          JSON.parse(String(manifest!.payload_json)) as {
            entries: Array<{ path: string }>;
          }
        ).entries.map((entry) => entry.path);
      }
      const movedMembers = await members();
      for (const request of Object.values(files))
        expect(movedMembers).toContain(
          path.relative(root, request.destination).split(path.sep).join("/"),
        );
      expect(movedMembers.some((member) => member.startsWith("source/"))).toBe(
        false,
      );
      const deleting = Object.fromEntries(
        Object.values(files).map((request) => [
          request.destination,
          { expectedSha256: request.expectedSha256 },
        ]),
      );
      successful(await call("file_delete", { files: deleting }));
      const deletedMembers = await members();
      expect(
        deletedMembers.some((member) =>
          member.startsWith("nested/destination/"),
        ),
      ).toBe(false);
      expect(
        await lifecycle.journal.unfinished(
          workspace.workspaceId,
          workspace.checkoutRoot,
        ),
      ).toHaveLength(0);
    } finally {
      await store?.shutdownCoordinator();
      await rm(root, { force: true, recursive: true });
    }
  },
  120_000,
);

async function exercise(call: Call, root: string) {
  const source = path.join(root, "source.txt");
  const destination = path.join(root, "nested", "moved.txt");
  const content = "transport mutation\n";
  await writeFile(source, content);
  successful(
    await call("file_rename", {
      files: { [source]: { destination, expectedSha256: sha256(content) } },
    }),
  );
  expect(await Bun.file(source).exists()).toBe(false);
  expect(await readFile(destination, "utf8")).toBe(content);
  successful(
    await call("file_delete", {
      files: { [destination]: { expectedSha256: sha256(content) } },
    }),
  );
  expect(await Bun.file(destination).exists()).toBe(false);
  await writeFile(source, content);
  const sources = Array.from({ length: 51 }, (_, index) =>
    index === 0 ? source : path.join(root, `batch${index}.txt`),
  );
  await Promise.all(sources.map((file) => writeFile(file, content)));
  const oversized = Object.fromEntries(
    sources.map((file, index) => [
      file,
      {
        destination: path.join(root, "rejected", `file${index}.txt`),
        expectedSha256: sha256(content),
      },
    ]),
  );
  let rejection: unknown;
  try {
    const result = await call("file_rename", { files: oversized });
    if (result.isError) rejection = result;
  } catch (error) {
    rejection = String(error);
  }
  expect(rejection).toBeDefined();
  expect(JSON.stringify(rejection)).toContain("50");
  for (const file of sources)
    expect(await readFile(file, "utf8")).toBe(content);
  expect(
    await Bun.file(path.join(root, "rejected", "file0.txt")).exists(),
  ).toBe(false);
}

test.each(["stdio", "cli"] as const)(
  "%s executes real move/delete contracts and rejects 51 requests",
  async (surface) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ast-mutation-stdio-"));
    const client = new Client({ name: "mutation-parity", version: "1" });
    try {
      await writeFile(path.join(root, "ast-mcp.toml"), configuration);
      const transport = new StdioClientTransport({
        command: process.execPath,
        args:
          surface === "cli"
            ? [
                path.join(repository, "bin/ast-mcp.ts"),
                "mcp",
                "--transport",
                "stdio",
              ]
            : [path.join(repository, "src/index.ts")],
        cwd: root,
        env: Object.fromEntries(
          Object.entries(process.env).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        ),
        stderr: "pipe",
      });
      await client.connect(transport);
      await exercise(
        (name, args) => client.callTool({ name, arguments: args }),
        root,
      );
    } finally {
      await client.close();
      await removeTempDirectory(root);
    }
  },
  60_000,
);

test.each(["modern", "legacy"] as const)(
  "%s HTTP executes real move/delete contracts and rejects 51 requests",
  async (surface) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ast-mutation-http-"));
    await writeFile(path.join(root, "ast-mcp.toml"), configuration);
    const server = await spawnHttpMcpProcess(
      process.execPath,
      [path.join(repository, "bin/ast-mcp.ts"), "mcp"],
      { cwd: root, env: { ...process.env } },
    );
    const version = surface === "modern" ? "2026-07-28" : "2025-06-18";
    let session: string | null = null;
    let id = 0;
    const request = async (method: string, params: Record<string, unknown>) => {
      const response = await fetch(server.url, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "mcp-protocol-version": version,
          "mcp-method": method,
          ...(surface === "modern" && typeof params.name === "string"
            ? { "mcp-name": params.name }
            : {}),
          ...(session ? { "mcp-session-id": session } : {}),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: ++id,
          method,
          params:
            surface === "modern"
              ? {
                  ...params,
                  _meta: {
                    "io.modelcontextprotocol/protocolVersion": version,
                    "io.modelcontextprotocol/clientInfo": {
                      name: "mutation-parity",
                      version: "1",
                    },
                    "io.modelcontextprotocol/clientCapabilities": {},
                  },
                }
              : params,
        }),
      });
      const text = await response.text();
      expect(response.status, text).toBe(200);
      if (surface === "modern")
        expect(response.headers.get("mcp-session-id")).toBeNull();
      else session ??= response.headers.get("mcp-session-id");
      const message = JSON.parse(
        text.startsWith("event:") || text.startsWith("data:")
          ? text
              .split("\n")
              .find((line) => line.startsWith("data:"))!
              .slice(5)
          : text,
      );
      if (message.error)
        return { isError: true, content: message.error } as Result;
      return message.result as Result;
    };
    try {
      if (surface === "legacy") {
        await request("initialize", {
          capabilities: {},
          clientInfo: { name: "mutation-parity", version: "1" },
          protocolVersion: version,
        });
        expect(session).toBeTruthy();
      } else {
        await request("server/discover", {});
      }
      let workspaceId: string | undefined;
      if (surface === "modern") {
        const opened = await request("tools/call", {
          name: "workspace_open",
          arguments: {
            directory: root,
            storage: { kind: "explicit", path: path.join(root, ".index") },
          },
        });
        successful(opened);
        workspaceId = (
          opened.structuredContent as {
            data: { workspace: { workspaceId: string } };
          }
        ).data.workspace.workspaceId;
        expect(workspaceId).toBeTruthy();
      }
      await exercise(
        (name, args) =>
          request("tools/call", {
            name,
            arguments: {
              ...args,
              ...(workspaceId
                ? { workspaceId, revision: { kind: "working" } }
                : {}),
            },
          }),
        root,
      );
    } finally {
      await server.stop();
      await removeTempDirectory(root);
    }
  },
  60_000,
);
