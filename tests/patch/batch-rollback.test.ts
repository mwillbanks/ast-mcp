import { expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { withConfig } from "../../src/config";
import { withMutationLifecycle } from "../../src/intelligence/mutation/lifecycle";
import { patchFiles, writeFilesSafely } from "../../src/patch/engine";
import { sha256 } from "../../src/runtime/hash";
import { withFileLock } from "../../src/runtime/locks";
import { hermeticConfig } from "../support/hermetic-config";

async function configuredRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  await mkdir(path.join(root, ".git"));
  await writeFile(
    path.join(root, "ast-mcp.toml"),
    [
      "version = 2",
      "[formatting]",
      "enabled = false",
      'fallback = "preserve"',
      "[[paths]]",
      'id = "workspace"',
      'path = "."',
      'policies = { read = "allow", write = "allow", delete = "allow" }',
      "",
    ].join("\n"),
  );
  return root;
}

test("cancelled patch and write batches roll back completed commits and remain usable", async () => {
  for (const kind of ["patch", "write"] as const) {
    const root = await configuredRoot("ast-mcp-cancel-batch-");
    const first = path.join(root, "first.txt");
    const second = path.join(root, "second.txt");
    await writeFile(first, "before\n");
    await writeFile(second, "before\n");
    const controller = new AbortController();
    const cancellation = new Error("cancelled by client");
    let rolledBack = false;
    try {
      await expect(
        withConfig(hermeticConfig(root), () =>
          withMutationLifecycle(
            {
              begin: async () => {},
              committed: async () => {
                controller.abort(cancellation);
              },
              complete: async () => null,
              failed: async () => {},
              rolledBack: async () => {
                rolledBack = true;
              },
            },
            () =>
              kind === "patch"
                ? patchFiles(
                    Object.fromEntries(
                      [first, second].map((file) => [
                        file,
                        {
                          expectedSha256: sha256("before\n"),
                          patchStrategy: "aider_block" as const,
                          aiderBlocks: [{ search: "before", replace: "after" }],
                        },
                      ]),
                    ),
                    { signal: controller.signal },
                  )
                : writeFilesSafely(
                    Object.fromEntries(
                      [first, second].map((file) => [
                        file,
                        {
                          expectedSha256: sha256("before\n"),
                          content: "after\n",
                        },
                      ]),
                    ),
                    { signal: controller.signal },
                  ),
          ),
        ),
      ).rejects.toBe(cancellation);
      expect(rolledBack).toBeTrue();
      expect(await readFile(first, "utf8")).toBe("before\n");
      expect(await readFile(second, "utf8")).toBe("before\n");
      await withConfig(hermeticConfig(root), () =>
        writeFilesSafely({
          [first]: { expectedSha256: sha256("before\n"), content: "retry\n" },
        }),
      );
      expect(await readFile(first, "utf8")).toBe("retry\n");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }
});

test("file batch lock waits honor deadlines and cancellation", async () => {
  const root = await configuredRoot("ast-mcp-batch-lock-wait-");
  const target = path.join(root, "target.txt");
  await writeFile(target, "before\n");
  let began = 0;
  let queuedRetry: Promise<void> | undefined;
  let retried = false;
  try {
    await withMutationLifecycle(
      {
        begin: async () => {
          began++;
        },
        committed: async () => {},
        complete: async () => null,
        failed: async () => {},
        rolledBack: async () => {},
      },
      () =>
        withFileLock(target, async (owner) => {
          // Advance only after the held acquisition queue checks its clock.
          let deadlineChecks = 0;
          await expect(
            withConfig(hermeticConfig(root), () =>
              writeFilesSafely(
                {
                  [target]: {
                    expectedSha256: sha256("before\n"),
                    content: "after\n",
                  },
                },
                { deadline: 2, now: () => ++deadlineChecks },
              ),
            ),
          ).rejects.toMatchObject({ code: "lock_deadline" });
          expect(deadlineChecks).toBe(2);
          const controller = new AbortController();
          let cancellationChecks = 0;
          await expect(
            withConfig(hermeticConfig(root), () =>
              patchFiles(
                {
                  [target]: {
                    expectedSha256: sha256("before\n"),
                    patchStrategy: "aider_block",
                    aiderBlocks: [{ search: "before", replace: "after" }],
                  },
                },
                {
                  signal: controller.signal,
                  now: () => {
                    if (++cancellationChecks === 2) controller.abort();
                    return Date.now();
                  },
                },
              ),
            ),
          ).rejects.toMatchObject({ code: "lock_aborted" });
          expect(cancellationChecks).toBe(2);
          expect(began).toBe(0);
          await owner.fence();
          let observeWait!: () => void;
          const observedWait = new Promise<void>((resolve) => {
            observeWait = resolve;
          });
          let retryChecks = 0;
          queuedRetry = withFileLock(
            target,
            async (lease) => {
              retried = true;
              await lease.fence();
            },
            {
              deadline: Date.now() + 2000,
              now: () => {
                if (++retryChecks === 3) observeWait();
                return Date.now();
              },
            },
          );
          await Promise.race([
            observedWait,
            queuedRetry.then(() => {
              throw new Error("Contender bypassed the held queue");
            }),
          ]);
          expect(retried).toBeFalse();
          await owner.fence();
        }),
    );
    await queuedRetry;
    expect(retried).toBeTrue();
    expect(await readFile(target, "utf8")).toBe("before\n");
    await withConfig(hermeticConfig(root), () =>
      writeFilesSafely({
        [target]: { expectedSha256: sha256("before\n"), content: "retry\n" },
      }),
    );
    expect(await readFile(target, "utf8")).toBe("retry\n");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("batch preflight cleans preview receipts when a later entry fails", async () => {
  const root = await configuredRoot("ast-mcp-preview-cleanup-");
  const first = path.join(root, "first.txt");
  const second = path.join(root, "second.txt");
  await writeFile(first, "first\n");
  await writeFile(second, "second\n");
  try {
    await expect(
      withConfig(hermeticConfig(root), () =>
        patchFiles({
          [first]: {
            aiderBlocks: [{ replace: "preview", search: "first" }],
            expectedSha256: sha256("first\n"),
            patchStrategy: "aider_block",
            preview: true,
          },
          [second]: {
            aiderBlocks: [{ replace: "changed", search: "second" }],
            expectedSha256: "0".repeat(64),
            patchStrategy: "aider_block",
          },
        }),
      ),
    ).rejects.toThrow("Stale file context");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("patch and write batches roll back earlier commits after a commit-time source change", async () => {
  const root = await configuredRoot("ast-mcp-batch-rollback-");
  const first = path.join(root, "first.txt");
  const blocked = path.join(root, "blocked");
  const second = path.join(blocked, "second.deny");
  const created = path.join(root, "created.txt");
  await mkdir(blocked);
  await writeFile(first, "first-before\n");
  await writeFile(second, "second-before\n");
  const firstMode = (await stat(first)).mode & 0o777;
  const formatter = path.join(root, "formatter.mjs");
  await writeFile(
    formatter,
    'let input = ""; for await (const chunk of process.stdin) input += chunk; await Bun.write(process.argv[2], input); process.stdout.write(input);',
  );
  await writeFile(
    path.join(root, "ast-mcp.toml"),
    [
      "version = 2",
      "[formatting]",
      "enabled = true",
      'fallback = "preserve"',
      "[[formatting.formatters]]",
      'id = "change-source-after-lock"',
      "enabled = true",
      'extensions = [".deny"]',
      `command = ${JSON.stringify(process.execPath)}`,
      `args = ${JSON.stringify([formatter, "{source_file}"])}`,
      'mode = "stdout"',
      "[[paths]]",
      'id = "workspace"',
      'path = "."',
      'policies = { read = "allow", write = "allow", delete = "allow" }',
      "",
    ].join("\n"),
  );
  try {
    await expect(
      withConfig(hermeticConfig(root), () =>
        patchFiles({
          [first]: {
            aiderBlocks: [{ replace: "first-after", search: "first-before" }],
            expectedSha256: sha256("first-before\n"),
            patchStrategy: "aider_block",
          },
          [second]: {
            aiderBlocks: [{ replace: "second-after", search: "second-before" }],
            expectedSha256: sha256("second-before\n"),
            patchStrategy: "aider_block",
          },
        }),
      ),
    ).rejects.toThrow("Stale file context");
    expect(await readFile(first, "utf8")).toBe("first-before\n");
    expect((await stat(first)).mode & 0o777).toBe(firstMode);

    await writeFile(second, "second-before\n");
    await expect(
      withConfig(hermeticConfig(root), () =>
        writeFilesSafely({
          [created]: { content: "created\n" },
          [second]: {
            content: "second-written\n",
            expectedSha256: sha256("second-before\n"),
          },
        }),
      ),
    ).rejects.toThrow("Stale file context");
    expect(
      await stat(created).then(
        () => true,
        () => false,
      ),
    ).toBeFalse();
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("write results are finalized before restrictive metadata is committed", async () => {
  const root = await configuredRoot("ast-mcp-write-finalized-");
  const target = path.join(root, "private.txt");
  try {
    const result = await withConfig(hermeticConfig(root), () =>
      writeFilesSafely({
        [target]: { chattr: { chmod: 0 }, content: "private\n" },
      }),
    );
    expect((result.files as Record<string, unknown>)[target]).toMatchObject({
      sha256: sha256("private\n"),
    });
    if (process.platform !== "win32") {
      expect((result.files as Record<string, unknown>)[target]).toMatchObject({
        chattr: { chmod: 0 },
      });
      expect((await stat(target)).mode & 0o777).toBe(0);
    }
  } finally {
    await chmod(target, 0o600).catch(() => undefined);
    await rm(root, { force: true, recursive: true });
  }
});

test("file batches preserve cancellation reasons before lock acquisition", async () => {
  const root = await configuredRoot("ast-mcp-batch-before-lock-");
  const target = path.join(root, "target.txt");
  await writeFile(target, "before\n");
  try {
    for (const kind of ["patch", "write"] as const) {
      const reason = new Error("cancelled before acquisition");
      const signal = AbortSignal.abort(reason);
      await expect(
        withConfig(hermeticConfig(root), () =>
          kind === "patch"
            ? patchFiles(
                {
                  [target]: {
                    expectedSha256: sha256("before\n"),
                    patchStrategy: "aider_block",
                    aiderBlocks: [{ search: "before", replace: "after" }],
                  },
                },
                { signal },
              )
            : writeFilesSafely(
                {
                  [target]: {
                    expectedSha256: sha256("before\n"),
                    content: "after\n",
                  },
                },
                { signal },
              ),
        ),
      ).rejects.toBe(reason);
      expect(await readFile(target, "utf8")).toBe("before\n");
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
