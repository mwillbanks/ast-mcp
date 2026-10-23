import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { writeConfigSource } from "../../src/config/edit";
import {
  migrateConfigSource,
  writeMigratedConfig,
} from "../../src/config/migrate";
import { withConfigTransaction } from "../../src/config/transaction";
import {
  authorizeRequestedDecision,
  clearSessionApprovals,
  InputRequiredSignal,
  withApprovalContext,
} from "../../src/runtime/approval";
import { withFileLocks } from "../../src/runtime/locks";
import { privateLockDatabasePathSync } from "../../src/runtime/private-lock-directory";

const folders: string[] = [];
afterEach(async () => {
  clearSessionApprovals();
  await Promise.all(
    folders
      .splice(0)
      .map((folder) => fs.rm(folder, { recursive: true, force: true })),
  );
});
async function fixture(source = "version = 2\n") {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "ast-mcp-config-transaction-"),
  );
  folders.push(root);
  const file = path.join(root, "ast-mcp.toml");
  await fs.writeFile(file, source);
  return { root, file };
}
test("configuration commit rejects stale source and removes prepared replacement", async () => {
  const { root, file } = await fixture();
  await fs.writeFile(file, "version = 2\n# concurrent update\n");
  await expect(
    writeConfigSource(file, "version = 2\n# stale edit\n", "version = 2\n"),
  ).rejects.toMatchObject({ code: "configuration_conflict", retryable: true });
  expect(await fs.readFile(file, "utf8")).toContain("concurrent update");
  expect(
    (await fs.readdir(root)).filter((name) => name.includes(".config-")),
  ).toEqual([]);
});
test("persistent approval cannot be overwritten by an in-flight configuration edit", async () => {
  const { root } = await fixture();
  const previous = {
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    APPDATA: process.env.APPDATA,
  };
  process.env.XDG_CONFIG_HOME = root;
  process.env.APPDATA = root;
  const file = path.join(root, "ast-mcp", "ast-mcp.toml");
  await fs.mkdir(path.dirname(file), { recursive: true });
  const original = "version = 2\n";
  await fs.writeFile(file, original);
  const decision = {
    canonicalPath: path.join(root, "source.txt"),
    operation: "write" as const,
    policy: "request" as const,
    reason: "test",
    ruleId: "test",
    source: "project" as const,
    specificity: 1,
    symlinks: false,
  };
  const scope = (inputResponses?: unknown) =>
    ({
      context: { sessionId: "config-race", mcpReq: { inputResponses } },
      server: {
        server: { getClientCapabilities: () => ({ elicitation: {} }) },
      },
      tool: "file_write",
    }) as never;
  let responseKey = "";
  try {
    await withApprovalContext(scope(), async () =>
      authorizeRequestedDecision(decision, 1),
    );
  } catch (error) {
    expect(error).toBeInstanceOf(InputRequiredSignal);
    responseKey = Object.keys(
      (error as InputRequiredSignal).result.inputRequests!,
    )[0]!;
  }
  const actual = fs.writeFile;
  let approved = false;
  const writer = spyOn(fs, "writeFile").mockImplementation(
    async (...args: Parameters<typeof fs.writeFile>) => {
      await actual(...args);
      if (
        path.dirname(String(args[0])) === path.dirname(file) &&
        String(args[0]) !== file &&
        !approved
      ) {
        approved = true;
        await withApprovalContext(
          scope({
            [responseKey]: {
              action: "accept",
              content: { decision: "always_allow" },
            },
          }),
          async () => authorizeRequestedDecision(decision, 1),
        );
      }
    },
  );
  try {
    await expect(
      writeConfigSource(
        file,
        "version = 2\n[telemetry]\nenabled = false\n",
        original,
      ),
    ).rejects.toMatchObject({ code: "configuration_conflict" });
    expect(approved).toBe(true);
    const persisted = await fs.readFile(file, "utf8");
    expect(persisted).toContain("approval-");
    expect(persisted).toContain(decision.canonicalPath);
    expect(persisted).not.toContain("[telemetry]");
  } finally {
    writer.mockRestore();
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
test("configuration guard fails promptly on contention and releases after callback failure", async () => {
  const { file } = await fixture();
  withConfigTransaction(file, () =>
    expect(() => withConfigTransaction(file, () => {})).toThrow(
      expect.objectContaining({ code: "configuration_busy", retryable: true }),
    ),
  );
  const failure = new Error("commit failed");
  expect(() =>
    withConfigTransaction(file, () => {
      throw failure;
    }),
  ).toThrow(failure);
  expect(withConfigTransaction(file, () => 42)).toBe(42);
  if (process.platform !== "win32")
    expect(
      (await fs.stat(privateLockDatabasePathSync(`${file}.config-commit`)))
        .mode & 0o777,
    ).toBe(0o600);
});
test("configuration commits do not contend with their enclosing file lease", async () => {
  const { file } = await fixture();
  await withFileLocks([file], async () => {
    await writeConfigSource(
      file,
      "version = 2\n# committed under file lease\n",
      "version = 2\n",
    );
  });
  expect(await fs.readFile(file, "utf8")).toContain(
    "committed under file lease",
  );
});

test("configuration ownership recovers immediately after its process is killed", async () => {
  const { file } = await fixture();
  const modulePath = new URL("../../src/config/transaction.ts", import.meta.url)
    .pathname;
  const script = `import {withConfigTransaction} from ${JSON.stringify(modulePath)}; withConfigTransaction(${JSON.stringify(file)},()=>{console.log("ready"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);});`;
  const child = Bun.spawn([process.execPath, "-e", script], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = child.stdout.getReader();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const ready = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Lock owner never became ready")),
          3000,
        );
      }),
    ]);
    expect(new TextDecoder().decode(ready.value)).toContain("ready");
    expect(() => withConfigTransaction(file, () => {})).toThrow(
      expect.objectContaining({ code: "configuration_busy" }),
    );
    child.kill("SIGKILL");
    await child.exited;
    expect(withConfigTransaction(file, () => true)).toBe(true);
  } finally {
    clearTimeout(timeout);
    child.kill();
    await reader.cancel().catch(() => undefined);
    await child.exited;
  }
});
test("migration backup and replacement use one guarded source version", async () => {
  const original = "version = 1\n";
  const { file } = await fixture(original);
  const migration = migrateConfigSource(original, file);
  await fs.writeFile(file, original + "# changed\n");
  await expect(
    writeMigratedConfig(file, migration.source, true, original),
  ).rejects.toMatchObject({ code: "configuration_conflict" });
  expect(await Bun.file(file + ".v1.bak").exists()).toBe(false);
  await fs.writeFile(file, original);
  expect(
    await writeMigratedConfig(file, migration.source, true, original),
  ).toBe(file + ".v1.bak");
  expect(await fs.readFile(file + ".v1.bak", "utf8")).toBe(original);
  expect(await fs.readFile(file, "utf8")).toBe(migration.source);
});
