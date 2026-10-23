import { spawnSync } from "node:child_process";
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import path from "node:path";

import { sha256 } from "./hash.ts";
import { canonicalizePathSync } from "./path-utils.ts";

interface SystemAccount {
  homedir: string;
  uid: number;
}
const ACCOUNT_QUERY =
  'import os from "node:os"; const {homedir,uid}=os.userInfo(); console.log(JSON.stringify({homedir,uid}));';
let accountPromise: Promise<SystemAccount> | undefined;
let resolvedAccount: SystemAccount | undefined;
function accountEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const excluded = new Set([
    "HOME",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "NODE_OPTIONS",
    "BUN_OPTIONS",
    "PSMODULEANALYSISCACHEPATH",
  ]);
  for (const key of Object.keys(env))
    if (excluded.has(key.toUpperCase())) delete env[key];
  // Disable PowerShell background module-cache discovery before its host starts.
  env.PSModuleAnalysisCachePath =
    process.platform === "win32" ? "NUL" : "/dev/null";
  return env;
}

/** Windows Bun userInfo can follow environment homes; query the Windows known folder instead. */
export function accountLookupCommand(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (platform !== "win32") return [process.execPath, "--eval", ACCOUNT_QUERY];
  const systemRoot = Object.entries(env).find(
    ([key]) => key.toUpperCase() === "SYSTEMROOT",
  )?.[1];
  if (!systemRoot || !path.win32.isAbsolute(systemRoot))
    throw new Error("The Windows system directory is unavailable");
  return [
    path.win32.join(
      systemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    // Use only built-in language and .NET APIs: cmdlets trigger cold module discovery.
    "$PSModuleAutoLoadingPreference = 'None'; [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); $profilePath = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile); if (-not $profilePath) { exit 1 }; [Console]::WriteLine('{\"homedir\":\"' + $profilePath.Replace('\\', '\\\\').Replace('\"', '\\\"') + '\",\"uid\":-1}')",
  ];
}
function parseAccount(output: string): SystemAccount {
  const account: unknown = JSON.parse(output);
  if (
    !account ||
    typeof account !== "object" ||
    !("homedir" in account) ||
    typeof account.homedir !== "string" ||
    !path.isAbsolute(account.homedir) ||
    !("uid" in account) ||
    typeof account.uid !== "number" ||
    !Number.isSafeInteger(account.uid) ||
    (process.platform !== "win32" && account.uid !== process.geteuid?.())
  )
    throw new Error("Account lookup returned an invalid identity");
  return { homedir: account.homedir, uid: account.uid };
}
function unavailable(cause: unknown): Error {
  return Object.assign(
    new Error("Cannot resolve the operating-system account", { cause }),
    { code: "mutation_lock_account_unavailable" },
  );
}

/** Resolve the native account in a bounded child without modifying the host environment. */
export async function readSystemAccount(): Promise<SystemAccount> {
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    child = Bun.spawn(accountLookupCommand(), {
      env: accountEnvironment(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    const running = child;
    timer = setTimeout(() => running.kill(), 5_000);
    if (typeof child.stdout === "number" || !child.stdout)
      throw new Error("Account lookup output unavailable");
    const reader = child.stdout.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 4096)
          throw new Error("Account lookup output exceeded its limit");
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    if ((await child.exited) !== 0)
      throw new Error("Account lookup process failed");
    return parseAccount(Buffer.concat(chunks).toString("utf8"));
  } catch (cause) {
    child?.kill();
    if (child) await child.exited;
    throw unavailable(cause);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function systemAccountSync(): SystemAccount {
  if (resolvedAccount) return resolvedAccount;
  try {
    const [executable, ...args] = accountLookupCommand();
    const result = spawnSync(executable!, args, {
      env: accountEnvironment(),
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 4096,
    });
    if (result.error || result.status !== 0)
      throw result.error ?? new Error("Account lookup process failed");
    resolvedAccount = parseAccount(result.stdout);
    return resolvedAccount;
  } catch (cause) {
    throw unavailable(cause);
  }
}
export function systemAccount(): Promise<SystemAccount> {
  if (resolvedAccount) return Promise.resolve(resolvedAccount);
  accountPromise ??= readSystemAccount()
    .then((account) => {
      resolvedAccount = account;
      return account;
    })
    .catch((error: unknown) => {
      accountPromise = undefined;
      throw error;
    });
  return accountPromise;
}
function assertPrivateDirectory(metadata: Stats, account: SystemAccount): void {
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (process.platform !== "win32" &&
      (metadata.uid !== account.uid || (metadata.mode & 0o777) !== 0o700))
  ) {
    throw Object.assign(
      new Error("The lock directory must be private and account owned"),
      { code: "mutation_lock_directory_unsafe" },
    );
  }
}
function directoryIn(home: string): string {
  if (!path.isAbsolute(home))
    throw Object.assign(
      new Error("The account home directory is unavailable"),
      { code: "mutation_lock_directory_unsafe" },
    );
  return path.join(home, ".ast-mcp-mutation-locks");
}
export async function ensurePrivateLockDirectory(
  account: SystemAccount,
): Promise<string> {
  directoryIn(account.homedir);
  const directory = directoryIn(realpathSync.native(account.homedir));
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  assertPrivateDirectory(await lstat(directory), account);
  return directory;
}
function databaseIn(directory: string, lockIdentity: string): string {
  const canonical = canonicalizePathSync(lockIdentity);
  const identity =
    process.platform === "win32" || process.platform === "darwin"
      ? canonical.toLowerCase()
      : canonical;
  return path.join(directory, `guard-${sha256(identity)}.sqlite`);
}
export async function privateLockDatabasePath(
  lockIdentity: string,
): Promise<string> {
  const account = await systemAccount();
  const database = databaseIn(
    await ensurePrivateLockDirectory(account),
    lockIdentity,
  );
  try {
    const handle = await open(database, "wx", 0o600);
    await handle.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  assertPrivateDatabase(await lstat(database), account);
  return database;
}
export function privateLockDatabasePathSync(lockIdentity: string): string {
  const account = systemAccountSync();
  const directory = directoryIn(realpathSync.native(account.homedir));
  try {
    mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  assertPrivateDirectory(lstatSync(directory), account);
  const database = databaseIn(directory, lockIdentity);
  try {
    closeSync(openSync(database, "wx", 0o600));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  assertPrivateDatabase(lstatSync(database), account);
  return database;
}

function assertPrivateDatabase(metadata: Stats, account: SystemAccount): void {
  // The parent is verified private. Refuse pre-existing links or foreign files
  // before SQLite opens this pathname; no untrusted repository path is opened.
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1 ||
    (process.platform !== "win32" && metadata.uid !== account.uid)
  ) {
    throw Object.assign(
      new Error(
        "The transaction lock database must be an account-owned regular file",
      ),
      { code: "mutation_lock_directory_unsafe" },
    );
  }
}
