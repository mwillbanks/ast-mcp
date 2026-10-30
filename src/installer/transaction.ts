import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
} from "node:fs";
import { chmod, lstat, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  assertConfigWriteTarget,
  canonicalConfigPath,
  withConfigTransaction,
} from "../config/transaction";
import {
  createdDirectoryAncestors,
  type DirectoryIdentity,
} from "./directory-ancestry";

type FileState = { bytes: Buffer; mode: number } | undefined;
type Entry = { before: FileState; after: FileState; configuration?: string };
type ParentState = DirectoryIdentity;
type TransactionOptions = {
  rename?: typeof renameSync;
  remove?: typeof rmSync;
};
const active = new AsyncLocalStorage<FileTransaction>();
function conflict(message: string) {
  return Object.assign(new Error(message), {
    code: "configuration_conflict",
    retryable: true,
  });
}
function state(file: string): FileState {
  let info;
  try {
    info = lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!info.isFile())
    throw new Error("Installer destination must be a regular file");
  return { bytes: readFileSync(file), mode: info.mode & 0o777 };
}
function equal(left: FileState, right: FileState) {
  return left === undefined || right === undefined
    ? left === right
    : left.mode === right.mode && left.bytes.equals(right.bytes);
}

class FileTransaction {
  readonly entries = new Map<string, Entry>();
  readonly compensations: Array<() => Promise<void>> = [];
  readonly parents = new Map<string, ParentState>();
  readonly directories = new Map<string, ParentState>();
  constructor(readonly options: TransactionOptions) {}

