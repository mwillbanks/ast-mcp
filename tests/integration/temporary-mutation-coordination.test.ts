import { Database, type SQLQueryBindings } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { withConfig } from "../../src/config";
import { writeFilesSafely } from "../../src/patch/engine";
import { deleteFilesSafely } from "../../src/runtime/file-delete";
import { renameFilesSafely } from "../../src/runtime/file-rename";
import { sha256 } from "../../src/runtime/hash";
import * as linuxFileAccess from "../../src/runtime/linux-file-access";
import {
  createMacFileAccess,
  macPathHasNoAcl,
  macVolumeEnforcesOwnership,
} from "../../src/runtime/mac-file-access";
import {
  acquireMutationCoordination,
  canCreatePrivateMutationPath,
  canUseTemporaryMutationCoordination,
  createTemporaryMutationCoordinator,
} from "../../src/runtime/mutation-coordination";
import { hermeticConfig } from "../support/hermetic-config";
import { spawnLiveProcess } from "./support/live-process";

const modulePath = import.meta
  .resolve("../../src/runtime/mutation-coordination.ts");
const unsupported =
  process.platform !== "darwin" && process.platform !== "linux";
const deadlineMs = 4_000;

function ownerProcess(resource: string, hold: boolean) {
  return spawnLiveProcess(
    process.execPath,
    [
      "-e",
      `import { acquireMutationCoordination } from ${JSON.stringify(modulePath)};
const lease = await acquireMutationCoordination(${JSON.stringify(resource)});
await lease.fence();
console.log(lease.token);
${hold ? "await Bun.stdin.text();" : ""}
await lease.release();`,
    ],
    { timeoutMs: deadlineMs },
  );
}

async function coordinationDatabase() {
  return path.join(
    await realpath("/tmp"),
    `ast-mcp-coordination-${process.geteuid!()}`,
    "mutation-leases-v1.sqlite",
  );
}

async function waitForQueue(
  resource: string,
  expected: readonly number[],
  child?: ReturnType<typeof ownerProcess>,
) {
  const database = await coordinationDatabase();
  const deadline = performance.now() + deadlineMs;
  let pids: number[] = [];
  while (true) {
    // A fresh connection observes committed rows without relying on WAL notifications.
    const db = new Database(database, { readonly: true });
    try {
      pids = db
        .query<{ pid: number }, [string]>(
          "SELECT pid FROM mutation_waiters_v1 WHERE resource = ? ORDER BY sequence",
        )
        .all(resource)
        .map(({ pid }) => pid);
    } finally {
      db.close();
    }
    if (
      pids.length === expected.length &&
      pids.every((pid, i) => pid === expected[i])
    )
      return;
    if (
      (child && child.process.exitCode !== null) ||
      performance.now() >= deadline
    )
      throw new Error(
        `Expected mutation queue [${expected}], observed [${pids}]` +
          (child ? `: ${child.diagnostics()}` : ""),
      );
    await Bun.sleep(10);
  }
}

