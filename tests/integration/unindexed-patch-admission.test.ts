import { expect, spyOn, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  currentConfig,
  withConfig,
  withResolvedConfig,
} from "../../src/config";
import { createIdentity } from "../../src/intelligence/contracts";
import { activeMutationLifecycle } from "../../src/intelligence/mutation/lifecycle";
import {
  mutationTransactionLockPath,
  tryUnindexedPatchPublication,
} from "../../src/intelligence/mutation/service";
import { LanceIntelligenceStore } from "../../src/intelligence/storage/store";
import {
  WorkspaceRegistry,
  withWorkspaceContext,
} from "../../src/intelligence/workspace";
import { patchFiles, tryPatchWithoutAdmission } from "../../src/patch/engine";
import { sha256 } from "../../src/runtime/hash";
import {
  acquireMutationCoordination,
  canUseTemporaryMutationCoordination,
} from "../../src/runtime/mutation-coordination";
import { hermeticConfig } from "../support/hermetic-config";

const unsupported =
  process.platform !== "darwin" && process.platform !== "linux";

test.skipIf(unsupported)(
  "unindexed publication shares the checkout fence and preserves receipt and hash policy",
  async () => {
    const fixture = await mkdtemp(
      path.join(await realpath("/tmp"), "ast-mcp-atomic-patch-"),
    );
    const root = path.join(fixture, "project");
    const file = path.join(root, "source.ts");
    const original = "export const value = 1;\n";
    const updated = "export const value = 2;\n";
    try {
      await mkdir(root);
      await writeFile(
        path.join(root, "ast-mcp.toml"),
        'version = 2\n[[paths]]\nid = "project"\npath = "."\npolicies = { read = "allow", write = "allow", delete = "allow" }\n',
      );
      await writeFile(file, original);
      // The production fast path intentionally declines unknown or shared filesystems.
      if (!canUseTemporaryMutationCoordination(file)) return;
      await withConfig(hermeticConfig(root), async () => {
        const baseConfig = await currentConfig();
        const config = {
          ...baseConfig,
          formatting: { ...baseConfig.formatting, enabled: false },
          safety: {
            ...baseConfig.safety,
            mutationLock: false,
            requireHash: true,
          },
        };
        const storagePath = path.join(fixture, "index");
        const workspace = await new WorkspaceRegistry().open({
          configurationGeneration: config.generation,
          directory: root,
          storage: { kind: "explicit", path: storagePath },
        });
        await withResolvedConfig(config, () =>
          withWorkspaceContext(workspace, async () => {
            const candidate = {
              aiderBlocks: [
                { search: original.trim(), replace: updated.trim() },
              ],
              expectedSha256: sha256(original),
              patchStrategy: "aider_block" as const,
            };
            const preview = await patchFiles({
              [file]: { ...candidate, preview: true },
            });
            const result = (
              preview.files as Record<string, Record<string, unknown>>
            )[file]!;
            expect(result.previewReceipt).toBeString();
            const receipt = {
              expectedSha256: sha256(original),
              previewReceipt: String(result.previewReceipt),
            };
            const checkout = await acquireMutationCoordination(
              "checkout:" + (await mutationTransactionLockPath(root)),
            );
            try {
              expect(
                await tryPatchWithoutAdmission({ [file]: receipt }, undefined),
              ).toBeUndefined();
            } finally {
              await checkout.release();
            }
            expect(
              await withResolvedConfig(
                {
                  ...config,
                  formatting: { ...config.formatting, enabled: true },
                },
                () => tryPatchWithoutAdmission({ [file]: receipt }, undefined),
              ),
            ).toBeUndefined();

            const indexed = spyOn(
              LanceIntelligenceStore,
              "readMutationState",
            ).mockResolvedValueOnce({
              repositoryIndexed: true,
              legacyPayloads: [],
            });
            try {
              expect(
                await tryPatchWithoutAdmission({ [file]: receipt }, undefined),
              ).toBeUndefined();
              expect(indexed).toHaveBeenCalledTimes(1);
            } finally {
              indexed.mockRestore();
            }

            await expect(
              tryPatchWithoutAdmission(
                {
                  [file]: { ...receipt, expectedSha256: sha256(updated) },
                },
                undefined,
              ),
            ).rejects.toMatchObject({ code: "stale_hash" });
            expect(await readFile(file, "utf8")).toBe(original);
            const entries = (await readdir(root)).sort();
            const committed = await tryPatchWithoutAdmission(
              { [file]: receipt },
              undefined,
            );
            expect(committed).toMatchObject({
              files: {
                [file]: { receiptCommitted: true, sha256: sha256(updated) },
              },
            });
            expect(await readFile(file, "utf8")).toBe(updated);
            expect((await readdir(root)).sort()).toEqual(entries);
            expect(await readdir(fixture)).toEqual(["project"]);
            await expect(
              tryPatchWithoutAdmission({ [file]: receipt }, undefined),
            ).rejects.toMatchObject({ code: "preview_receipt_unknown" });

            const store = await LanceIntelligenceStore.open(
              workspace.storageDomain,
            );
            try {
              await store.publish({
                manifestArtifactId: createIdentity("revision-manifest", {
                  workspaceId: workspace.workspaceId,
                }),
                revisionId: workspace.selectedRevision.revisionId,
                workspaceId: workspace.workspaceId,
              });
            } finally {
              await store.shutdownCoordinator();
            }
            const fastPath = spyOn(
              { invoke: async () => "fast path" },
              "invoke",
            );
            const fallback = spyOn(
              {
                async invoke() {
                  expect(activeMutationLifecycle()).toBeDefined();
                  return "regular publication";
                },
              },
              "invoke",
            );
            await expect(
              tryUnindexedPatchPublication(file, undefined, fastPath, fallback),
            ).resolves.toBe("regular publication");
            expect(fastPath).not.toHaveBeenCalled();
            expect(fallback).toHaveBeenCalledTimes(1);
          }),
        );
      });
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  },
);
