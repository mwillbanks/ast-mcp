import { randomUUID } from "node:crypto";
import { type FSWatcher, watch } from "node:fs";
import { lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import path from "node:path";

import { acquireTransactionLock } from "./transaction-lock.ts";

const ticketPattern = /^(\d{12})-(\d+)-(\d+)-[0-9a-f-]{36}$/u;
const queueLimit = 256;
const recheckMs = 40;

interface AdmissionOptions {
  deadline: number;
  signal?: AbortSignal;
  tryOnly?: boolean;
}

function checkBudget({ deadline, signal }: AdmissionOptions): void {
  if (signal?.aborted)
    throw Object.assign(
      new Error("Transaction lock acquisition was cancelled"),
      {
        code: "lock_aborted",
        retryable: false,
      },
    );
  if (Date.now() >= deadline)
    throw Object.assign(new Error("Transaction lock deadline expired"), {
      code: "lock_deadline",
      retryable: true,
    });
}

async function removeTicket(file: string): Promise<void> {
  await unlink(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

function processExited(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

interface Ticket {
  name: string;
  sequence: number;
  pid: number;
  deadline: number;
}

function parseTicket(name: string): Ticket {
  const match = ticketPattern.exec(name);
  if (!match) throw new Error("Invalid checkout admission ticket");
  return {
    name,
    sequence: Number(match[1]),
    pid: Number(match[2]),
    deadline: Number(match[3]),
  };
}

function ticketAlive(ticket: Ticket): boolean {
  return ticket.deadline > Date.now() && !processExited(ticket.pid);
}

/** Reap stale tickets from the front without rescanning the queue. */
async function queueSnapshot(directory: string): Promise<Ticket[]> {
  const tickets = (await readdir(directory)).sort().map(parseTicket);
  let first = 0;
  for (const ticket of tickets) {
    if (ticketAlive(ticket)) break;
    await removeTicket(path.join(directory, ticket.name));
    first++;
  }
  return tickets.slice(first);
}

async function ticketPresent(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return false;
  }
}

async function predecessorPresent(
  directory: string,
  predecessor: Ticket,
): Promise<boolean> {
  const file = path.join(directory, predecessor.name);
  if (ticketAlive(predecessor)) return ticketPresent(file);
  await removeTicket(file);
  return false;
}

async function enqueue(directory: string, options: AdmissionOptions) {
  const writer = await acquireTransactionLock(
    path.join(directory, "enqueue"),
    options,
  );
  try {
    const tickets = await queueSnapshot(directory);
    if (options.tryOnly && tickets.length > 0)
      throw Object.assign(new Error("Checkout admission is already held"), {
        code: "lock_busy",
        retryable: true,
      });
    if (tickets.length >= queueLimit)
      throw Object.assign(new Error("Checkout admission queue is full"), {
        code: "lock_queue_full",
        retryable: true,
      });
    const predecessor = tickets.at(-1);
    const next = (predecessor?.sequence ?? 0) + 1;
    checkBudget(options);
    const ticket = [
      String(next).padStart(12, "0"),
      process.pid,
      options.deadline,
      randomUUID(),
    ].join("-");
    const handle = await open(path.join(directory, ticket), "wx", 0o600);
    await handle.close();
    return { ticket, predecessor };
  } finally {
    writer.release();
  }
}

async function openQueue(directory: string, options: AdmissionOptions) {
  await mkdir(directory, { mode: 0o700 }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    },
  );
  const info = await lstat(directory);
  if (
    !info.isDirectory() ||
    (process.platform !== "win32" &&
      (info.uid !== process.geteuid?.() || (info.mode & 0o777) !== 0o700))
  )
    throw new Error("Checkout admission directory must be private");
  return enqueue(directory, options);
}

/** Queue by publication order in the canonical checkout's account-private namespace. */
export async function withCheckoutAdmission<T>(
  checkoutLockPath: string,
  options: AdmissionOptions,
  operation: (releaseTicket: () => Promise<void>) => Promise<T>,
): Promise<T> {
  checkBudget(options);
  const directory = checkoutLockPath + ".admission";
  const { ticket, predecessor: previousTicket } = await openQueue(
    directory,
    options,
  );
  let predecessor = previousTicket;
  const ticketPath = path.join(directory, ticket);
  let released = false;
  const releaseTicket = async () => {
    if (released) return;
    released = true;
    // If cleanup fails, the original deadline still bounds the ticket.
    await removeTicket(ticketPath).catch(() => {
      process.stderr.write("ast-mcp: checkout admission cleanup failed\n");
    });
  };
  let changed = Promise.withResolvers<void>();
  let watcher: FSWatcher | undefined;
  const wake = () => changed.resolve();
  try {
    if (predecessor) {
      // Watch before probing. An unrelated enqueue or release cannot advance
      // this ticket, so only its current predecessor can wake it early.
      try {
        watcher = watch(
          directory,
          { persistent: false },
          (_event, filename) => {
            if (!filename || filename === predecessor?.name) wake();
          },
        );
        watcher.on("error", () => {
          watcher?.close();
          wake();
        });
      } catch {
        // Fall back to probing the predecessor if watch is unavailable.
      }
      options.signal?.addEventListener("abort", wake, { once: true });
    }
    while (predecessor) {
      checkBudget(options);
      if (!(await predecessorPresent(directory, predecessor))) {
        // A cancelled predecessor may leave an earlier ticket in the queue.
        predecessor = (await queueSnapshot(directory)).findLast(
          (candidate) => candidate.name < ticket,
        );
        continue;
      }
      const timer = setTimeout(
        wake,
        Math.min(recheckMs, Math.max(1, options.deadline - Date.now())),
      );
      try {
        await changed.promise;
      } finally {
        clearTimeout(timer);
      }
      changed = Promise.withResolvers<void>();
    }
    const present = await ticketPresent(ticketPath);
    checkBudget(options);
    if (!present)
      throw Object.assign(new Error("Checkout admission ticket was removed"), {
        code: "lock_fenced",
        retryable: false,
      });
    watcher?.close();
    return await operation(releaseTicket);
  } finally {
    watcher?.close();
    options.signal?.removeEventListener("abort", wake);
    await releaseTicket();
  }
}
