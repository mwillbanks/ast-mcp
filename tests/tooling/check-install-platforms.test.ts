import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { install } from "../../src/installer";
import { checkInstall } from "../../templates/skills/ast-mcp/scripts/check-install";

test.skipIf(process.platform === "win32")(
  "checker validates macOS service XML on every POSIX runner",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-service-&-"));
    const home = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-service-home-"));
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
    try {
      Object.defineProperty(process, "platform", {
        value: "darwin",
        configurable: true,
      });
      await install({
        root,
        home,
        platform: "darwin",
        scope: "local",
        targets: ["codex"],
        transport: "http",
        host: "127.0.0.1",
        port: 4935,
        service: true,
        serviceRunner: async () => {},
      });
      const args = [
        "--root",
        root,
        "--scope",
        "local",
        "--target",
        "codex",
        "--transport",
        "http",
        "--host",
        "127.0.0.1",
        "--port",
        "4935",
        "--service",
      ];
      expect((await checkInstall(args, home)).checks.service).toBeTrue();
      const id = new Bun.CryptoHasher("sha256")
        .update(path.resolve(root))
        .digest("hex")
        .slice(0, 12);
      const file = path.join(
        home,
        "Library/LaunchAgents",
        `com.mwillbanks.ast-mcp-${id}.plist`,
      );
      const source = await readFile(file, "utf8");
      expect(source).toContain("&amp;");
      for (const invalid of [
        source.replace(
          /<key>WorkingDirectory<\/key>/,
          "<key>OtherDirectory</key>",
        ),
        source.replace("<array>", "<array><integer>1</integer>"),
      ]) {
        await writeFile(file, invalid);
        expect((await checkInstall(args, home)).checks.service).toBeFalse();
      }
      await writeFile(file, source);
      Object.defineProperty(process, "platform", {
        value: "win32",
        configurable: true,
      });
      expect((await checkInstall(args, home)).checks.service).toBeFalse();
    } finally {
      Object.defineProperty(process, "platform", descriptor);
      await rm(root, { force: true, recursive: true });
      await rm(home, { force: true, recursive: true });
    }
  },
);

test("checker accepts source launch receipts and rejects changed receipt metadata", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-source-check-"));
  const home = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-source-home-"));
  try {
    await install({
      root,
      home,
      scope: "local",
      targets: ["codex"],
      verifyLaunch: async () => {},
    });
    const args = ["--root", root, "--scope", "local", "--target", "codex"];
    expect((await checkInstall(args, home)).checks.mcp).toBeTrue();
    const digest = new Bun.CryptoHasher("sha256")
      .update(path.resolve(root))
      .digest("hex");
    const receipt = path.join(
      home,
      ".ast-mcp/installations",
      `local-${digest}.json`,
    );
    const original = JSON.parse(await readFile(receipt, "utf8"));
    for (const change of [
      { version: 0 },
      { projectRoot: "relative" },
      { script: path.join(root, "missing.ts") },
    ]) {
      await writeFile(receipt, JSON.stringify({ ...original, ...change }));
      expect((await checkInstall(args, home)).checks.mcp).toBeFalse();
    }
    await writeFile(receipt, JSON.stringify(original));
    const config = path.join(root, ".codex/config.toml");
    const content = await readFile(config, "utf8");
    await writeFile(
      config,
      content.replace(/args = .+/, 'args = ["missing.ts", "mcp"]'),
    );
    expect((await checkInstall(args, home)).checks.mcp).toBeFalse();
  } finally {
    await rm(root, { force: true, recursive: true });
    await rm(home, { force: true, recursive: true });
  }
});
