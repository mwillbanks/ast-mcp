import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, readdir } from "node:fs/promises";
import path from "node:path";

import { connect, type Table } from "@lancedb/lancedb";
import { Bool, Field, Schema, Utf8 } from "apache-arrow";

import { sha256 } from "../../runtime/hash.ts";
import { canonicalizePath } from "../../runtime/path-utils.ts";
import { systemAccount } from "../../runtime/private-lock-directory.ts";
import { syncDirectory } from "../../runtime/snapshot-blob.ts";
import {
  StorageDomainSchema,
  type StorageDomain,
} from "../contracts/storage.ts";
import { arrowSchemaSignature, toLanceSchema } from "../storage/arrow.ts";
import {
  assertSupportedStoragePath,
  storagePathIdentity,
} from "../storage/relocation.ts";
import { LanceMutationJournal } from "./journal.ts";

const schema = new Schema([
  new Field("operation_id", new Utf8(), false),
  new Field("workspace_id", new Utf8(), false),
  new Field("active", new Bool(), false),
  new Field("payload", new Utf8(), false),
]);

const durableLayouts = new Map<string, ReadonlySet<string>>();
const maxCachedLayouts = 8;
const maxCachedFiles = 16_384;

function sqlString(value: string): string {
  return "'" + value.replaceAll("'", "''") + "'";
}

function assertOwnedDirectory(
  metadata: Stats,
  uid: number,
  privateOnly: boolean,
) {
  if (
    !metadata.isDirectory() ||
    (process.platform !== "win32" &&
      (metadata.uid !== uid ||
        (privateOnly
          ? (metadata.mode & 0o777) !== 0o700
          : (metadata.mode & 0o022) !== 0)))
  )
    throw new Error("mutation_journal_path_unsafe");
}

async function syncJournalFile(file: string): Promise<void> {
  const handle = await open(
    file,
    (process.platform === "win32" ? constants.O_RDWR : constants.O_RDONLY) |
      constants.O_NOFOLLOW |
      constants.O_NONBLOCK,
  );
  try {
    if (!(await handle.stat()).isFile())
      throw new Error("mutation_journal_path_unsafe");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Pinned LanceDB publishes an atomic table version. Explicitly sync its local
 * files and directory entries before letting source work cross that boundary.
 * The caller holds the checkout writer lease for the whole table session.
 */
async function syncJournalTable(
  tablePath: string,
  identity: Stats,
  uid: number,
): Promise<void> {
  const before = await lstat(tablePath);
  assertOwnedDirectory(before, uid, true);
  if (before.dev !== identity.dev || before.ino !== identity.ino)
    throw new Error("mutation_journal_path_unsafe");

  const cacheKey = JSON.stringify([tablePath, identity.dev, identity.ino]);
  const previous = durableLayouts.get(cacheKey);
  const layout = new Set<string>();

  const syncNewEntries = async (directory: string): Promise<boolean> => {
    let changed = !previous?.has(directory);
    layout.add(directory);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        changed = (await syncNewEntries(entryPath)) || changed;
      } else {
        if (!entry.isFile()) throw new Error("mutation_journal_path_unsafe");
        layout.add(entryPath);
        // Dataset data and version files are immutable. The version hint is replaced.
        if (
          !previous?.has(entryPath) ||
          entry.name === "latest_version_hint.json"
        ) {
          await syncJournalFile(entryPath);
          changed = true;
        }
      }
    }
    if (changed) await syncDirectory(directory);
    return changed;
  };

  await syncNewEntries(tablePath);
  const after = await lstat(tablePath);
  assertOwnedDirectory(after, uid, true);
  if (after.dev !== identity.dev || after.ino !== identity.ino)
    throw new Error("mutation_journal_path_unsafe");

  durableLayouts.delete(cacheKey);
  if (layout.size <= maxCachedFiles) {
    if (durableLayouts.size >= maxCachedLayouts) {
      const oldest = durableLayouts.keys().next().value;
      if (oldest !== undefined) durableLayouts.delete(oldest);
    }
    durableLayouts.set(cacheKey, layout);
  }
}

async function syncStorageParents(
  storagePath: string,
  firstCreated: string,
): Promise<void> {
  const existing = path.dirname(firstCreated);
  for (let parent = storagePath; ; parent = path.dirname(parent)) {
    await syncDirectory(parent);
    if (parent === existing) return;
  }
}

