import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";

import { createServer } from "../../src/server";
import { createSharedNativeAdmission } from "../../src/tools/code-intelligence";

test("shared native admission queues sixteen requests and removes a cancelled head", async () => {
  const acquire = createSharedNativeAdmission();
  const admitted: number[] = [];
  const controllers = Array.from({ length: 16 }, () => new AbortController());
  const requests = controllers.map(async ({ signal }, id) => {
    const release = await acquire(signal);
    admitted.push(id);
    return release;
  });
  const first = await Promise.all(requests.slice(0, 4));
  const cancelled = requests[4]!.catch((error: unknown) => error);
  controllers[4]!.abort(new Error("Caller discarded the request"));
  expect(await cancelled).toMatchObject({ code: "aborted" });
  expect(admitted).toEqual([0, 1, 2, 3]);

  first[0]!();
  for (let id = 5; id < requests.length; id++) {
    const release = await requests[id]!;
    expect(admitted.at(-1)).toBe(id);
    expect(admitted).toHaveLength(id);
    release();
  }
  for (const release of first.slice(1)) release();
});

test("shared stdio preview receipts stay with their issuing connection", async () => {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "ast-mcp-shared-preview-")),
  );
  const nativeAdmission = createSharedNativeAdmission();
  const connections = ["issuer", "peer"].map((name) => {
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name, version: "1" });
    const server = createServer(
      {},
      { globalEnabled: async () => false },
      { launchCwd: root },
      { nativeAdmission, transport: "stdio" },
    );
    return { client, clientTransport, server, serverTransport };
  });
  const [issuer, peer] = connections.map(({ client }) => client);
  const file = path.join(root, "value.ts");
  const before = "export const value = 1;\n";
  const after = "export const value = 2;\n";
  try {
    await writeFile(
      path.join(root, "ast-mcp.toml"),
      'version = 2\n[intelligence.storage.placement]\nkind = "local"\n',
    );
    await writeFile(file, before);
    const nested = path.join(root, "nested");
    await mkdir(nested);
    const opened = await Promise.all(
      connections.map(
        async ({ client, clientTransport, server, serverTransport }) => {
          await server.connect(serverTransport);
          await client.connect(clientTransport);
          const result = await client.callTool({
            name: "workspace_open",
            arguments: { directory: root },
          });
          expect(result.isError).not.toBeTrue();
          return (
            result.structuredContent as {
              data: {
                workspace: {
                  workspaceId: string;
                  configurationGeneration: number;
                };
              };
            }
          ).data.workspace;
        },
      ),
    );
    const { workspaceId, configurationGeneration } = opened[0]!;
    expect(workspaceId).toMatch(/^workspace:v1:[a-f0-9]{64}$/);
    expect(opened[1]).toMatchObject({ workspaceId, configurationGeneration });

    const nestedWorkspace = await issuer!.callTool({
      name: "workspace_open",
      arguments: { directory: nested },
    });
    expect(
      nestedWorkspace.isError,
      JSON.stringify(nestedWorkspace.structuredContent),
    ).not.toBeTrue();
    expect(nestedWorkspace.structuredContent).toMatchObject({
      data: {
        workspace: {
          checkoutRoot: root,
          workspaceId,
          storageDomain: {
            storagePath: path.join(root, ".ast-mcp", "intelligence"),
          },
        },
      },
    });

    const nativeReads = await Promise.all(
      (
        [
          ["map", issuer],
          ["read_symbols", peer],
        ] as const
      ).map(([name, client]) =>
        client!.callTool({
          name,
          arguments: {
            workspaceId,
            paths: [file],
            ...(name === "read_symbols" ? { symbols: ["value"] } : {}),
          },
        }),
      ),
    );
    expect(nativeReads[0]).toMatchObject({
      structuredContent: { data: { schema: "ast-mcp.map.v1" } },
    });
    expect(nativeReads[1]).toMatchObject({
      structuredContent: { data: { schema: "ast-mcp.read_symbols.v1" } },
    });

    const expectedSha256 = new Bun.CryptoHasher("sha256")
      .update(before)
      .digest("hex");
    const preview = await issuer!.callTool({
      name: "file_patch",
      arguments: {
        workspaceId,
        files: {
          [file]: {
            aiderBlocks: [{ search: "value = 1", replace: "value = 2" }],
            expectedSha256,
            patchStrategy: "aider_block",
            preview: true,
          },
        },
      },
    });
    expect(preview.isError).not.toBeTrue();
    const previewReceipt = (
      preview.structuredContent as {
        data: { files: Record<string, { previewReceipt: string }> };
      }
    ).data.files[file]?.previewReceipt;
    expect(typeof previewReceipt).toBe("string");

    const commit = {
      name: "file_patch",
      arguments: {
        workspaceId,
        files: { [file]: { expectedSha256, previewReceipt } },
      },
    };
    expect(await peer!.callTool(commit)).toMatchObject({
      isError: true,
      structuredContent: {
        error: { code: "preview_receipt_session_mismatch" },
      },
    });
    expect(await Bun.file(file).text()).toBe(before);
    expect((await issuer!.callTool(commit)).isError).not.toBeTrue();
    expect(await Bun.file(file).text()).toBe(after);
  } finally {
    await Promise.allSettled(connections.map(({ client }) => client.close()));
    await Promise.allSettled(connections.map(({ server }) => server.close()));
    await rm(root, { force: true, recursive: true });
  }
});

test.skipIf(process.platform === "win32")(
  "shared sessions place global storage beside their own relative configuration",
  async () => {
    const root = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "ast-mcp-shared-global-")),
    );
    const previousConfig = process.env.XDG_CONFIG_HOME;
    const previousCache = process.env.XDG_CACHE_HOME;
    process.env.XDG_CONFIG_HOME = "settings";
    process.env.XDG_CACHE_HOME = "old-cache";
    const connections = ["first", "second"].map((name) => {
      const cwd = path.join(root, name);
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      const client = new Client({ name, version: "1" });
      const server = createServer(
        {},
        { globalEnabled: async () => false },
        { launchCwd: cwd },
        { transport: "stdio" },
      );
      return { client, clientTransport, cwd, server, serverTransport };
    });
    try {
      await Promise.all(
        connections.map(
          async ({ client, clientTransport, cwd, server, serverTransport }) => {
            const configDirectory = path.join(cwd, "settings", "ast-mcp");
            await mkdir(configDirectory, { recursive: true });
            await writeFile(
              path.join(configDirectory, "ast-mcp.toml"),
              "version = 2\n",
            );
            await writeFile(
              path.join(cwd, "value.ts"),
              "export const value = 1;\n",
            );
            await server.connect(serverTransport);
            await client.connect(clientTransport);
            const result = await client.callTool({
              name: "workspace_open",
              arguments: { directory: cwd },
            });
            expect(
              result.isError,
              JSON.stringify(result.structuredContent),
            ).not.toBeTrue();
            expect(result.structuredContent).toMatchObject({
              data: {
                workspace: {
                  checkoutRoot: cwd,
                  storageDomain: {
                    placement: { kind: "global" },
                    storagePath: path.join(configDirectory, "intelligence"),
                  },
                },
              },
            });
          },
        ),
      );
    } finally {
      await Promise.allSettled(connections.map(({ client }) => client.close()));
      await Promise.allSettled(connections.map(({ server }) => server.close()));
      if (previousConfig === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousConfig;
      if (previousCache === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = previousCache;
      await rm(root, { force: true, recursive: true });
    }
  },
);
