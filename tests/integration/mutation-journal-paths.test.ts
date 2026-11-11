import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { connect } from "@lancedb/lancedb";
import { Field, Schema, Utf8 } from "apache-arrow";

import { createIdentity } from "../../src/intelligence/contracts/common.ts";
import { openNarrowLanceMutationJournal } from "../../src/intelligence/mutation/narrow-lance-journal.ts";
import {
  openPrivateMutationJournal,
  privateMutationJournalLocation,
} from "../../src/intelligence/mutation/private-journal.ts";
import { mutationTransactionLockPath } from "../../src/intelligence/mutation/service.ts";
import { toLanceSchema } from "../../src/intelligence/storage/arrow.ts";
import { WorkspaceRegistry } from "../../src/intelligence/workspace/index.ts";
import { resolveStorageDomain } from "../../src/intelligence/workspace/storage.ts";
import { sha256 } from "../../src/runtime/hash.ts";

async function withJournalFixture<T>(
  run: (fixture: Awaited<ReturnType<typeof journalFixture>>) => Promise<T>,
): Promise<T> {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "ast-mcp-journal-paths-")),
  );
  let sqlite: string | undefined;
  try {
    const fixture = await journalFixture(root);
    sqlite = fixture.sqlite;
    return await run(fixture);
  } finally {
    if (sqlite) {
      for (const suffix of ["", "-journal", "-wal", "-shm"])
        await rm(sqlite + suffix, { force: true, recursive: true });
    }
    await rm(root, { force: true, recursive: true });
  }
}

async function journalFixture(root: string) {
  const checkout = path.join(root, "checkout");
  await mkdir(checkout);
  const storage = { kind: "explicit" as const, path: path.join(root, "index") };
  const workspace = await new WorkspaceRegistry().open({
    configurationGeneration: 1,
    directory: checkout,
    storage,
  });
  const otherDomain = resolveStorageDomain(checkout, { kind: "local" });
  const transaction = await mutationTransactionLockPath(checkout);
  const domain = workspace.storageDomain;
  const { storagePath: sqlite } = await privateMutationJournalLocation(
    transaction,
    domain.domainId,
  );
  const tableName =
    "mutation_journal_" + sha256(JSON.stringify([checkout, domain.domainId]));
  return {
    checkout,
    domain,
    otherDomain,
    sqlite,
    tableName,
    transaction,
    workspace,
  };
}

test("SQLite rejects invalid lock identities, malformed schemas, and unsafe sidecars", async () => {
  await withJournalFixture(async ({ domain, sqlite, transaction }) => {
    const openExisting = () =>
      openPrivateMutationJournal(transaction, domain.domainId, {
        requireExisting: true,
      });
    await expect(
      privateMutationJournalLocation(transaction + ".other", domain.domainId),
    ).rejects.toThrow("mutation_journal_path_unsafe");
    await expect(openExisting()).rejects.toThrow("mutation_journal_missing");

    await writeFile(sqlite, "", { mode: 0o600 });
    await expect(openExisting()).rejects.toThrow("mutation_journal_missing");

    const first = await openPrivateMutationJournal(
      transaction,
      domain.domainId,
    );
    first.close();
    const sidecar = sqlite + "-shm";
    await mkdir(sidecar);
    await expect(openExisting()).rejects.toThrow(
      "mutation_journal_path_unsafe",
    );
    await rm(sidecar, { recursive: true });

    const database = new Database(sqlite, { create: false, strict: true });
    try {
      database.exec("PRAGMA user_version = 2");
    } finally {
      database.close();
    }
    await expect(openExisting()).rejects.toThrow(
      "mutation_journal_schema_invalid",
    );

    const repaired = new Database(sqlite, { create: false, strict: true });
    try {
      repaired.exec("PRAGMA user_version = 1");
    } finally {
      repaired.close();
    }
    const reopened = await openExisting();
    reopened.close();
  });
});

