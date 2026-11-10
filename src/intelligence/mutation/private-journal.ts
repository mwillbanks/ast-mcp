import { Database } from "bun:sqlite";
import { lstat, open } from "node:fs/promises";
import path from "node:path";

import { sha256 } from "../../runtime/hash.ts";
import {
  ensurePrivateLockDirectory,
  systemAccount,
} from "../../runtime/private-lock-directory.ts";
import { syncDirectory } from "../../runtime/snapshot-blob.ts";
import { StorageDomainIdSchema } from "../contracts/common.ts";
import { LanceMutationJournal } from "./journal.ts";

interface PayloadRow {
  payload: string;
}

async function verifyPrivateFile(
  filePath: string,
  uid: number,
  optional = false,
): Promise<number | undefined> {
  try {
    const metadata = await lstat(filePath);
    if (
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      (process.platform !== "win32" &&
        (metadata.uid !== uid || (metadata.mode & 0o777) !== 0o600))
    )
      throw new Error("mutation_journal_path_unsafe");
    return metadata.size;
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === "ENOENT")
      return undefined;
    throw error;
  }
}

export async function privateMutationJournalLocation(
  transactionPath: string,
  storageDomainId: string,
) {
  const domain = StorageDomainIdSchema.parse(storageDomainId);
  const account = await systemAccount();
  const directory = await ensurePrivateLockDirectory(account);
  const checkout = path.basename(transactionPath);
  if (
    !/^transaction-[a-f0-9]{64}$/.test(checkout) ||
    transactionPath !== path.join(directory, checkout)
  )
    throw new Error("mutation_journal_path_unsafe");

  const identity = sha256(JSON.stringify([checkout, domain]));
  const storagePath = path.join(
    directory,
    `mutation-journal-${identity}.sqlite`,
  );

  return { directory, domain, storagePath, uid: account.uid };
}

/** Open while holding the checkout's writer lease, including during recovery. */
export async function openPrivateMutationJournal(
  transactionPath: string,
  storageDomainId: string,
  {
    requireExisting = false,
    journalMode,
  }: { requireExisting?: boolean; journalMode?: "delete" | "wal" } = {},
): Promise<{ journal: LanceMutationJournal; close(): void }> {
  const { directory, domain, storagePath, uid } =
    await privateMutationJournalLocation(transactionPath, storageDomainId);
  if (!requireExisting) {
    try {
      const handle = await open(storagePath, "wx", 0o600);
      await handle.close();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  const size = await verifyPrivateFile(storagePath, uid, true);
  if (size === undefined || (requireExisting && size === 0))
    throw new Error("mutation_journal_missing");
  for (const suffix of ["-journal", "-wal", "-shm"])
    await verifyPrivateFile(storagePath + suffix, uid, true);

  const database = new Database(storagePath, { create: false, strict: true });
  try {
    database.exec("PRAGMA trusted_schema = OFF; PRAGMA synchronous = FULL");
    const requestedMode =
      journalMode ?? (requireExisting ? undefined : "delete");
    const modePragma =
      requestedMode === "wal"
        ? "PRAGMA journal_mode = WAL"
        : requestedMode === "delete"
          ? "PRAGMA journal_mode = DELETE"
          : "PRAGMA journal_mode";
    const mode = database.query<{ journal_mode: string }, []>(modePragma).get();
    const synchronous = database
      .query<{ synchronous: number }, []>("PRAGMA synchronous")
      .get();
    if (
      (mode?.journal_mode !== "delete" && mode?.journal_mode !== "wal") ||
      (requestedMode !== undefined && mode.journal_mode !== requestedMode) ||
      synchronous?.synchronous !== 2
    )
      throw new Error("mutation_journal_durability_unavailable");

    const version = database
      .query<{ user_version: number }, []>("PRAGMA user_version")
      .get()?.user_version;
    if (version === 0 && !requireExisting) {
      database.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE mutation_records (
          operation_id TEXT PRIMARY KEY NOT NULL,
          workspace_id TEXT NOT NULL,
          active INTEGER NOT NULL CHECK (active IN (0, 1)),
          payload TEXT NOT NULL
        );
        CREATE INDEX mutation_records_active
          ON mutation_records(active) WHERE active = 1;
        PRAGMA user_version = 1;
        COMMIT;
      `);
    } else if (version !== 1) {
      throw new Error("mutation_journal_schema_invalid");
    }
    if (!requireExisting) await syncDirectory(directory);

    const read = database.query<PayloadRow, [string]>(
      "SELECT payload FROM mutation_records WHERE operation_id = ?",
    );
    const recoverable = database.query<PayloadRow, []>(
      "SELECT payload FROM mutation_records WHERE active = 1",
    );
    const recoverableByWorkspace = database.query<PayloadRow, [string]>(
      "SELECT payload FROM mutation_records WHERE active = 1 AND workspace_id = ?",
    );
    const write = database.query<never, [string, string, number, string]>(`
      INSERT INTO mutation_records (operation_id, workspace_id, active, payload)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (operation_id) DO UPDATE SET
        workspace_id = excluded.workspace_id,
        active = excluded.active,
        payload = excluded.payload
    `);
    const journal = new LanceMutationJournal({
      storagePath,
      getPayload(operationId) {
        return read.get(operationId);
      },
      recoveryPayloads(workspaceId, checkoutRoot) {
        const rows =
          workspaceId && !checkoutRoot
            ? recoverableByWorkspace.all(workspaceId)
            : recoverable.all();
        return rows.map((row) => row.payload);
      },
      writeRecord(record) {
        if (record.storageDomainId !== domain)
          throw new Error("mutation_journal_storage_domain_mismatch");
        const active = !["succeeded", "recovered", "rolled-back"].includes(
          record.state,
        );
        write.run(
          record.operationId,
          record.workspaceId,
          Number(active),
          JSON.stringify(record),
        );
      },
    });
    return { journal, close: () => database.close() };
  } catch (error) {
    database.close();
    throw error;
  }
}
