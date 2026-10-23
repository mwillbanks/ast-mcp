import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  resolveInstallerEndpoint,
  updateHttpToml,
} from "../../src/installer/transport";

test("rejects invalid and ambiguous HTTP configuration before persistence", () => {
  expect(() => updateHttpToml("[http\n", { port: 4567 })).toThrow(
    "existing TOML is invalid",
  );
  expect(() => updateHttpToml("http.port = 3768\n", { port: 4567 })).toThrow(
    "dotted http.host or http.port",
  );
});

test("endpoint updates preserve concurrent configuration changes", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "ast-mcp-endpoint-race-"),
  );
  const target = path.join(root, "ast-mcp.toml");
  const original = "version = 2\n[http]\nport = 3768\n";
  const concurrent = original + "# accepted approval\n";
  await fs.writeFile(target, original);
  const writeFile = fs.writeFile;
  const staging = spyOn(fs, "writeFile").mockImplementation(
    async (...args: Parameters<typeof fs.writeFile>) => {
      await writeFile(...args);
      if (String(args[0]).startsWith(target + ".endpoint-"))
        await writeFile(target, concurrent);
    },
  );
  try {
    await expect(
      resolveInstallerEndpoint({
        root,
        home: root,
        scope: "local",
        port: 4567,
      }),
    ).rejects.toMatchObject({ code: "configuration_conflict" });
    expect(await fs.readFile(target, "utf8")).toBe(concurrent);
    expect(
      (await fs.readdir(root)).filter((name) => name.includes(".endpoint-")),
    ).toEqual([]);
  } finally {
    staging.mockRestore();
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("endpoint updates create missing configuration atomically", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "ast-mcp-endpoint-create-"),
  );
  try {
    expect(
      await resolveInstallerEndpoint({
        root,
        home: root,
        scope: "local",
        port: 4567,
      }),
    ).toMatchObject({ port: 4567 });
    expect(
      await fs.readFile(path.join(root, "ast-mcp.toml"), "utf8"),
    ).toContain("port = 4567");
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("endpoint preparation preserves permissions and propagates filesystem failures", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "ast-mcp-endpoint-errors-"),
  );
  const target = path.join(root, "ast-mcp.toml");
  await fs.writeFile(target, "version = 2\n", { mode: 0o640 });
  try {
    await resolveInstallerEndpoint({
      root,
      home: root,
      scope: "local",
      port: 4567,
    });
    if (process.platform !== "win32")
      expect((await fs.stat(target)).mode & 0o777).toBe(0o640);
    const original = fs.lstat;
    const metadata = spyOn(fs, "lstat").mockImplementation(((
      ...args: Parameters<typeof fs.lstat>
    ) => {
      if (String(args[0]) === target)
        return Promise.reject(
          Object.assign(new Error("metadata denied"), { code: "EACCES" }),
        );
      return original(...args);
    }) as typeof fs.lstat);
    try {
      await expect(
        resolveInstallerEndpoint({
          root,
          home: root,
          scope: "local",
          port: 4568,
        }),
      ).rejects.toThrow("metadata denied");
    } finally {
      metadata.mockRestore();
    }
    await fs.rm(target);
    await fs.mkdir(target);
    await expect(
      resolveInstallerEndpoint({
        root,
        home: root,
        scope: "local",
        port: 4569,
      }),
    ).rejects.toThrow();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
