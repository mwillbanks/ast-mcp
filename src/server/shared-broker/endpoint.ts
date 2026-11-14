import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, openSync, type Stats } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";

import {
  macPathHasNoAcl,
  macVolumeEnforcesOwnership,
} from "../../runtime/mac-file-access";

export const brokerHost = "127.0.0.1";
const endpointVersion = 1;
const tokenPattern = /^[a-f0-9]{64}$/u;

export interface BrokerEndpoint {
  pid: number;
  port: number;
  secret: string;
  version: typeof endpointVersion;
}

function processUid() {
  const uid = process.geteuid?.();
  if (typeof uid !== "number")
    throw new Error("Cannot identify broker account");
  return uid;
}

function privateDirectory(info: Stats, directory: string): boolean {
  return (
    info.isDirectory() &&
    info.uid === processUid() &&
    (info.mode & 0o777) === 0o700 &&
    (process.platform !== "darwin" || macPathHasNoAcl(directory))
  );
}

function ownedPrivateFile(info: Stats): boolean {
  return (
    info.isFile() && info.uid === processUid() && (info.mode & 0o777) === 0o600
  );
}

function privateFile(info: Stats, filePath: string): boolean {
  return (
    ownedPrivateFile(info) &&
    info.nlink === 1 &&
    (process.platform !== "darwin" || macPathHasNoAcl(filePath))
  );
}

export function fileMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

async function makePrivateDirectory(directory: string) {
  await mkdir(directory, { mode: 0o700 }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  });
  if (!privateDirectory(await lstat(directory), directory))
    throw new Error("Shared MCP broker directory is not private");
}

export async function brokerDirectory(
  installationKey: string,
): Promise<string> {
  const hash = createHash("sha256").update(installationKey).digest("hex");
  const parent = await realpath("/tmp");
  const info = await lstat(parent);
  const sharedWritable = (info.mode & 0o022) !== 0;
  if (
    !info.isDirectory() ||
    (info.uid !== 0 && info.uid !== processUid()) ||
    (sharedWritable && (info.mode & 0o1000) === 0) ||
    (process.platform === "darwin" &&
      (!macPathHasNoAcl(parent) || !macVolumeEnforcesOwnership(parent)))
  )
    throw new Error("Unsafe system temporary directory for shared MCP broker");
  const name = `ast-mcp-broker-${processUid()}`;
  const owner = path.join(parent, name);
  await makePrivateDirectory(owner);
  const directory = path.join(owner, hash);
  await makePrivateDirectory(directory);
  return directory;
}

function endpointPath(directory: string): string {
  return path.join(directory, "endpoint.json");
}

export async function readEndpoint(
  directory: string,
): Promise<BrokerEndpoint | undefined> {
  const target = endpointPath(directory);
  try {
    // O_NONBLOCK prevents a pre-existing FIFO from blocking before fstat.
    const handle = await open(
      target,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
    try {
      const info = await handle.stat();
      const unsafe = () =>
        new Error("Shared MCP broker endpoint metadata is unsafe");
      if (!ownedPrivateFile(info) || info.nlink > 1 || info.size > 512)
        throw unsafe();
      // Normal broker retirement can unlink the manifest after we open it.
      if (info.nlink === 0) return;
      if (process.platform === "darwin" && !macPathHasNoAcl(target)) {
        const current = await handle.stat();
        if (ownedPrivateFile(current) && current.nlink === 0) return;
        throw unsafe();
      }
      const source = Buffer.alloc(513);
      const { bytesRead } = await handle.read(source, 0, source.length, 0);
      const endpoint: Partial<BrokerEndpoint> | null = JSON.parse(
        source.toString("utf8", 0, bytesRead),
      );
      if (
        !endpoint ||
        endpoint.version !== endpointVersion ||
        typeof endpoint.pid !== "number" ||
        !Number.isSafeInteger(endpoint.pid) ||
        endpoint.pid < 1 ||
        typeof endpoint.port !== "number" ||
        !Number.isInteger(endpoint.port) ||
        endpoint.port < 1 ||
        endpoint.port > 65535 ||
        typeof endpoint.secret !== "string" ||
        !tokenPattern.test(endpoint.secret)
      ) {
        throw new Error("Shared MCP broker endpoint metadata is invalid");
      }
      return endpoint as BrokerEndpoint;
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (!fileMissing(error)) throw error;
  }
}

export function createEndpoint(port: number): BrokerEndpoint {
  return {
    pid: process.pid,
    port,
    secret: randomBytes(32).toString("hex"),
    version: endpointVersion,
  };
}

export async function publishEndpoint(
  directory: string,
  endpoint: BrokerEndpoint,
): Promise<void> {
  const target = endpointPath(directory);
  const staging = path.join(
    directory,
    `endpoint-${randomBytes(16).toString("hex")}.tmp`,
  );
  const handle = await open(staging, "wx", 0o600);
  try {
    try {
      await handle.writeFile(JSON.stringify(endpoint));
    } finally {
      await handle.close();
    }
    await rename(staging, target);
  } finally {
    await unlink(staging).catch((error: unknown) => {
      if (!fileMissing(error)) throw error;
    });
  }
}

export async function removeEndpoint(directory: string): Promise<void> {
  await unlink(endpointPath(directory)).catch((error: unknown) => {
    if (!fileMissing(error)) throw error;
  });
}

/** Startup and ownership use separate kernel-backed SQLite locks. Neither
 * serializes MCP traffic or uses a PID/timeout to seize a live owner. */
export async function tryBrokerGate(
  directory: string,
  gate: "startup" | "owner",
): Promise<(() => void) | undefined> {
  const databasePath = path.join(directory, `${gate}.sqlite`);
  try {
    const descriptor = openSync(databasePath, "wx", 0o600);
    closeSync(descriptor);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  if (!privateFile(await lstat(databasePath), databasePath))
    throw new Error("Shared MCP broker coordination file is unsafe");
  const database = new Database(databasePath, { create: false });
  try {
    database.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
    return () => database.close();
  } catch (error) {
    database.close();
    if ((error as NodeJS.ErrnoException).code !== "SQLITE_BUSY") throw error;
  }
}
