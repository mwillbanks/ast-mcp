import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { install } from "../../src/installer";
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
      if (
        path
          .basename(String(args[0]))
          .startsWith(path.basename(target) + ".endpoint-")
      )
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

test.skipIf(process.platform === "win32")(
  "endpoint updates preserve symlinks and reject dangling targets",
  async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "ast-mcp-endpoint-link-"),
    );
    const file = path.join(root, "ast-mcp.toml");
    const target = path.join(root, "shared.toml");
    try {
      await fs.writeFile(target, "version = 2\n", { mode: 0o640 });
      await fs.symlink(target, file);
      await resolveInstallerEndpoint({
        root,
        home: root,
        scope: "local",
        port: 4567,
      });
      expect((await fs.lstat(file)).isSymbolicLink()).toBe(true);
      expect((await fs.stat(target)).mode & 0o777).toBe(0o640);
      expect(await fs.readFile(target, "utf8")).toContain("port = 4567");
      await fs.unlink(target);
      await expect(
        resolveInstallerEndpoint({
          root,
          home: root,
          scope: "local",
          port: 4568,
        }),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect((await fs.lstat(file)).isSymbolicLink()).toBe(true);
      expect(
        (await fs.readdir(root)).filter((name) => name.includes(".endpoint-")),
      ).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

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
    const original = fs.stat;
    const metadata = spyOn(fs, "stat").mockImplementation(((
      ...args: Parameters<typeof fs.stat>
    ) => {
      if (path.basename(String(args[0])) === path.basename(target))
        return Promise.reject(
          Object.assign(new Error("metadata denied"), { code: "EACCES" }),
        );
      return original(...args);
    }) as typeof fs.stat);
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

test("installer preserves retryable migration conflicts", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "ast-mcp-install-conflict-"),
  );
  const home = path.join(root, "home");
  const config = path.join(root, "ast-mcp.toml");
  await mkdir(path.join(root, ".git"));
  await fs.writeFile(config, "version = 1\n");
  const actual = fs.writeFile;
  const writer = spyOn(fs, "writeFile").mockImplementation(
    async (...args: Parameters<typeof fs.writeFile>) => {
      await actual(...args);
      if (String(args[0]).includes(".config-"))
        await actual(config, "version = 1\n# concurrent approval\n");
    },
  );
  try {
    await expect(
      install({
        root,
        home,
        scope: "local",
        targets: ["codex"],
        verifyLaunch: async () => {},
      }),
    ).rejects.toMatchObject({
      code: "configuration_conflict",
      retryable: true,
    });
    expect(await readFile(config, "utf8")).toContain("concurrent approval");
  } finally {
    writer.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent installers serialize shared checkout and home state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-install-race-"));
  const home = path.join(root, "home");
  await mkdir(path.join(root, ".git"));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const common = { root, home, scope: "local" as const };
  let secondEntered = false;
  const first = install({
    ...common,
    targets: ["codex"],
    verifyLaunch: async () => {
      entered();
      await gate;
    },
  });
  let second: Promise<unknown> | undefined;
  try {
    await Promise.race([
      ready,
      first.then(() => {
        throw new Error("First installer never entered");
      }),
    ]);
    second = install({
      ...common,
      targets: ["claude"],
      verifyLaunch: async () => {
        secondEntered = true;
      },
    });
    await Bun.sleep(40);
    expect(secondEntered).toBeFalse();
    release();
    await Promise.all([first, second]);
    expect(secondEntered).toBeTrue();
    expect(
      (
        Bun.TOML.parse(
          await readFile(path.join(root, "ast-mcp.toml"), "utf8"),
        ) as Record<string, unknown>
      ).version,
    ).toBe(2);
    expect(
      (
        Bun.TOML.parse(
          await readFile(path.join(root, ".codex/config.toml"), "utf8"),
        ) as Record<string, unknown>
      ).mcp_servers,
    ).toHaveProperty("ast-mcp");
    expect(
      JSON.parse(await readFile(path.join(root, ".mcp.json"), "utf8"))
        .mcpServers,
    ).toHaveProperty("ast-mcp");
  } finally {
    release();
    await Promise.allSettled([first, ...(second ? [second] : [])]);
    await rm(root, { recursive: true, force: true });
  }
}, 15000);
