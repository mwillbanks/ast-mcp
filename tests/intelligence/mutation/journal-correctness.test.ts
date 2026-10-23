import { describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createIdentity } from "../../../src/intelligence/contracts/common.ts";
import { LanceMutationJournal } from "../../../src/intelligence/mutation/journal.ts";
import type {
  MutationBatchPlan,
  MutationJournalRecord,
} from "../../../src/intelligence/mutation/types.ts";
import { LanceIntelligenceStore } from "../../../src/intelligence/storage/store.ts";
import { WorkspaceRegistry } from "../../../src/intelligence/workspace/index.ts";

type Fixture = Parameters<Parameters<typeof withJournal>[0]>[0];

async function withJournal(
  run: (fixture: {
    journal: LanceMutationJournal;
    root: string;
    store: LanceIntelligenceStore;
    workspace: Awaited<ReturnType<WorkspaceRegistry["open"]>>;
  }) => Promise<void>,
): Promise<void> {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "ast-mcp-journal-correctness-")),
  );
  const workspace = await new WorkspaceRegistry().open({
    configurationGeneration: 1,
    directory: root,
    storage: { kind: "explicit", path: path.join(root, "index") },
  });
  const store = await LanceIntelligenceStore.open(workspace.storageDomain);
  try {
    await run({
      journal: new LanceMutationJournal(store),
      root,
      store,
      workspace,
    });
  } finally {
    await store.shutdownCoordinator();
    await rm(root, { force: true, recursive: true });
  }
}

function plan(
  fixture: Fixture,
  count: number,
  tool: MutationBatchPlan["tool"] = "file_rename",
): MutationBatchPlan {
  return {
    files: Array.from({ length: count }, (_, index) => ({
      candidateSha256: "b".repeat(64),
      filePath: path.join(fixture.root, `file-${index}.ts`),
      sourceContentBase64: "YQ==",
      sourceSha256: "a".repeat(64),
    })),
    operationId: createIdentity("job", { count, tool }),
    tool,
    workspace: fixture.workspace,
  };
}

async function replacePayload(
  fixture: Fixture,
  operationId: string,
  transform: (record: MutationJournalRecord) => unknown,
): Promise<void> {
  const rows = await fixture.store.rows("jobs");
  const row = rows.find((row) => row.job_id === operationId)!;
  await fixture.store.putRows(
    "jobs",
    [
      {
        ...row,
        payload_json: JSON.stringify(
          transform(JSON.parse(String(row.payload_json))),
        ),
      },
    ],
    { immutable: false },
  );
}

