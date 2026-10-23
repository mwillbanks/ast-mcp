import { expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { withConfig } from "../../src/config";
import { withMutationLifecycle } from "../../src/intelligence/mutation/lifecycle";
import type { MutationLifecycle } from "../../src/intelligence/mutation/types";
import { type PatchBatch, patchFiles } from "../../src/patch/engine";
import { sha256 } from "../../src/runtime/hash";
import { hermeticConfig } from "../support/hermetic-config";

const source = "before\n";
const lifecycle = (
  overrides: Partial<MutationLifecycle>,
): MutationLifecycle => ({
  begin: async () => {},
  committed: async () => {},
  complete: async () => null,
  failed: async () => {},
  rolledBack: async () => {},
  ...overrides,
});

async function fixture(operation: (files: string[]) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-receipt-retry-"));
  const files = ["first.txt", "second.txt", "alias.txt"].map((name) =>
    path.join(root, name),
  );
  await mkdir(path.join(root, ".git"));
  await writeFile(
    path.join(root, "ast-mcp.toml"),
    'version = 2\n[formatting]\nenabled = false\n[[paths]]\nid = "workspace"\npath = "."\npolicies = { read = "allow", write = "allow", delete = "allow" }\n',
  );
  await Promise.all(files.map((file) => writeFile(file, source)));
  try {
    await withConfig(hermeticConfig(root), () => operation(files));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function previews(files: string[]) {
  const result = await patchFiles(
    Object.fromEntries(
      files.map((file) => [
        file,
        {
          expectedSha256: sha256(source),
          patchStrategy: "aider_block" as const,
          aiderBlocks: [{ search: "before", replace: "after" }],
          preview: true,
        },
      ]),
    ),
  );
  const output = result.files as Record<string, Record<string, unknown>>;
  return {
    requests: Object.fromEntries(
      files.map((file) => [
        file,
        {
          expectedSha256: sha256(source),
          previewReceipt: String(output[file]!.previewReceipt),
        },
      ]),
    ) as PatchBatch,
    output,
  };
}

for (const failure of ["first commit", "later commit", "completion"] as const) {
  test(
    "receipt batch retries after verified rollback of " + failure + " failure",
    async () => {
      await fixture(async ([first, second]) => {
        const files = [first!, second!];
        const { requests } = await previews(files);
        let commits = 0;
        let rollback = 0;
        await expect(
          withMutationLifecycle(
            lifecycle({
              committed: async () => {
                commits++;
                if (
                  commits ===
                  (failure === "first commit"
                    ? 1
                    : failure === "later commit"
                      ? 2
                      : -1)
                )
                  throw new Error("injected journal commit failure");
              },
              complete: async () => {
                throw new Error("injected completion failure");
              },
              rolledBack: async () => {
                rollback++;
              },
            }),
            () => patchFiles(requests),
          ),
        ).rejects.toThrow("failure");
        expect(rollback).toBe(1);
        for (const file of files)
          expect(await readFile(file, "utf8")).toBe(source);
        await patchFiles(requests);
        for (const file of files)
          expect(await readFile(file, "utf8")).toBe("after\n");
        // Restoring identical bytes must not revive a successfully consumed token.
        await Promise.all(files.map((file) => writeFile(file, source)));
        await expect(patchFiles(requests)).rejects.toMatchObject({
          code: "preview_receipt_unknown",
        });
      });
    },
  );
}

test("all batch receipts remain reserved through mutation completion", async () => {
  await fixture(async ([first, second, alias]) => {
    const { requests } = await previews([first!, second!]);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const pending = withMutationLifecycle(
      lifecycle({
        complete: async () => {
          entered.resolve();
          await release.promise;
          return null;
        },
      }),
      () => patchFiles(requests),
    );
    await entered.promise;
    try {
      // A different path avoids waiting on the first batch's file lock.
      // The later receipt must be reserved even before its own validation.
      await expect(
        patchFiles({
          [alias!]: {
            expectedSha256: sha256(source),
            previewReceipt: requests[second!]!.previewReceipt,
          },
        }),
      ).rejects.toMatchObject({ code: "preview_receipt_reserved" });
    } finally {
      release.resolve();
      await pending;
    }
  });
});

test("preflight failures release unchanged receipt reservations", async () => {
  await fixture(async ([first, second]) => {
    const { requests } = await previews([first!]);
    await expect(
      patchFiles({
        ...requests,
        [second!]: {
          expectedSha256: "0".repeat(64),
          patchStrategy: "aider_block",
          aiderBlocks: [{ search: "before", replace: "after" }],
        },
      }),
    ).rejects.toThrow("Stale file context");
    await patchFiles(requests);
    expect(await readFile(first!, "utf8")).toBe("after\n");
  });
});

for (const uncertainty of [
  "rollback journal",
  "source changed",
  "begin journal",
] as const) {
  test("uncertain " + uncertainty + " invalidates receipts", async () => {
    await fixture(async ([first]) => {
      const { requests } = await previews([first!]);
      const hooks = lifecycle({
        begin: async () => {
          if (uncertainty === "begin journal")
            throw new Error("uncertain begin");
        },
        committed: async () => {
          if (uncertainty === "source changed")
            await writeFile(first!, "concurrent writer\n");
          throw new Error("injected commit failure");
        },
        rolledBack: async () => {
          if (uncertainty === "rollback journal")
            throw new Error("uncertain rollback journal");
        },
      });
      await expect(
        withMutationLifecycle(hooks, () => patchFiles(requests)),
      ).rejects.toThrow();
      if (uncertainty === "source changed")
        expect(await readFile(first!, "utf8")).toBe("concurrent writer\n");
      await writeFile(first!, source);
      await expect(patchFiles(requests)).rejects.toMatchObject({
        code: "preview_receipt_unknown",
      });
    });
  });
}

test("receipt expiry during journal preparation prevents replacement", async () => {
  await fixture(async ([first]) => {
    const expire: Array<() => void> = [];
    const realTimeout = globalThis.setTimeout;
    const timers = spyOn(globalThis, "setTimeout").mockImplementation(((
      callback: (...args: unknown[]) => void,
      delay?: number,
      ...args: unknown[]
    ) => {
      if (delay === 5 * 60 * 1000) expire.push(() => callback(...args));
      return realTimeout(callback, delay, ...args);
    }) as typeof setTimeout);
    let requests: PatchBatch;
    try {
      ({ requests } = await previews([first!]));
    } finally {
      timers.mockRestore();
    }
    expect(expire).toHaveLength(1);
    await expect(
      withMutationLifecycle(
        lifecycle({
          begin: async () => {
            expire[0]!();
          },
        }),
        () => patchFiles(requests),
      ),
    ).rejects.toMatchObject({ code: "preview_receipt_expired" });
    expect(await readFile(first!, "utf8")).toBe(source);
  });
});

test("released receipt reservations preserve their original expiry", async () => {
  await fixture(async ([first]) => {
    const { requests, output } = await previews([first!]);
    await expect(
      withMutationLifecycle(
        lifecycle({
          committed: async () => {
            throw new Error("retryable failure");
          },
        }),
        () => patchFiles(requests),
      ),
    ).rejects.toThrow("retryable failure");
    const clock = spyOn(Date, "now").mockReturnValue(
      Date.parse(String(output[first!]!.receiptExpiresAt)) + 1,
    );
    try {
      await expect(patchFiles(requests)).rejects.toMatchObject({
        code: "preview_receipt_expired",
      });
    } finally {
      clock.mockRestore();
    }
    expect(await readFile(first!, "utf8")).toBe(source);
  });
});
