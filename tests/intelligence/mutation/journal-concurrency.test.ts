import { expect, test } from "bun:test";
import path from "node:path";

import { createIdentity } from "../../../src/intelligence/contracts/common.ts";
import { LanceMutationJournal } from "../../../src/intelligence/mutation/journal.ts";
import type { MutationJournalRecord } from "../../../src/intelligence/mutation/types.ts";
import type { LanceIntelligenceStore } from "../../../src/intelligence/storage/store.ts";

test("concurrent journal objects preserve every commit and the final transition", async () => {
  const identity = (kind: string) =>
    createIdentity(kind, { name: "journal-concurrency" });
  const files = ["left.ts", "right.ts"].map((name) => ({
    candidateSha256: "b".repeat(64),
    committedDeleted: false,
    committedSha256: null,
    filePath: path.join(process.cwd(), name),
    sourceContentBase64: "YQ==",
    sourceGid: null,
    sourceMode: null,
    sourceSha256: "a".repeat(64),
    sourceUid: null,
  }));
  const record: MutationJournalRecord = {
    attempt: 0,
    checkoutRoot: process.cwd(),
    createdAt: "2026-10-22T00:00:00.000Z",
    errorCode: null,
    files,
    operationId: identity("job"),
    revisionId: identity("revision"),
    schemaVersion: "ast-mcp.mutation-journal.v1",
    state: "running",
    storageDomainId: identity("storage-domain"),
    tool: "file_patch",
    updatedAt: "2026-10-22T00:00:00.000Z",
    workspaceId: identity("workspace"),
  };
  let payload = JSON.stringify(record);
  let failNextRead = false;
  const store = {
    storagePath: identity("journal-store"),
    async rows() {
      if (failNextRead) {
        failNextRead = false;
        throw new Error("journal read failed");
      }
      const observed = payload;
      // Force overlapping reads to observe the same state without serialization.
      await Bun.sleep(5);
      return [{ payload_json: observed }];
    },
    async putRows(_name: unknown, rows: { payload_json: string }[]) {
      payload = rows[0]!.payload_json;
    },
  } as unknown as LanceIntelligenceStore;
  const left = new LanceMutationJournal(store);
  const right = new LanceMutationJournal(store);
  await Promise.all([
    left.committed(record.operationId, {
      filePath: files[0]!.filePath,
      sha256: "b".repeat(64),
    }),
    right.committed(record.operationId, {
      filePath: files[1]!.filePath,
      sha256: "c".repeat(64),
    }),
    left.transition(record.operationId, "refreshing"),
  ]);
  const result = await left.get(record.operationId);
  expect(result?.files.map((file) => file.committedSha256)).toEqual([
    "b".repeat(64),
    "c".repeat(64),
  ]);
  expect(result?.state).toBe("refreshing");
  expect(result?.attempt).toBe(3);
  failNextRead = true;
  await expect(left.transition(record.operationId, "failed")).rejects.toThrow(
    "journal read failed",
  );
  await right.transition(record.operationId, "succeeded");
  expect((await left.get(record.operationId))?.state).toBe("succeeded");
});
