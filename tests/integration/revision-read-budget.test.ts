import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import { createRepositoryId } from "../../src/intelligence/contracts";
import {
  discoverGitWorkspace,
  readGitRevisionFile,
  resolveRevision,
} from "../../src/intelligence/workspace";
import { spawnHttpMcpProcess } from "../support/live-process";

const limit = 2 * 1024 * 1024;
const small = "export function historical() { return 1; }\n";
const repository = path.resolve(import.meta.dir, "../..");

async function fixture() {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "ast-mcp-revision-budget-"),
  );
  try {
    await writeFile(path.join(root, "large.ts"), " ".repeat(limit + 1));
    await writeFile(path.join(root, "small.ts"), small);
    await writeFile(
      path.join(root, "ast-mcp.toml"),
      "version = 2\n[telemetry]\nenabled = false\n",
    );
    for (const args of [
      ["init", "-q"],
      ["add", "."],
      [
        "-c",
        "user.name=Revision Test",
        "-c",
        "user.email=revision@example.invalid",
        "commit",
        "-qm",
        "fixture",
      ],
    ]) {
      const child = Bun.spawn(["git", "-C", root, ...args], {
        stdout: "ignore",
        stderr: "pipe",
      });
      expect(await child.exited, await new Response(child.stderr).text()).toBe(
        0,
      );
    }
    const git = await discoverGitWorkspace(root);
    return { root: git.checkoutRoot, git };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

test("commit and index reads enforce byte limits without whole-stream materialization", async () => {
  const { root, git } = await fixture();
  try {
    const repositoryId = createRepositoryId({
      canonicalGitCommonDirectory: git.commonGitDirectory!,
    });
    for (const selector of [
      { kind: "commit", oid: git.headOid! },
      { kind: "index" },
    ] as const) {
      const revision = await resolveRevision(git, repositoryId, selector);
      // Historical stdout must never use Response.bytes(), even before rejecting a large blob.
      const materialize = spyOn(Response.prototype, "bytes").mockImplementation(
        () => {
          throw new Error("Unbounded stdout materialization");
        },
      );
      try {
        await expect(
          readGitRevisionFile(
            git,
            revision,
            path.join(root, "large.ts"),
            undefined,
            limit,
          ),
        ).rejects.toMatchObject({ code: "git_output_limit_exceeded" });
        const normal = await readGitRevisionFile(
          git,
          revision,
          path.join(root, "small.ts"),
          undefined,
          Buffer.byteLength(small),
        );
        expect(Buffer.from(normal).toString("utf8")).toBe(small);
        await expect(
          readGitRevisionFile(
            git,
            revision,
            path.join(root, "missing.ts"),
            undefined,
            limit,
          ),
        ).rejects.toMatchObject({ code: "workspace_revision_invalid" });
        expect(materialize).not.toHaveBeenCalled();
      } finally {
        materialize.mockRestore();
      }
      const reason = new Error("Revision read cancelled");
      const controller = new AbortController();
      controller.abort(reason);
      await expect(
        readGitRevisionFile(
          git,
          revision,
          path.join(root, "large.ts"),
          controller.signal,
          limit,
        ),
      ).rejects.toBe(reason);

      // Deliver cancellation only after Git starts and its abort listener is attached.
      const active = new AbortController();
      const listen = active.signal.addEventListener.bind(active.signal);
      const registration = spyOn(
        active.signal,
        "addEventListener",
      ).mockImplementation((...args) => {
        listen(...args);
        active.abort(reason);
      });
      try {
        await expect(
          readGitRevisionFile(
            git,
            revision,
            path.join(root, "large.ts"),
            active.signal,
            limit,
          ),
        ).rejects.toBe(reason);
        expect(registration).toHaveBeenCalledTimes(1);
      } finally {
        registration.mockRestore();
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("buffered Git output preserves cancellation ahead of a simultaneous byte limit", async () => {
  const { root, git } = await fixture();
  try {
    const repositoryId = createRepositoryId({
      canonicalGitCommonDirectory: git.commonGitDirectory!,
    });
    for (const selector of [
      { kind: "commit", oid: git.headOid! },
      { kind: "index" },
    ] as const) {
      const revision = await resolveRevision(git, repositoryId, selector);
      const controller = new AbortController();
      const reason = new Error("Buffered revision read cancelled");
      const getReader = ReadableStream.prototype.getReader;
      let bufferedBytes = 0;
      const acquire = spyOn(
        ReadableStream.prototype,
        "getReader",
      ).mockImplementation(function (this: ReadableStream<Uint8Array>) {
        const reader = getReader.call(
          this,
        ) as ReadableStreamDefaultReader<Uint8Array>;
        const read = reader.read.bind(reader);
        reader.read = async () => {
          // Buffer the actual small Git blob to reproduce output already queued at cancellation.
          const chunks: Uint8Array[] = [];
          for (;;) {
            const chunk = await read();
            if (chunk.done) break;
            chunks.push(chunk.value);
          }
          const bytes = Buffer.concat(chunks);
          bufferedBytes = bytes.byteLength;
          controller.abort(reason);
          return { done: false, value: bytes };
        };
        return reader;
      } as typeof ReadableStream.prototype.getReader);
      try {
        await expect(
          readGitRevisionFile(
            git,
            revision,
            path.join(root, "small.ts"),
            controller.signal,
            1,
          ),
        ).rejects.toBe(reason);
        expect(bufferedBytes).toBe(Buffer.byteLength(small));
        expect(acquire).toHaveBeenCalledTimes(1);
      } finally {
        acquire.mockRestore();
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const transportKind of ["stdio", "http"] as const) {
  test(`${transportKind} historical source limits leave the MCP connection usable`, async () => {
    const { root, git } = await fixture();
    const client = new Client({ name: "revision-budget-test", version: "1" });
    let stop: (() => Promise<void>) | undefined;
    try {
      const env = {
        ...process.env,
        AST_MCP_PROJECT_ROOT: root,
        XDG_CONFIG_HOME: path.join(root, "config"),
        APPDATA: path.join(root, "config"),
      };
      if (transportKind === "stdio") {
        await client.connect(
          new StdioClientTransport({
            command: process.execPath,
            args: [path.join(repository, "bin/ast-mcp.ts"), "mcp"],
            cwd: root,
            env: env as Record<string, string>,
            stderr: "pipe",
          }),
        );
      } else {
        const server = await spawnHttpMcpProcess(
          process.execPath,
          [path.join(repository, "bin/ast-mcp.ts"), "mcp"],
          { cwd: root, env },
        );
        stop = () => server.stop();
        await client.connect(new StreamableHTTPClientTransport(server.url));
      }
      for (const revision of [
        { kind: "commit", oid: git.headOid! },
        { kind: "index" },
      ] as const) {
        const opened = await client.callTool({
          name: "workspace_open",
          arguments: {
            directory: root,
            revision,
            storage: { kind: "explicit", path: path.join(root, "storage") },
          },
        });
        expect(opened.isError, JSON.stringify(opened)).not.toBeTrue();
        const workspaceId = (
          opened.structuredContent as {
            data: { workspace: { workspaceId: string } };
          }
        ).data.workspace.workspaceId;
        const oversized = await client.callTool({
          name: "map",
          arguments: { workspaceId, paths: ["large.ts"], timeout_ms: 2_000 },
        });
        expect(oversized.isError, JSON.stringify(oversized)).toBeTrue();
        expect(JSON.stringify(oversized.structuredContent)).toContain(
          "intelligence_budget_exceeded",
        );
        const normal = await client.callTool({
          name: "map",
          arguments: { workspaceId, paths: ["small.ts"], timeout_ms: 2_000 },
        });
        expect(normal.isError, JSON.stringify(normal)).not.toBeTrue();
        expect(JSON.stringify(normal.structuredContent)).toContain(
          "historical",
        );
        expect(
          (await client.listTools()).tools.some((tool) => tool.name === "map"),
        ).toBeTrue();
      }
    } finally {
      await client.close();
      await stop?.();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
}
