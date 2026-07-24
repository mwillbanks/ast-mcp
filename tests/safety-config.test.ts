import { afterEach, expect, spyOn, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { clearConfigCache, resolveConfig, withConfig } from "../src/config";
import { evaluateHook, runHook } from "../src/hook";
import { patchFiles, writeFileSafely } from "../src/patch/engine";
import { deleteFilesSafely } from "../src/runtime/file-delete";
import { renameFilesSafely } from "../src/runtime/file-rename";
import { resolveWritablePath } from "../src/runtime/paths";

const created: string[] = [];

async function project(prefix: string, config = "version = 1\n") {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  created.push(root);
  await mkdir(path.join(root, ".git"));
  await writeFile(path.join(root, "ast-mcp.toml"), config);
  clearConfigCache();
  return root;
}

afterEach(async () => {
  clearConfigCache();
  await Promise.all(
    created.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

test("safety defaults remain strict", async () => {
  const root = await project("ast-mcp-safety-defaults-");
  const config = await resolveConfig({ cwd: root, env: {} });
  expect(config.safety).toEqual({
    allowExternalRoots: false,
    followSymlinks: false,
    hook: { allowTools: [], blockTools: [], enabled: true },
    requireHash: true,
  });

  const filePath = path.join(root, "value.txt");
  await writeFile(filePath, "before");
  await expect(
    withConfig({ cwd: root, env: {} }, () =>
      writeFileSafely({ content: "after", filePath }),
    ),
  ).rejects.toThrow(/requires expectedSha256/);
  expect(await readFile(filePath, "utf8")).toBe("before");
});

test("hash enforcement can be disabled while supplied stale hashes still fail", async () => {
  const root = await project(
    "ast-mcp-safety-hash-",
    "version = 1\n[formatting]\nenabled = false\n[safety]\nrequire_hash = false\n",
  );
  const writePath = path.join(root, "write.txt");
  const patchPath = path.join(root, "patch.txt");
  const renamePath = path.join(root, "rename.txt");
  const renamedPath = path.join(root, "renamed.txt");
  const deletePath = path.join(root, "delete.txt");
  await Promise.all([
    writeFile(writePath, "before"),
    writeFile(patchPath, "before"),
    writeFile(renamePath, "rename"),
    writeFile(deletePath, "delete"),
  ]);

  await withConfig({ cwd: root, env: {} }, async () => {
    await writeFileSafely({ content: "after", filePath: writePath });
    await patchFiles({
      [patchPath]: {
        aiderBlocks: [{ replace: "after", search: "before" }],
        patchStrategy: "aider_block",
      },
    });
    await renameFilesSafely({
      [renamePath]: { destination: renamedPath },
    });
    await deleteFilesSafely({ [deletePath]: {} });
    await expect(
      writeFileSafely({
        content: "stale",
        expectedSha256: "0".repeat(64),
        filePath: writePath,
      }),
    ).rejects.toThrow(/Stale file context/);
  });

  expect(await readFile(writePath, "utf8")).toBe("after");
  expect(await readFile(patchPath, "utf8")).toBe("after");
  expect(await readFile(renamedPath, "utf8")).toBe("rename");
  expect(await Bun.file(deletePath).exists()).toBe(false);
});

test("symlink following is opt-in and remains root bounded", async () => {
  const root = await project(
    "ast-mcp-safety-symlink-",
    "version = 1\n[formatting]\nenabled = false\n",
  );
  const target = path.join(root, "target.txt");
  const link = path.join(root, "link.txt");
  await writeFile(target, "target");
  await symlink(target, link);
  await expect(
    withConfig({ cwd: root, env: {} }, () => resolveWritablePath(link)),
  ).rejects.toThrow(/Symbolic-link targets are not permitted/);

  await writeFile(
    path.join(root, "ast-mcp.toml"),
    "version = 1\n[formatting]\nenabled = false\n[safety]\nfollow_symlinks = true\nrequire_hash = false\n",
  );
  clearConfigCache();
  await withConfig({ cwd: root, env: {} }, async () => {
    expect(await resolveWritablePath(link)).toBe(await realpath(target));
    await writeFileSafely({ content: "updated", filePath: link });
  });
  expect(await readFile(target, "utf8")).toBe("updated");

  const outside = await mkdtemp(
    path.join(os.tmpdir(), "ast-mcp-safety-outside-"),
  );
  created.push(outside);
  const outsideTarget = path.join(outside, "outside.txt");
  const outsideLink = path.join(root, "outside-link.txt");
  await writeFile(outsideTarget, "outside");
  await symlink(outsideTarget, outsideLink);
  await expect(
    withConfig({ cwd: root, env: {} }, () => resolveWritablePath(outsideLink)),
  ).rejects.toThrow(/outside configured workspace roots/);
});

test("hook policy can disable, allow, and block tools with block precedence", async () => {
  const event = { tool_input: {}, tool_name: "apply_patch" };
  expect(
    evaluateHook(event, { allowTools: [], blockTools: [], enabled: false }),
  ).toEqual({ denied: false });
  expect(
    evaluateHook(event, {
      allowTools: ["apply_patch"],
      blockTools: [],
      enabled: true,
    }),
  ).toEqual({ denied: false });
  expect(
    evaluateHook(
      { tool_name: "read_file" },
      { allowTools: [], blockTools: ["read_file"], enabled: true },
    ),
  ).toEqual({
    denied: true,
    reason: "Tool read_file is blocked by ast-mcp hook policy.",
  });

  const root = await project(
    "ast-mcp-safety-hook-",
    'version = 1\n[safety.hook]\nallow_tools = ["apply_patch"]\n',
  );
  const writes: string[] = [];
  const stdout = spyOn(process.stdout, "write").mockImplementation((value) => {
    writes.push(String(value));
    return true;
  });
  try {
    expect(
      await withConfig({ cwd: root, env: {} }, () =>
        runHook(Promise.resolve(event)),
      ),
    ).toBe(0);
  } finally {
    stdout.mockRestore();
  }
  expect(writes).toEqual(["{}\n"]);
});

test("deep merges nested hook settings across global and project layers", async () => {
  const root = await project(
    "ast-mcp-safety-layers-",
    'version = 1\n[safety.hook]\nallow_tools = ["apply_patch"]\n',
  );
  const globalHome = path.join(root, "xdg");
  const globalFile = path.join(globalHome, "ast-mcp", "ast-mcp.toml");
  await mkdir(path.dirname(globalFile), { recursive: true });
  await writeFile(
    globalFile,
    'version = 1\n[safety.hook]\nenabled = false\nblock_tools = ["write"]\n',
  );
  clearConfigCache();

  const config = await resolveConfig({
    cwd: root,
    env: { XDG_CONFIG_HOME: globalHome },
    platform: "linux",
  });
  expect(config.safety.hook).toEqual({
    allowTools: ["apply_patch"],
    blockTools: ["write"],
    enabled: false,
  });
  expect(config.provenance).toMatchObject({
    "safety.hook.allow_tools": "project",
    "safety.hook.block_tools": "global",
    "safety.hook.enabled": "global",
  });
});

test("invalid safety and formatter policies produce actionable validation errors", async () => {
  const overlap = await project(
    "ast-mcp-safety-overlap-",
    'version = 1\n[safety.hook]\nallow_tools = ["write"]\nblock_tools = ["WRITE"]\n',
  );
  await expect(resolveConfig({ cwd: overlap, env: {} })).rejects.toThrow(
    /cannot be both allowed and blocked/i,
  );

  const formatter = await project(
    "ast-mcp-safety-formatter-",
    'version = 1\n[[formatting.formatters]]\ncommand = "formatter"\ntimeout_ms = 120001\n',
  );
  await expect(resolveConfig({ cwd: formatter, env: {} })).rejects.toThrow(
    /timeout_ms.*120000/i,
  );
});