  guard(file: string) {
    for (const [parent, before] of this.parents) {
      if (!file.startsWith(parent + path.sep)) continue;
      const current = lstatSync(parent);
      if (
        current.ino !== before.ino ||
        current.dev !== before.dev ||
        realpathSync(parent) !== before.real
      )
        throw conflict(
          "Installer parent directory changed; preserving user files",
        );
    }
    let parent = path.dirname(file);
    while (!this.parents.has(parent)) {
      let info;
      try {
        info = lstatSync(parent);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (info) {
        this.parents.set(parent, {
          real: realpathSync(parent),
          ino: info.ino,
          dev: info.dev,
        });
        break;
      }
      const next = path.dirname(parent);
      if (next === parent) break;
      parent = next;
    }
  }

  async mkdir(directory: string) {
    directory = path.resolve(directory);
    this.guard(path.join(directory, ".installer-directory"));
    const first = await mkdir(directory, { recursive: true });
    if (first) {
      const created = createdDirectoryAncestors(directory, first);
      for (const [createdPath, identity] of created)
        this.directories.set(createdPath, identity);
    }
    return first;
  }

  observe(file: string) {
    file = path.resolve(file);
    this.guard(file);
    const current = state(file);
    const entry = this.entries.get(file);
    if (entry && !equal(current, entry.after))
      throw conflict("Installer destination changed; reload and retry");
    if (!entry) this.entries.set(file, { before: current, after: current });
    return current;
  }

  async replace(
    file: string,
    next: FileState,
    expected: FileState,
    exclusive = false,
    configuration?: string,
  ) {
    file = path.resolve(file);
    this.guard(file);
    const current = state(file);
    const entry = this.entries.get(file);
    if (!equal(current, expected) || (entry && !equal(current, entry.after)))
      throw conflict(
        "Installer destination changed; refusing to overwrite user edits",
      );
    if (exclusive && current)
      throw new Error("Installer destination already exists");
    if (equal(current, next)) return;
    await this.commit(file, next, current, configuration, (after) => {
      this.entries.set(file, {
        before: entry ? entry.before : current,
        after,
        configuration: configuration ?? entry?.configuration,
      });
    });
  }

  async commit(
    file: string,
    next: FileState,
    expected: FileState,
    configuration: string | undefined,
    committed: (after: FileState) => void,
  ): Promise<void> {
    this.guard(file);
    const commit = (temporary?: string, mode?: number) => {
      // Keep the final comparison and mutation synchronous, including the shared config fence.
      const replace = () => {
        if (configuration) assertConfigWriteTarget(configuration, file);
        this.guard(file);
        if (!equal(state(file), expected))
          throw conflict("Installer destination changed before commit");
        if (next) (this.options.rename ?? renameSync)(temporary!, file);
        else (this.options.remove ?? rmSync)(file);
        committed(next ? { bytes: next.bytes, mode: mode! } : undefined);
      };
      if (configuration) withConfigTransaction(file, replace);
      else replace();
    };
    if (!next) return commit();
    await this.mkdir(path.dirname(file));
    this.guard(file);
    const temporary = path.join(
      path.dirname(file),
      ".ast-mcp-" + randomUUID() + ".tmp",
    );
    try {
      await writeFile(temporary, next.bytes, { flag: "wx", mode: next.mode });
      await chmod(temporary, next.mode);
      // Windows reports supported permission bits, rather than every requested POSIX bit.
      const mode = (await lstat(temporary)).mode & 0o777;
      return commit(temporary, mode);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  assertRestored(file: string) {
    file = path.resolve(file);
    this.guard(file);
    const entry = this.entries.get(file);
    if (!entry || !equal(state(file), entry.before))
      throw conflict("Installer compensation requires its original file state");
  }

  async rollback() {
    const failures: unknown[] = [];
    for (const [file, entry] of [...this.entries].reverse()) {
      try {
        if (equal(entry.before, entry.after)) continue;
        if (!equal(state(file), entry.after))
          throw conflict(
            "Installer rollback preserved a concurrently changed destination",
          );
        await this.commit(
          file,
          entry.before,
          entry.after,
          entry.configuration,
          (after) => {
            entry.after = after;
          },
        );
      } catch (error) {
        failures.push(error);
      }
    }
    // Compensations validate their own dependencies; unrelated conflicts must not suppress recovery.
    for (const compensate of this.compensations.reverse()) {
      try {
        await compensate();
      } catch (error) {
        failures.push(error);
      }
    }
    for (const [directory, before] of [...this.directories].sort(
      ([a], [b]) => b.length - a.length,
    )) {
      try {
        const current = lstatSync(directory);
        if (
          current.ino === before.ino &&
          current.dev === before.dev &&
          realpathSync(directory) === before.real
        )
          rmdirSync(directory);
      } catch (error) {
        if (
          !["ENOENT", "ENOTEMPTY", "EEXIST"].includes(
            (error as NodeJS.ErrnoException).code ?? "",
          )
        )
          failures.push(error);
      }
    }
    return failures;
  }
}

/** Memory-only rollback journal. Nested installer operations join the same transaction. */
export async function withInstallerFileTransaction<T>(
  operation: () => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  if (active.getStore()) return operation();
  const transaction = new FileTransaction(options);
  return active.run(transaction, async () => {
    try {
      return await operation();
    } catch (error) {
      const failures = await transaction.rollback();
      if (failures.length)
        throw new AggregateError(
          [error, ...failures],
          "Installer failed; rollback was incomplete. Concurrent user edits were preserved.",
          { cause: error },
        );
      throw error;
    }
  });
}

export function assertInstallerRestored(file: string) {
  const transaction = active.getStore();
  if (!transaction)
    throw new Error("Installer compensation requires an active transaction");
  transaction.assertRestored(file);
}

export function onInstallerRollback(compensate: () => Promise<void>) {
  active.getStore()?.compensations.push(compensate);
}

export async function mkdirInstallerDirectory(
  directory: string,
  options: { recursive: true } = { recursive: true },
) {
  const transaction = active.getStore();
  return transaction ? transaction.mkdir(directory) : mkdir(directory, options);
}

export async function writeInstallerFile(
  file: string,
  content: string,
  options: {
    mode?: number;
    exclusive?: boolean;
    expected?: string;
    configuration?: string;
  } = {},
): Promise<void> {
  const transaction = active.getStore();
  if (!transaction)
    return withInstallerFileTransaction(() =>
      writeInstallerFile(file, content, options),
    );
  if (options.configuration) file = canonicalConfigPath(file);
  const current = transaction.observe(file);
  if (
    options.expected !== undefined &&
    (current?.bytes.toString() ?? "") !== options.expected
  )
    throw conflict("Installer configuration changed; reload and retry");
  const next = {
    bytes: Buffer.from(content),
    mode: options.mode ?? current?.mode ?? 0o666 & ~process.umask(),
  };
  await transaction.replace(
    file,
    next,
    current,
    options.exclusive,
    options.configuration,
  );
}

export async function readInstallerText(file: string) {
  const transaction = active.getStore();
  const current = transaction ? transaction.observe(file) : state(file);
  if (!current)
    throw Object.assign(new Error("Installer file does not exist"), {
      code: "ENOENT",
    });
  return current.bytes.toString();
}

export async function removeInstallerFile(file: string): Promise<void> {
  const transaction = active.getStore();
  if (transaction)
    return transaction.replace(file, undefined, transaction.observe(file));
  return withInstallerFileTransaction(() => removeInstallerFile(file));
}
