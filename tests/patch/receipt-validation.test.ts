import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { withConfig } from "../../src/config";
import { patchFiles } from "../../src/patch/engine";
import { sha256 } from "../../src/runtime/hash";
import { hermeticConfig } from "../support/hermetic-config";

test("preview receipts reject a different file and elapsed validity without writes", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "ast-mcp-receipt-validation-"),
  );
  const first = path.join(root, "first.ts");
  const second = path.join(root, "second.ts");
  const source = "const value = 1;\n";
  await Promise.all([writeFile(first, source), writeFile(second, source)]);
  try {
    await withConfig(hermeticConfig(root), async () => {
      const preview = await patchFiles({
        [first]: {
          expectedSha256: sha256(source),
          patchStrategy: "aider_block",
          aiderBlocks: [{ search: "value = 1", replace: "value = 2" }],
          preview: true,
        },
      });
      const result = (preview.files as Record<string, Record<string, unknown>>)[
        first
      ]!;
      const previewReceipt = String(result.previewReceipt);
      await expect(
        patchFiles({
          [second]: { expectedSha256: sha256(source), previewReceipt },
        }),
      ).rejects.toMatchObject({ code: "preview_receipt_file_mismatch" });
      const clock = spyOn(Date, "now").mockReturnValue(
        Date.parse(String(result.receiptExpiresAt)) + 1,
      );
      try {
        await expect(
          patchFiles({
            [first]: { expectedSha256: sha256(source), previewReceipt },
          }),
        ).rejects.toMatchObject({ code: "preview_receipt_expired" });
      } finally {
        clock.mockRestore();
      }
      expect(await Bun.file(first).text()).toBe(source);
      expect(await Bun.file(second).text()).toBe(source);
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