test.each(["lance", "sqlite"] as const)(
  "%s journal scopes unfinished records to the requested workspace",
  async (backend) => {
    await withJournalFixture(
      async ({ checkout, domain, otherDomain, transaction, workspace }) => {
        const opened =
          backend === "lance"
            ? await openNarrowLanceMutationJournal(domain, checkout)
            : await openPrivateMutationJournal(transaction, domain.domainId);
        const operationId = createIdentity("job", { test: backend, checkout });
        const otherOperationId = createIdentity("job", {
          test: backend,
          checkout,
          other: true,
        });
        const plan = {
          files: [],
          operationId,
          tool: "file_patch" as const,
          workspace,
        };
        try {
          expect(await opened.journal.get(operationId)).toBeNull();
          await opened.journal.begin(plan);
          await expect(
            opened.journal.begin({
              ...plan,
              operationId: otherOperationId,
              workspace: { ...workspace, storageDomain: otherDomain },
            }),
          ).rejects.toThrow(
            backend === "lance"
              ? "mutation_journal_scope_mismatch"
              : "mutation_journal_storage_domain_mismatch",
          );
          expect(
            (await opened.journal.unfinished(workspace.workspaceId)).map(
              ({ operationId }) => operationId,
            ),
          ).toEqual([operationId]);
          expect(
            await opened.journal.unfinished(
              createIdentity("workspace", { other: true }),
            ),
          ).toEqual([]);
          await opened.journal.transition(operationId, "rolled-back");
          expect(
            await opened.journal.unfinished(workspace.workspaceId),
          ).toEqual([]);
          expect(await opened.journal.get(operationId)).toMatchObject({
            state: "rolled-back",
          });
        } finally {
          opened.close();
        }
      },
    );
  },
);

test("Lance requires the enrolled table manifest and exact schema", async () => {
  await withJournalFixture(async ({ checkout, domain, tableName }) => {
    const tablePath = path.join(domain.storagePath, tableName + ".lance");
    const openExisting = () =>
      openNarrowLanceMutationJournal(domain, checkout, {
        requireExisting: true,
      });
    await expect(openExisting()).rejects.toThrow("mutation_journal_missing");
    await mkdir(domain.storagePath, { mode: 0o700 });
    await expect(openExisting()).rejects.toThrow("mutation_journal_missing");
    await mkdir(tablePath, { mode: 0o700 });
    await expect(openExisting()).rejects.toThrow("mutation_journal_missing");

    const connection = await connect(domain.storagePath);
    try {
      const malformed = await connection.createEmptyTable(
        tableName,
        toLanceSchema(
          new Schema([new Field("operation_id", new Utf8(), false)]),
        ),
      );
      malformed.close();
      if (process.platform !== "win32") await chmod(tablePath, 0o700);
      await expect(openExisting()).rejects.toThrow(
        "mutation_journal_schema_invalid",
      );
    } finally {
      connection.close();
    }
  });
});

test("Lance rejects duplicate operation rows and non-directory table entries", async () => {
  await withJournalFixture(async ({ checkout, domain, tableName }) => {
    const tablePath = path.join(domain.storagePath, tableName + ".lance");
    await mkdir(domain.storagePath, { mode: 0o700 });
    await writeFile(tablePath, "not a Lance table");
    await expect(
      openNarrowLanceMutationJournal(domain, checkout),
    ).rejects.toThrow("mutation_journal_path_unsafe");
    await rm(tablePath);

    const created = await openNarrowLanceMutationJournal(domain, checkout);
    created.close();
    expect((await stat(tablePath)).isDirectory()).toBeTrue();
    const operationId = createIdentity("job", { duplicate: checkout });
    const connection = await connect(domain.storagePath);
    try {
      const table = await connection.openTable(tableName);
      try {
        const record = {
          operation_id: operationId,
          workspace_id: "duplicate",
          active: true,
          payload: "{}",
        };
        await table.add([record, record]);
      } finally {
        table.close();
      }
      const opened = await openNarrowLanceMutationJournal(domain, checkout, {
        requireExisting: true,
      });
      try {
        await expect(opened.journal.get(operationId)).rejects.toThrow(
          "mutation_journal_duplicate",
        );
      } finally {
        opened.close();
      }
    } finally {
      connection.close();
    }
  });
});