describe("mutation journal correctness", () => {
  test.each([25, 26, 50])(
    "durably journals and recovers %i rename requests",
    async (requests) => {
      await withJournal(async (fixture) => {
        const batch = plan(fixture, requests * 2);
        await fixture.journal.begin(batch);
        // A new journal instance must parse the persisted source/destination pairs.
        const reopened = new LanceMutationJournal(fixture.store);
        expect((await reopened.get(batch.operationId))?.files).toHaveLength(
          requests * 2,
        );
        await reopened.committed(batch.operationId, {
          deleted: true,
          filePath: batch.files[0]!.filePath,
          sha256: "c".repeat(64),
        });
        await reopened.transition(batch.operationId, "recovery-required");
        const restored: MutationJournalRecord[] = [];
        expect(
          await reopened.recover(
            fixture.workspace.workspaceId,
            async (record) => {
              restored.push(record);
            },
            fixture.root,
          ),
        ).toEqual([batch.operationId]);
        expect(restored[0]?.files).toHaveLength(requests * 2);
        expect(restored[0]?.files[0]?.committedDeleted).toBe(true);
        expect((await reopened.get(batch.operationId))?.state).toBe(
          "recovered",
        );
      });
    },
  );

  test.each([
    "file_patch",
    "file_write",
    "file_delete",
    "file_chattr",
    "file_rename",
  ] as const)(
    "rejects oversized %s records before persistence",
    async (tool) => {
      await withJournal(async (fixture) => {
        const batch = plan(fixture, tool === "file_rename" ? 101 : 51, tool);
        await expect(fixture.journal.begin(batch)).rejects.toThrow();
        expect(await fixture.store.rows("jobs")).toEqual([]);
      });
    },
  );

  test("rejects invalid updates without replacing the durable record", async () => {
    await withJournal(async (fixture) => {
      const batch = plan(fixture, 2);
      await fixture.journal.begin(batch);
      const before = await fixture.store.rows("jobs");
      await expect(
        fixture.journal.committed(batch.operationId, {
          filePath: batch.files[0]!.filePath,
          sha256: "invalid",
        }),
      ).rejects.toThrow();
      expect(await fixture.store.rows("jobs")).toEqual(before);
    });
  });

  test("recovers historical oversized rename journals without checkoutRoot", async () => {
    await withJournal(async (fixture) => {
      const batch = plan(fixture, 100);
      await fixture.journal.begin(batch);
      await replacePayload(fixture, batch.operationId, (record) => {
        const { checkoutRoot: _checkoutRoot, ...legacy } = record;
        return legacy;
      });
      let restored = false;
      expect(
        await fixture.journal.recover(
          fixture.workspace.workspaceId,
          async (record) => {
            restored = true;
            expect(record.checkoutRoot).toBeUndefined();
            expect(record.files).toHaveLength(100);
          },
          fixture.root,
        ),
      ).toEqual([batch.operationId]);
      expect(restored).toBe(true);
    });
  });

  test("filters explicitly unrelated damaged journals before strict validation", async () => {
    await withJournal(async (fixture) => {
      const batch = plan(fixture, 2);
      await fixture.journal.begin(batch);
      await replacePayload(fixture, batch.operationId, (record) => ({
        ...record,
        checkoutRoot: path.join(fixture.root, "other-checkout"),
        files: "damaged",
        unexpected: true,
        workspaceId: createIdentity("workspace", { name: "other" }),
      }));
      const before = await fixture.store.rows("jobs");
      expect(
        await fixture.journal.unfinished(
          fixture.workspace.workspaceId,
          fixture.root,
        ),
      ).toEqual([]);
      expect(await fixture.store.rows("jobs")).toEqual(before);
      // Direct access still strictly rejects the malformed persisted record.
      await expect(fixture.journal.get(batch.operationId)).rejects.toThrow(
        "mutation_journal_malformed",
      );
    });
  });

  test.each([
    "same-workspace",
    "same-checkout",
    "damaged-version",
    "both-markers",
  ] as const)(
    "fails closed on a relevant damaged journal: %s",
    async (scope) => {
      await withJournal(async (fixture) => {
        const batch = plan(fixture, 2);
        await fixture.journal.begin(batch);
        await replacePayload(fixture, batch.operationId, (record) => ({
          ...record,
          checkoutRoot:
            scope === "same-workspace"
              ? path.join(fixture.root, "other")
              : fixture.root,
          files: "damaged",
          schemaVersion:
            scope === "damaged-version" || scope === "both-markers"
              ? "damaged"
              : record.schemaVersion,
          tool: scope === "both-markers" ? "damaged" : record.tool,
          workspaceId:
            scope === "same-workspace"
              ? record.workspaceId
              : createIdentity("workspace", { name: "older-overlay" }),
        }));
        await expect(
          fixture.journal.unfinished(
            fixture.workspace.workspaceId,
            fixture.root,
          ),
        ).rejects.toThrow("mutation_journal_malformed");
      });
    },
  );

  test("rejects both corrupted discriminators in workspace-only recovery", async () => {
    await withJournal(async (fixture) => {
      const batch = plan(fixture, 2);
      await fixture.journal.begin(batch);
      await replacePayload(fixture, batch.operationId, (record) => ({
        ...record,
        schemaVersion: "damaged",
        tool: "damaged",
      }));
      await expect(
        fixture.journal.unfinished(fixture.workspace.workspaceId),
      ).rejects.toThrow("mutation_journal_malformed");
    });
  });

  test.each(["overlap", "unknown-path", "empty", "invalid-root"] as const)(
    "fails closed on ambiguous legacy ownership: %s",
    async (damage) => {
      await withJournal(async (fixture) => {
        const batch = plan(fixture, 2);
        await fixture.journal.begin(batch);
        await replacePayload(fixture, batch.operationId, (record) => ({
          ...record,
          checkoutRoot: damage === "invalid-root" ? "../invalid" : undefined,
          files:
            damage === "empty"
              ? []
              : damage === "unknown-path"
                ? [{}]
                : record.files,
          workspaceId: createIdentity("workspace", { name: "older-overlay" }),
        }));
        await expect(
          fixture.journal.unfinished(
            fixture.workspace.workspaceId,
            fixture.root,
          ),
        ).rejects.toThrow("mutation_recovery_scope_unknown");
      });
    },
  );

  test("ignores legacy journals with complete non-overlapping paths", async () => {
    await withJournal(async (fixture) => {
      const batch = plan(fixture, 2);
      await fixture.journal.begin(batch);
      await replacePayload(fixture, batch.operationId, (record) => ({
        ...record,
        checkoutRoot: undefined,
        files: record.files.map((file) => ({
          ...file,
          filePath: path.join(
            path.dirname(fixture.root),
            "unrelated",
            path.basename(file.filePath),
          ),
        })),
        workspaceId: createIdentity("workspace", { name: "other" }),
      }));
      expect(
        await fixture.journal.unfinished(
          fixture.workspace.workspaceId,
          fixture.root,
        ),
      ).toEqual([]);
    });
  });

  test("fails closed on opaque JSON despite a different row workspace identity", async () => {
    await withJournal(async (fixture) => {
      const batch = plan(fixture, 2);
      await fixture.journal.begin(batch);
      const [row] = await fixture.store.rows("jobs");
      await fixture.store.putRows(
        "jobs",
        [
          {
            ...row!,
            payload_json: "{",
            workspace_id: createIdentity("workspace", {
              name: "older-overlay",
            }),
          },
        ],
        { immutable: false },
      );
      await expect(
        fixture.journal.unfinished(fixture.workspace.workspaceId, fixture.root),
      ).rejects.toThrow("mutation_recovery_scope_unknown");
    });
  });

  test("ignores ordinary shared-store jobs", async () => {
    await withJournal(async (fixture) => {
      const timestamp = new Date().toISOString();
      const jobId = createIdentity("job", { name: "ordinary-job" });
      await fixture.store.putJob({
        attempt: 0,
        createdAt: timestamp,
        errorCode: null,
        idempotencyKey: jobId,
        jobId,
        revisionId: fixture.workspace.selectedRevision.revisionId,
        state: "running",
        storageDomainId: fixture.workspace.storageDomain.domainId,
        type: "index-source",
        updatedAt: timestamp,
        workspaceId: fixture.workspace.workspaceId,
      });
      expect(
        await fixture.journal.unfinished(
          fixture.workspace.workspaceId,
          fixture.root,
        ),
      ).toEqual([]);
    });
  });
});
