import { randomUUID } from "node:crypto";
import type { Connection, Table } from "@lancedb/lancedb";
import { createIdentity } from "../contracts/common.ts";
import { isRetryableLanceError, StorageError } from "./errors.ts";
import { storagePathIdentity } from "./relocation.ts";
import { assertCompatibleSchema } from "./schemas.ts";

export interface CoordinatorOptions {
  leaseDurationMs?: number;
  maxRetryAttempts?: number;
  now?: () => Date;
  onLeaseLost?: (error: unknown) => void;
  random?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export interface CoordinatorLease {
  coordinatorId: string;
  epoch: number;
  expiresAt: string;
  ownerId: string;
}

interface LeaseRow extends Record<string, unknown> {
  acquired_at: string;
  coordinator_id: string;
  epoch: number;
  heartbeat_at: string;
  in_flight_job_ids_json: string;
  last_published_generation_id: string | null;
  lease_expires_at: string;
  lease_key: string;
  owner_id: string;
  payload_json: string;
  recovered_at: string | null;
  state: string;
  storage_domain_id: string;
}

const coordinators = new Map<string, StorageCoordinator>();

const defaultSleep = (milliseconds: number) =>
  new Promise<void>((resolvePromise) => {
    setTimeout(resolvePromise, milliseconds);
  });

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export async function withLanceRetry<T>(
  operation: string,
  action: () => Promise<T>,
  options: CoordinatorOptions = {},
): Promise<T> {
  const attempts = options.maxRetryAttempts ?? 5;
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? defaultSleep;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      if (!isRetryableLanceError(error)) throw error;
      lastError = error;
      if (attempt === attempts) break;
      const delay = Math.min(250, 10 * 2 ** (attempt - 1));
      await sleep(Math.floor(delay / 2 + random() * (delay / 2)));
    }
  }
  throw new StorageError(
    "retry_exhausted",
    `LanceDB operation ${operation} exhausted ${attempts} attempts`,
    true,
    {
      attempts,
      cause: lastError instanceof Error ? lastError.message : String(lastError),
      operation,
    },
  );
}

export class StorageCoordinator {
  readonly coordinatorId: string;
  readonly ownerId: string;
  readonly storagePath: string;
  private readonly leaseDurationMs: number;
  private readonly now: () => Date;
  private readonly options: CoordinatorOptions;
  private tail: Promise<void> = Promise.resolve();
  private leaseMaintenance: Promise<void> = Promise.resolve();
  private lease: CoordinatorLease | null = null;
  private references = 1;

  private constructor(
    private readonly connection: Connection,
    readonly storageDomainId: string,
    storagePath: string,
    options: CoordinatorOptions,
  ) {
    this.storagePath = storagePathIdentity(storagePath);
    this.options = options;
    this.leaseDurationMs = options.leaseDurationMs ?? 15_000;
    this.now = options.now ?? (() => new Date());
    this.ownerId = createIdentity("coordinator", {
      nonce: randomUUID(),
      pid: process.pid,
      storagePath: this.storagePath,
    });
    this.coordinatorId = this.ownerId;
  }

  static forStorageDirectory(
    connection: Connection,
    storageDomainId: string,
    storagePath: string,
    options: CoordinatorOptions = {},
  ): StorageCoordinator {
    const canonicalPath = storagePathIdentity(storagePath);
    const existing = coordinators.get(canonicalPath);
    if (existing) {
      if (existing.storageDomainId !== storageDomainId) {
        throw new StorageError(
          "storage_unavailable",
          "One storage directory cannot represent multiple storage domains",
          false,
          { canonicalPath },
        );
      }
      existing.references += 1;
      return existing;
    }
    const coordinator = new StorageCoordinator(
      connection,
      storageDomainId,
      canonicalPath,
      options,
    );
    coordinators.set(canonicalPath, coordinator);
    return coordinator;
  }