test.skipIf(unsupported)(
  "mutation ownership fences the same scope until the owner exits",
  async () => {
    const root = await mkdtemp(
      path.join(await realpath("/tmp"), "ast-mcp-coordination-test-"),
    );
    const file = path.join(root, "source.txt");
    await writeFile(file, "unchanged");
    const owner = ownerProcess(file, true);
    try {
      const token = await owner.readStdoutLine();
      await expect(
        acquireMutationCoordination(file, { tryOnly: true }),
      ).rejects.toMatchObject({ code: "lock_busy", retryable: true });
      const independent = await acquireMutationCoordination(file + ".other", {
        tryOnly: true,
      });
      try {
        await independent.fence();
      } finally {
        await independent.release();
      }
      owner.process.kill("SIGKILL");
      expect(await owner.waitForExit()).not.toBe(0);
      const recovered = await acquireMutationCoordination(file, {
        tryOnly: true,
      });
      try {
        expect(recovered.token).not.toBe(token);
        await recovered.fence();
        expect(await readdir(root)).toEqual(["source.txt"]);
      } finally {
        await recovered.release();
      }
      await expect(recovered.fence()).rejects.toMatchObject({
        code: "lock_fenced",
      });
    } finally {
      await owner.stop();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(unsupported)(
  "mutation waiters preserve FIFO and remove cancelled entries",
  async () => {
    const resource = "coordination-fifo:" + crypto.randomUUID();
    const initial = await acquireMutationCoordination(resource);
    const first = ownerProcess(resource, true);
    const cancel = new AbortController();
    let cancelled: ReturnType<typeof acquireMutationCoordination> | undefined;
    let last: ReturnType<typeof ownerProcess> | undefined;
    try {
      await waitForQueue(resource, [first.process.pid], first);
      cancelled = acquireMutationCoordination(resource, {
        signal: cancel.signal,
      });
      void cancelled.catch(() => undefined);
      await waitForQueue(resource, [first.process.pid, process.pid]);
      last = ownerProcess(resource, false);
      await waitForQueue(
        resource,
        [first.process.pid, process.pid, last.process.pid],
        last,
      );
      cancel.abort();
      await expect(cancelled).rejects.toMatchObject({
        code: "lock_aborted",
        retryable: false,
      });
      await waitForQueue(resource, [first.process.pid, last.process.pid]);
      await initial.release();
      const firstToken = await first.readStdoutLine();
      // Verify that the last waiter still queues behind the first owner.
      await waitForQueue(resource, [last.process.pid]);
      first.process.stdin.end();
      expect(await first.waitForExit()).toBe(0);
      expect(await last.readStdoutLine()).not.toBe(firstToken);
      expect(await last.waitForExit()).toBe(0);
      await waitForQueue(resource, []);
    } finally {
      cancel.abort();
      const cancelledLease = await cancelled?.catch(() => undefined);
      await cancelledLease?.release();
      await initial.release();
      await Promise.all([first.stop(), last?.stop()]);
    }
  },
  15_000,
);

test.skipIf(unsupported)(
  "private file creation, rename, and deletion do not leave source lock folders",
  async () => {
    const root = await mkdtemp(
      path.join(await realpath("/tmp"), "ast-mcp-coordination-layout-"),
    );
    const source = path.join(root, "sources", "old.txt");
    const target = path.join(root, "nested", "deeper", "new.txt");
    const content = "source\n";
    const expectedSha256 = sha256(content);
    try {
      const eligible =
        canUseTemporaryMutationCoordination(root) &&
        canCreatePrivateMutationPath(source);
      await withConfig(hermeticConfig(root), async () => {
        await writeFilesSafely({ [source]: { content } });
        await renameFilesSafely({
          [source]: { destination: target, expectedSha256 },
        });
        expect(await readFile(target, "utf8")).toBe(content);
        if (eligible)
          expect(await readdir(path.dirname(target))).toEqual(["new.txt"]);
        await deleteFilesSafely({ [target]: { expectedSha256 } });
      });

      await expect(readFile(source)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(target)).rejects.toMatchObject({ code: "ENOENT" });
      // A network/unsupported volume must keep the legacy shared protocol.
      expect((await readdir(root)).includes(".ast-mcp-mutation-locks")).toBe(
        !eligible,
      );
      if (eligible)
        expect(
          (await readdir(root, { recursive: true })).filter((entry) =>
            entry.includes(".ast-mcp-mutation-locks"),
          ),
        ).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(unsupported)(
  "temporary coordination rejects shared directories and symlinks",
  async () => {
    const root = await mkdtemp(
      path.join(await realpath("/tmp"), "ast-mcp-coordination-scope-"),
    );
    const project = path.join(root, "project");
    const file = path.join(project, "source.txt");
    const alias = path.join(root, "alias");
    try {
      await mkdir(project, { mode: 0o700 });
      await writeFile(file, "source", { mode: 0o600 });
      await symlink(file, alias);
      expect(canUseTemporaryMutationCoordination(alias)).toBe(false);
      const supported = canUseTemporaryMutationCoordination(project);
      expect(
        canUseTemporaryMutationCoordination(path.join(project, "missing")),
      ).toBe(supported);
      await chmod(project, 0o770);
      expect(canUseTemporaryMutationCoordination(file)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform !== "darwin")(
  "Darwin file checks reject explicit ACLs and inaccessible volumes",
  async () => {
    const root = await mkdtemp(
      path.join(await realpath("/tmp"), "ast-mcp-coordination-acl-"),
    );
    const file = path.join(root, "file");
    try {
      await writeFile(file, "source", { mode: 0o600 });
      expect(macVolumeEnforcesOwnership(root)).toBe(true);
      expect(macVolumeEnforcesOwnership(path.join(root, "absent"))).toBe(false);
      expect(macPathHasNoAcl(file)).toBe(true);
      const child = Bun.spawnSync(
        ["/bin/chmod", "+a", "everyone allow read", file],
        { stderr: "pipe" },
      );
      expect(child.exitCode).toBe(0);
      expect(macPathHasNoAcl(file)).toBe(false);
      expect(canUseTemporaryMutationCoordination(file)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(unsupported)(
  "expired admission never claims mutation ownership",
  async () => {
    const resource = "coordination-deadline:" + crypto.randomUUID();
    await expect(
      acquireMutationCoordination(resource, { deadline: new Date(0) }),
    ).rejects.toMatchObject({ code: "lock_deadline" });
    const controller = new AbortController();
    controller.abort();
    await expect(
      acquireMutationCoordination(resource, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "lock_aborted" });
    const lease = await acquireMutationCoordination(resource, {
      tryOnly: true,
    });
    try {
      await lease.fence();
    } finally {
      await lease.release();
    }
  },
);

test.skipIf(unsupported)(
  "a busy WAL rejects try-only claims and permits lease release after the writer exits",
  async () => {
    const resource = "coordination-busy:" + crypto.randomUUID();
    const lease = await acquireMutationCoordination(resource);
    const connection = new Database(await coordinationDatabase());
    try {
      connection.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
      try {
        await expect(
          acquireMutationCoordination(resource + ":other", { tryOnly: true }),
        ).rejects.toMatchObject({ code: "lock_busy" });
        const releasing = lease.release();
        connection.exec("ROLLBACK");
        await releasing;
      } finally {
        if (connection.inTransaction) connection.exec("ROLLBACK");
      }
      const next = await acquireMutationCoordination(resource, {
        tryOnly: true,
      });
      await next.release();
    } finally {
      connection.close();
      await lease.release();
    }
  },
);

test.skipIf(unsupported)(
  "an exited waiter does not block the next mutation claimant",
  async () => {
    const resource = "coordination-waiter-exit:" + crypto.randomUUID();
    const owner = await acquireMutationCoordination(resource);
    const waiter = ownerProcess(resource, false);
    try {
      await waitForQueue(resource, [waiter.process.pid], waiter);
      waiter.process.kill("SIGKILL");
      expect(await waiter.waitForExit()).not.toBe(0);
      await owner.release();
      const recovered = await acquireMutationCoordination(resource, {
        tryOnly: true,
      });
      try {
        await recovered.fence();
        await waitForQueue(resource, []);
      } finally {
        await recovered.release();
      }
    } finally {
      await waiter.stop();
      await owner.release();
    }
  },
);

test.skipIf(unsupported)(
  "a full queue rejects admission and retains its live owner",
  async () => {
    const resource = "coordination-capacity:" + crypto.randomUUID();
    const owner = await acquireMutationCoordination(resource);
    const connection = new Database(await coordinationDatabase());
    try {
      const seed = connection.query(
        "INSERT INTO mutation_waiters_v1 (resource, pid, token, deadline) VALUES (?, ?, ?, ?)",
      );
      const deadline = Date.now() + deadlineMs;
      connection
        .transaction(() => {
          for (let index = 0; index < 256; index++) {
            seed.run(resource, process.pid, resource + ":" + index, deadline);
          }
        })
        .immediate();
      await expect(acquireMutationCoordination(resource)).rejects.toMatchObject(
        { code: "lock_queue_full", retryable: true },
      );
      await owner.fence();
    } finally {
      connection
        .query("DELETE FROM mutation_waiters_v1 WHERE resource = ?")
        .run(resource);
      connection.close();
      await owner.release();
    }
  },
);

test("Darwin file checks fail closed when native symbols cannot be loaded", () => {
  const probe = createMacFileAccess("darwin", () => {
    throw new Error("Fixture libSystem load failure");
  });
  expect(probe.macPathHasNoAcl("/private/tmp")).toBe(false);
  expect(probe.macVolumeEnforcesOwnership("/private/tmp")).toBe(false);
});

test.skipIf(unsupported)(
  "the coordinator rejects an unsafe bootstrap and a replaced database identity",
  async () => {
    const directory = await mkdtemp(
      path.join(await realpath("/tmp"), "ast-mcp-coordinator-isolated-"),
    );
    const fixture = createTemporaryMutationCoordinator(directory);
    const account = path.join(
      directory,
      `ast-mcp-coordination-${process.geteuid!()}`,
    );
    const database = path.join(account, "mutation-leases-v1.sqlite");
    try {
      const resource = "bootstrap-write";
      await chmod(directory, 0o777);
      await expect(fixture.acquire(resource)).rejects.toMatchObject({
        code: "lock_database_unsafe",
      });
      await chmod(directory, 0o700);
      await mkdir(account, { mode: 0o755 });
      await expect(fixture.acquire(resource)).rejects.toMatchObject({
        code: "lock_database_unsafe",
      });
      await chmod(account, 0o700);
      await writeFile(database, "not a SQLite database", { mode: 0o644 });
      await expect(fixture.acquire(resource)).rejects.toMatchObject({
        code: "lock_database_unsafe",
      });
      await chmod(database, 0o600);
      await expect(fixture.acquire(resource)).rejects.toMatchObject({
        code: "SQLITE_NOTADB",
      });
      await rm(database);
      const query = Database.prototype.query;
      const rejectWal = spyOn(
        Database.prototype,
        "query",
      ).mockImplementationOnce(function <
        Return,
        Params extends SQLQueryBindings | SQLQueryBindings[],
      >(this: Database, statement: string) {
        expect(statement).toBe("PRAGMA journal_mode = WAL");
        return query.call(this, "PRAGMA journal_mode") as ReturnType<
          typeof query<Return, Params>
        >;
      });
      try {
        await expect(fixture.acquire(resource)).rejects.toMatchObject({
          code: "lock_database_unavailable",
        });
      } finally {
        rejectWal.mockRestore();
      }

      const lease = await fixture.acquire(resource);
      await chmod(account, 0o755);
      try {
        await expect(lease.fence()).rejects.toMatchObject({
          code: "lock_database_unsafe",
        });
      } finally {
        await chmod(account, 0o700);
        await lease.release();
      }

      // Renaming an open SQLite database can invalidate its connection even if
      // the original name is restored. Retire it only after releasing ownership.
      const bytes = await readFile(database);
      await rename(database, path.join(account, "retired.sqlite"));
      await writeFile(database, bytes, { mode: 0o600 });
      await expect(lease.fence()).rejects.toMatchObject({
        code: "lock_database_unsafe",
      });
    } finally {
      await fixture.close();
      await rm(directory, { force: true, recursive: true });
    }
  },
);

test.skipIf(unsupported)(
  "invalid owner records fail closed instead of allowing two writers",
  async () => {
    const resource = "coordination-invalid-pid:" + crypto.randomUUID();
    const lease = await acquireMutationCoordination(resource);
    const connection = new Database(await coordinationDatabase());
    try {
      connection
        .query("UPDATE mutation_owners_v1 SET pid = 0 WHERE resource = ?")
        .run(resource);
      await expect(
        acquireMutationCoordination(resource, { tryOnly: true }),
      ).rejects.toMatchObject({ code: "lock_record_invalid" });
      await lease.fence();
    } finally {
      connection.close();
      await lease.release();
    }
  },
);

test.skipIf(unsupported)(
  "Linux checks local filesystem types and the nearest parent's default ACL",
  async () => {
    const directory = await mkdtemp(
      path.join(await realpath("/tmp"), "ast-mcp-coordinator-mount-type-"),
    );
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    const original = fs.statfsSync;
    const filesystem = spyOn(fs, "statfsSync");
    const defaultAcl = spyOn(linuxFileAccess, "linuxDirectoryHasNoDefaultAcl");
    const umask = spyOn(process, "umask");
    try {
      // Exercise Linux selection regardless of the host that runs this suite.
      Object.defineProperty(process, "platform", {
        ...platform,
        value: "linux",
      });
      filesystem.mockReturnValueOnce({ ...original(directory), type: 0xef53 });
      expect(canUseTemporaryMutationCoordination(directory)).toBe(true);
      filesystem.mockReturnValueOnce({ ...original(directory), type: 0x6969 });
      expect(canUseTemporaryMutationCoordination(directory)).toBe(false);

      const missing = path.join(directory, "uncreated", "new.txt");
      umask.mockReturnValue(0o022);
      defaultAcl.mockReturnValueOnce(true).mockReturnValueOnce(false);
      expect(canCreatePrivateMutationPath(missing)).toBe(true);
      expect(canCreatePrivateMutationPath(missing)).toBe(false);
      expect(defaultAcl.mock.calls).toEqual([[directory], [directory]]);
      umask.mockReturnValue(0o002);
      expect(canCreatePrivateMutationPath(missing)).toBe(false);
      expect(defaultAcl).toHaveBeenCalledTimes(2);
    } finally {
      umask.mockRestore();
      defaultAcl.mockRestore();
      filesystem.mockRestore();
      Object.defineProperty(process, "platform", platform);
      await rm(directory, { force: true, recursive: true });
    }
  },
);
