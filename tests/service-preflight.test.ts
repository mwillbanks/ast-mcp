import { afterEach, expect, test } from "bun:test";
import { access, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { install } from "../src/installer";

const created: string[] = [];
afterEach(async () => {
  await Promise.all(
    created
      .splice(0)
      .map((folder) => rm(folder, { force: true, recursive: true })),
  );
});

async function temporary(prefix: string) {
  const folder = await mkdtemp(path.join(os.tmpdir(), prefix));
  created.push(folder);
  return folder;
}

test("service preflight rejects occupied ports before configuration mutation", async () => {
  const root = await temporary("ast-mcp-service-collision-");
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No TCP address");
  try {
    await expect(
      install({
        host: "127.0.0.1",
        platform: "linux",
        port: address.port,
        root,
        scope: "local",
        service: true,
        serviceRunner: async () => {},
        targets: ["codex"],
        transport: "http",
      }),
    ).rejects.toThrow("already in use");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await expect(access(path.join(root, "ast-mcp.toml"))).rejects.toThrow();
  await expect(access(path.join(root, ".codex/config.toml"))).rejects.toThrow();
});

test("Windows managed services fail before configuration mutation", async () => {
  const root = await temporary("ast-mcp-service-windows-");
  await expect(
    install({
      platform: "win32",
      port: 4920,
      root,
      scope: "local",
      service: true,
      targets: ["codex"],
      transport: "http",
    }),
  ).rejects.toThrow("not supported on Windows");
  await expect(access(path.join(root, "ast-mcp.toml"))).rejects.toThrow();
  await expect(access(path.join(root, ".codex/config.toml"))).rejects.toThrow();
});