/** Open the checkout's table in its existing storage domain without the index coordinator. */
export async function openNarrowLanceMutationJournal(
  domainInput: StorageDomain,
  checkoutRoot: string,
  { requireExisting = false }: { requireExisting?: boolean } = {},
): Promise<{ journal: LanceMutationJournal; close(): void }> {
  const domain = StorageDomainSchema.parse(domainInput);
  const storagePath = await assertSupportedStoragePath(domain.storagePath);
  if (
    storagePathIdentity(await canonicalizePath(storagePath)) !==
    storagePathIdentity(storagePath)
  )
    throw new Error("mutation_journal_path_unsafe");
  const root = await canonicalizePath(checkoutRoot);
  const { uid } = await systemAccount();
  const tableName =
    "mutation_journal_" + sha256(JSON.stringify([root, domain.domainId]));
  const tablePath = path.join(storagePath, tableName + ".lance");

  let firstCreated: string | undefined;
  if (!requireExisting)
    firstCreated = await mkdir(storagePath, { recursive: true, mode: 0o700 });
  const storage = await lstat(storagePath).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") throw new Error("mutation_journal_missing");
      throw error;
    },
  );
  assertOwnedDirectory(storage, uid, false);

  if (!requireExisting) {
    await mkdir(tablePath, { mode: 0o700 }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      },
    );
  }
  const identity = await lstat(tablePath).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") throw new Error("mutation_journal_missing");
      throw error;
    },
  );
  assertOwnedDirectory(identity, uid, true);
  // If the process died after creating the directory, it may have no manifest.
  // The enrollment marker is only valid after this open and sync have completed.
  const versionsPath = path.join(tablePath, "_versions");
  const versions = await lstat(versionsPath).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    },
  );
  if (versions) assertOwnedDirectory(versions, uid, false);
  const hasManifest =
    versions &&
    (await readdir(versionsPath)).some((file) => file.endsWith(".manifest"));
  if (requireExisting && !hasManifest)
    throw new Error("mutation_journal_missing");

  const connection = await connect(storagePath, { readConsistencyInterval: 0 });
  let table: Table | undefined;
  try {
    const active = hasManifest
      ? await connection.openTable(tableName)
      : await connection.createEmptyTable(tableName, toLanceSchema(schema));
    table = active;
    if (
      arrowSchemaSignature(await active.schema()) !==
      arrowSchemaSignature(schema)
    )
      throw new Error("mutation_journal_schema_invalid");
    await syncJournalTable(tablePath, identity, uid);
    if (!requireExisting)
      await syncStorageParents(storagePath, firstCreated ?? tablePath);

    const journal = new LanceMutationJournal({
      storagePath: tablePath,
      scope: { checkoutRoot: root, storageDomainId: domain.domainId },
      async getPayload(operationId) {
        const rows = await active
          .query()
          .where("operation_id = " + sqlString(operationId))
          .select(["payload"])
          .limit(2)
          .toArray();
        if (rows.length > 1) throw new Error("mutation_journal_duplicate");
        const row = rows[0];
        return row ? { payload: row.payload } : null;
      },
      async recoveryPayloads(workspaceId, checkoutRoot) {
        const filter =
          workspaceId && !checkoutRoot
            ? "active = true AND workspace_id = " + sqlString(workspaceId)
            : "active = true";
        const rows = await active
          .query()
          .where(filter)
          .select(["payload"])
          .toArray();
        return rows.map((row) => row.payload);
      },
      async writeRecord(record) {
        if (
          record.checkoutRoot !== root ||
          record.storageDomainId !== domain.domainId
        )
          throw new Error("mutation_journal_scope_mismatch");
        const recoverable = !["succeeded", "recovered", "rolled-back"].includes(
          record.state,
        );
        await active
          .mergeInsert("operation_id")
          .whenMatchedUpdateAll()
          .whenNotMatchedInsertAll()
          .useRTE(false)
          .execute([
            {
              operation_id: record.operationId,
              workspace_id: record.workspaceId,
              active: recoverable,
              payload: JSON.stringify(record),
            },
          ]);
        await syncJournalTable(tablePath, identity, uid);
      },
    });
    return {
      journal,
      close() {
        try {
          active.close();
        } finally {
          connection.close();
        }
      },
    };
  } catch (error) {
    try {
      table?.close();
    } finally {
      connection.close();
    }
    throw error;
  }
}
