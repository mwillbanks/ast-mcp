import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { setupPackage, type PackDescriptor } from "./catalog.ts";

const maxArchiveBytes = 16 * 1024 * 1024;

export async function verifiedPackArchive(
  url: string,
  integrity: string,
  signal: AbortSignal,
): Promise<Buffer> {
  const response = await fetch(url, { redirect: "error", signal });
  if (!response.ok || !response.body)
    throw new Error(
      `Language pack archive request failed with HTTP ${response.status}`,
    );
  const digest = createHash("sha512");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > maxArchiveBytes)
        throw new Error("Language pack archive exceeds its size budget");
      chunks.push(item.value);
      digest.update(item.value);
    }
  } finally {
    await reader.cancel();
  }
  if (digest.digest("base64") !== integrity)
    throw new Error("Language pack archive integrity mismatch");
  return Buffer.concat(chunks, size);
}

/** Install only verified local tarballs. Bun owns extraction and dependency resolution. */
export async function stagePackWithBun(
  stage: string,
  descriptor: PackDescriptor,
  signal: AbortSignal,
): Promise<string> {
  const [grammar, setup] = await Promise.all([
    verifiedPackArchive(descriptor.url, descriptor.integrity, signal),
    verifiedPackArchive(setupPackage.url, setupPackage.integrity, signal),
  ]);
  const manifest = {
    name: "ast-mcp-language-pack-stage",
    private: true,
    dependencies: {
      [descriptor.packageName]: "file:./grammar.tgz",
      [setupPackage.packageName]: "file:./setup.tgz",
    },
    overrides: { [setupPackage.packageName]: "file:./setup.tgz" },
    trustedDependencies: [],
  };
  const configPath = path.join(stage, "bunfig.toml");
  await Promise.all([
    writeFile(path.join(stage, "grammar.tgz"), grammar, { mode: 0o600 }),
    writeFile(path.join(stage, "setup.tgz"), setup, { mode: 0o600 }),
    writeFile(path.join(stage, "package.json"), JSON.stringify(manifest), {
      mode: 0o600,
    }),
    writeFile(
      configPath,
      '[install]\nregistry = "https://registry.npmjs.org"\n',
      { mode: 0o600 },
    ),
  ]);
  signal.throwIfAborted();
  const child = Bun.spawn(
    [
      process.execPath,
      "install",
      `--config=${configPath}`,
      "--offline",
      "--ignore-scripts",
      "--no-progress",
      "--backend=copyfile",
      "--linker=hoisted",
    ],
    {
      cwd: stage,
      env: {
        BUN_BE_BUN: "1",
        BUN_INSTALL_CACHE_DIR: path.join(stage, "cache"),
        XDG_CONFIG_HOME: stage,
        USERPROFILE: stage,
        ...(process.platform === "win32" && {
          SystemRoot: process.env.SystemRoot,
        }),
      },
      signal,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  const status = await child.exited;
  signal.throwIfAborted();
  if (status !== 0)
    throw new Error(
      `The scripts-disabled Bun language pack install exited with status ${status}`,
    );
  return path.join(
    stage,
    "node_modules",
    descriptor.packageName,
    descriptor.packagePath,
  );
}