  async exclusive<T>(
    operation: string,
    action: (lease: CoordinatorLease) => Promise<T>,
  ): Promise<T> {
    const run = this.tail.then(async () => {
      const lease = await this.acquireOrRenew();
      let heartbeatError: unknown;
      let heartbeatInFlight: Promise<void> = Promise.resolve();
      const heartbeat = setInterval(
        () => {
          heartbeatInFlight = heartbeatInFlight
            .then(() => this.fence(lease))
            .catch((error: unknown) => {
              heartbeatError ??= error;
              this.options.onLeaseLost?.(error);
            });
        },
        Math.max(10, Math.floor(this.leaseDurationMs / 3)),
      );
      try {
        const result = await withLanceRetry(
          operation,
          () => action(lease),
          this.options,
        );
        await heartbeatInFlight;
        if (heartbeatError) throw heartbeatError;
        await this.assertOwnership(lease);
        return result;
      } finally {
        clearInterval(heartbeat);
      }
    });
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async fence(expected: CoordinatorLease): Promise<void> {
    const maintenance = this.leaseMaintenance.then(() =>
      this.renewLease(expected),
    );
    this.leaseMaintenance = maintenance.then(
      () => undefined,
      () => undefined,
    );
    return maintenance;
  }

  usesConnection(connection: Connection): boolean {
    return this.connection === connection;
  }

  async release(): Promise<void> {
    if (this.references === 0) return;
    this.references -= 1;
    if (this.references > 0) return;
    try {
      await this.tail;
      const lease = this.lease;
      if (lease) {
        const table = await this.coordinatorTable();
        try {
          const now = this.now().toISOString();
          await withLanceRetry(
            "release coordinator lease",
            () =>
              table.update({
                values: {
                  heartbeat_at: now,
                  lease_expires_at: now,
                  state: "clean",
                },
                where:
                  `lease_key = 'writer' AND owner_id = ${sqlString(this.ownerId)} ` +
                  `AND epoch = ${lease.epoch}`,
              }),
            this.options,
          );
        } finally {
          table.close();
        }
      }
    } finally {
      this.lease = null;
      if (coordinators.get(this.storagePath) === this) {
        coordinators.delete(this.storagePath);
      }
      this.connection.close();
    }
  }

  private async coordinatorTable(): Promise<Table> {
    const table = await this.connection.openTable("coordinator_recovery");
    try {
      await table.checkoutLatest();
      assertCompatibleSchema("coordinator_recovery", await table.schema());
      return table;
    } catch (error) {
      table.close();
      throw error;
    }
  }

  private async acquireOrRenew(): Promise<CoordinatorLease> {
    const table = await this.coordinatorTable();
    try {
      return await this.acquireOrRenewWithTable(table);
    } finally {
      table.close();
    }
  }

  private async acquireOrRenewWithTable(
    table: Table,
  ): Promise<CoordinatorLease> {
    const observedAt = this.now();
    const rows = (await table
      .query()
      .where("lease_key = 'writer'")
      .limit(2)
      .toArray()) as LeaseRow[];
    if (rows.length > 1) {
      throw new StorageError(
        "coordinator_unavailable",
        "Coordinator lease table contains competing writer rows",
        true,
        { owners: rows.map((row) => row.owner_id) },
      );
    }
    const current = rows[0];
    const activeOther =
      current &&
      current.owner_id !== this.ownerId &&
      Date.parse(current.lease_expires_at) > observedAt.getTime();
    if (activeOther) {
      throw new StorageError(
        "coordinator_unavailable",
        "Another process owns the LanceDB storage coordinator lease",
        true,
        {
          epoch: current.epoch,
          expiresAt: current.lease_expires_at,
          ownerId: current.owner_id,
        },
      );
    }
    if (
      current?.owner_id === this.ownerId &&
      Date.parse(current.lease_expires_at) - observedAt.getTime() >
        this.leaseDurationMs / 2
    ) {
      const lease = {
        coordinatorId: current.coordinator_id,
        epoch: Number(current.epoch),
        expiresAt: current.lease_expires_at,
        ownerId: current.owner_id,
      };
      this.lease = lease;
      return lease;
    }

    const epoch =
      current?.owner_id === this.ownerId
        ? Number(current.epoch)
        : Number(current?.epoch ?? 0) + 1;
    const expiresAt = new Date(
      observedAt.getTime() + this.leaseDurationMs,
    ).toISOString();
    const candidate: LeaseRow = {
      acquired_at:
        current?.owner_id === this.ownerId
          ? current.acquired_at
          : observedAt.toISOString(),
      coordinator_id: this.coordinatorId,
      epoch,
      heartbeat_at: observedAt.toISOString(),
      in_flight_job_ids_json: current?.in_flight_job_ids_json ?? "[]",
      last_published_generation_id:
        current?.last_published_generation_id ?? null,
      lease_expires_at: expiresAt,
      lease_key: "writer",
      owner_id: this.ownerId,
      payload_json: JSON.stringify({ pid: process.pid }),
      recovered_at: current?.recovered_at ?? null,
      state: "clean",
      storage_domain_id: this.storageDomainId,
    };
    await withLanceRetry(
      "acquire coordinator lease",
      () =>
        table
          .mergeInsert("lease_key")
          .whenMatchedUpdateAll({
            where:
              "target.owner_id = source.owner_id OR " +
              "target.lease_expires_at <= source.acquired_at",
          })
          .whenNotMatchedInsertAll()
          .execute([candidate], { timeoutMs: 5_000 }),
      this.options,
    );
    const lease: CoordinatorLease = {
      coordinatorId: this.coordinatorId,
      epoch,
      expiresAt,
      ownerId: this.ownerId,
    };
    await this.assertOwnership(lease);
    this.lease = lease;
    return lease;
  }

  private async renewLease(expected: CoordinatorLease): Promise<void> {
    const table = await this.coordinatorTable();
    try {
      const observedAt = this.now();
      const expiresAt = new Date(
        observedAt.getTime() + this.leaseDurationMs,
      ).toISOString();
      await withLanceRetry(
        "renew coordinator lease",
        () =>
          table.update({
            values: {
              heartbeat_at: observedAt.toISOString(),
              lease_expires_at: expiresAt,
              state: "active",
            },
            where:
              `lease_key = 'writer' AND owner_id = ${sqlString(expected.ownerId)} ` +
              `AND epoch = ${expected.epoch} AND lease_expires_at > ${sqlString(observedAt.toISOString())}`,
          }),
        this.options,
      );
      expected.expiresAt = expiresAt;
      await this.assertOwnership(expected);
      this.lease = expected;
    } finally {
      table.close();
    }
  }

  private async assertOwnership(expected: CoordinatorLease): Promise<void> {
    const table = await this.coordinatorTable();
    try {
      const rows = (await table
        .query()
        .where("lease_key = 'writer'")
        .limit(2)
        .toArray()) as LeaseRow[];
      const row = rows[0];
      if (
        rows.length !== 1 ||
        !row ||
        row.owner_id !== expected.ownerId ||
        Number(row.epoch) !== expected.epoch ||
        Date.parse(row.lease_expires_at) <= this.now().getTime()
      ) {
        this.lease = null;
        throw new StorageError(
          "coordinator_unavailable",
          "LanceDB coordinator ownership changed during a serialized operation",
          true,
          {
            actualEpoch: row?.epoch,
            actualOwnerId: row?.owner_id,
            expectedEpoch: expected.epoch,
            expectedOwnerId: expected.ownerId,
          },
        );
      }
    } finally {
      table.close();
    }
  }
}

export function clearCoordinatorRegistryForTests(): void {
  coordinators.clear();
}
