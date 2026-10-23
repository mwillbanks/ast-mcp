import { expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { withConfig } from "../../src/config";
import { toolOutputSchema } from "../../src/helpers/mcp-schema";
import { withMutationLifecycle } from "../../src/intelligence/mutation";
import * as mutationLocks from "../../src/intelligence/mutation/locks";
import * as hashes from "../../src/runtime/hash";
import registerFileTools from "../../src/tools/files";
import registerLifecycleTools from "../../src/tools/lifecycle";
import { hermeticConfig } from "../support/hermetic-config";

test.each([
  ["file_write", "hash"],
  ["file_patch", "hash"],
  ["file_rename", "hash"],
  ["file_delete", "hash"],
  ["file_write", "fence"],
] as const)(
  "%s reports affected paths for pathless rollback %s failures",
  async (tool, failureMode) => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "ast-rollback-paths-")),
    );
    const source = join(root, "source.txt");
    const destination = join(root, "destination.txt");
    await writeFile(source, "source");
    let completionAttempted = false;
    const handlers = new Map<
      string,
      (input: never) => Promise<{ structuredContent?: unknown }>
    >();
    const server = {
      registerTool(
        name: string,
        _definition: unknown,
        handler: (input: never) => Promise<{ structuredContent?: unknown }>,
      ) {
        handlers.set(name, handler);
      },
    };
    const execute = async (
      _args: unknown,
      operation: (signal?: AbortSignal) => Promise<unknown>,
    ) => withConfig(hermeticConfig(root), operation);
    registerFileTools(server as never, execute as never);
    registerLifecycleTools(server as never, execute as never);
    const originalHash = hashes.sha256File;
    const injected = spyOn(hashes, "sha256File").mockImplementation(
      async (...args) => {
        if (tool === "file_delete" && completionAttempted)
          throw new Error("SECRET rollback verification failure");
        return originalHash(...args);
      },
    );
    const originalLocks = mutationLocks.withFencedFileLocks;
    const fenced = spyOn(
      mutationLocks,
      "withFencedFileLocks",
    ).mockImplementation((paths, operation, options) =>
      originalLocks(
        paths,
        (leases) =>
          operation(
            leases.map((lease) => ({
              ...lease,
              fence: async () => {
                if (failureMode === "fence" && completionAttempted)
                  throw new Error("SECRET pathless fence failure");
                await lease.fence();
              },
            })),
          ),
        options,
      ),
    );
    try {
      const request =
        tool === "file_write"
          ? { content: "candidate", expectedSha256: hashes.sha256("source") }
          : tool === "file_patch"
            ? {
                patchStrategy: "aider_block",
                aiderBlocks: [{ search: "source", replace: "candidate" }],
                expectedSha256: hashes.sha256("source"),
              }
            : tool === "file_rename"
              ? { destination, expectedSha256: hashes.sha256("source") }
              : { expectedSha256: hashes.sha256("source") };
      const result = await withMutationLifecycle(
        {
          begin: async () => {},
          committed: async () => {},
          failed: async () => {},
          rolledBack: async () => {},
          complete: async () => {
            completionAttempted = true;
            // Change the guarded rollback source without supplying a path on the error.
            if (tool !== "file_delete" && failureMode !== "fence")
              await writeFile(
                tool === "file_rename" ? destination : source,
                "SECRET concurrent content",
              );
            throw new Error("completion failed");
          },
        },
        () => handlers.get(tool)!({ files: { [source]: request } } as never),
      );
      expect(completionAttempted).toBe(true);
      const failure = toolOutputSchema.parse(result.structuredContent);
      expect(failure.ok).toBe(false);
      const details = failure.error?.details as {
        affectedPaths: string[];
        causes: unknown[];
      };
      expect(details.affectedPaths).toContain(source);
      if (tool === "file_rename")
        expect(details.affectedPaths).toContain(destination);
      expect(details.causes.length).toBeGreaterThan(0);
      expect(JSON.stringify(failure)).not.toContain("SECRET");
      if (tool === "file_delete")
        expect(await readFile(source, "utf8")).toBe("source");
      else
        expect(
          await readFile(tool === "file_rename" ? destination : source, "utf8"),
        ).toBe(
          failureMode === "fence" ? "candidate" : "SECRET concurrent content",
        );
    } finally {
      injected.mockRestore();
      fenced.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  },
);
