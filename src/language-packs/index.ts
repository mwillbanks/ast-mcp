import { dlopen, read } from "bun:ffi";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
  type BigIntStats,
} from "node:fs";
import { mkdtemp, open, rm, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ResolvedConfig } from "../config/index.ts";
import { projectLanguagePackDirectory } from "../config/language-packs.ts";
import { canonicalizePathSync } from "../runtime/path-utils.ts";
import { syncDirectory } from "../runtime/snapshot-blob.ts";
import { acquireTransactionLock } from "../runtime/transaction-lock.ts";
import { stagePackWithBun } from "./archive.ts";
import {
  isPackLanguage,
  nativePackDescriptor,
  packLanguages,
  packVersions,
  type PackDescriptor,
  type PackLanguage,
} from "./catalog.ts";

const maxAssetBytes = 4 * 1024 * 1024;
const maxVerifiedAssets = 64;
const verifiedFiles = new Map<string, string>();
const pendingInstalls = new Map<string, Promise<void>>();

export interface NativePackAsset {
  abi: number;
  libraryPath: string;
  sha256: string;
  languageSymbol: string;
  expandoChar: string;
  version: string;
}

export interface NativePackOptions {
  checkoutRoot?: string;
  signal?: AbortSignal;
}

export function languagePackStore(
  config: ResolvedConfig,
  checkoutRoot?: string,
): string | undefined {
  const settings = config.languagePacks;
  if (!settings || settings.projectStorageDenied) return undefined;
  if (settings.scope === "user") return settings.directory;
  const target = canonicalizePathSync(checkoutRoot ?? config.projectRoot);
  if (
    ![config.projectRoot, ...config.workspace.linkedWorktrees].some(
      (root) => path.relative(canonicalizePathSync(root), target) === "",
    )
  )
    throw new Error(
      "Project language pack store is outside the authorized checkout",
    );
  return projectLanguagePackDirectory(target);
}

function missing(error: unknown) {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function owned(metadata: BigIntStats, deniedMode: bigint): boolean {
  return (
    process.platform === "win32" ||
    (metadata.uid === BigInt(process.geteuid!()) &&
      (metadata.mode & deniedMode) === 0n)
  );
}

function verifyDirectory(directory: string, deniedMode: bigint): void {
  const metadata = lstatSync(directory, { bigint: true });
  if (!metadata.isDirectory() || !owned(metadata, deniedMode))
    throw new Error(
      "The language pack directory must be owned by this user and protected from other users",
    );
}

function privateStore(directory: string, create = false): string {
  const parent = path.dirname(directory);
  if (create) mkdirSync(parent, { mode: 0o700, recursive: true });
  verifyDirectory(parent, 0o022n);
  if (create) {
    try {
      mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  verifyDirectory(directory, 0o077n);
  return realpathSync(directory);
}

function assetIdentity(metadata: BigIntStats): string {
  if (
    !metadata.isFile() ||
    !owned(metadata, 0o222n) ||
    metadata.size <= 0n ||
    metadata.size > BigInt(maxAssetBytes)
  )
    throw new Error(
      "The language pack asset must be a bounded, read-only, regular file owned by this user",
    );
  return [
    metadata.dev,
    metadata.ino,
    metadata.ctimeNs,
    metadata.mtimeNs,
    metadata.size,
  ].join(":");
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function readVerifiedBytes(
  libraryPath: string,
  sha256: string,
  identity: string,
): Buffer {
  const descriptor = openSync(
    libraryPath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    if (assetIdentity(fstatSync(descriptor, { bigint: true })) !== identity)
      throw new Error("Language pack asset changed before verification");
    const bytes = readFileSync(descriptor);
    if (digest(bytes) !== sha256)
      throw new Error("Language pack asset digest mismatch");
    if (assetIdentity(lstatSync(libraryPath, { bigint: true })) !== identity)
      throw new Error("Language pack asset changed during verification");
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

const abiProbeScript = `
  import { dlopen, read } from "bun:ffi";
  import { existsSync } from "node:fs";
  const [file, symbol, abi] = process.argv.slice(1);
  if (!existsSync(file)) process.exit(3);
  let library;
  try {
    library = dlopen(file, { [symbol]: { args: [], returns: "ptr" } });
  } catch {
    process.exit(4);
  }
  const grammar = library.symbols[symbol]?.();
  process.exit(grammar && read.u32(grammar) === Number(abi) ? 0 : 2);
`;

/** Call only on a manifest-verified library inside a private user store. */
export function probeNativePackAbi(
  libraryPath: string,
  descriptor: PackDescriptor,
): void {
  const result = Bun.spawnSync(
    [
      process.execPath,
      "--no-env-file",
      "--eval",
      abiProbeScript,
      libraryPath,
      descriptor.languageSymbol,
      String(descriptor.abi),
    ],
    {
      cwd: path.dirname(process.execPath),
      env: {
        BUN_BE_BUN: "1",
        SystemRoot: process.env.SystemRoot,
        WINDIR: process.env.WINDIR,
      },
      stderr: "ignore",
      stdin: "ignore",
      stdout: "ignore",
      timeout: 5_000,
    },
  );
  if (result.success) return;
  if (result.exitCode === 2)
    throw new Error(`Language pack ABI mismatch for ${descriptor.language}`);

  let reason = `unexpected exit ${result.exitCode ?? result.signalCode}`;
  if (result.exitedDueToTimeout) reason = "child timed out";
  else if (result.exitCode === 3) reason = "library missing or inaccessible";
  else if (result.exitCode === 4)
    reason = "native loader rejected the library, its symbol, or a dependency";
  throw new Error(
    `Language pack ABI probe failed for ${descriptor.language}: ${reason}`,
  );
}

/** Call only on a manifest-verified library inside a private user store. */
function checkAbi(libraryPath: string, descriptor: PackDescriptor): void {
  // Bun keeps DLLs mapped after FFI close on Windows. Let a child release
  // the native file before the caller publishes or removes it.
  if (process.platform === "win32")
    return probeNativePackAbi(libraryPath, descriptor);

  const library = dlopen(libraryPath, {
    [descriptor.languageSymbol]: { args: [], returns: "ptr" },
  });
  try {
    const grammar = library.symbols[descriptor.languageSymbol]?.();
    if (!grammar || read.u32(grammar) !== descriptor.abi)
      throw new Error(`Language pack ABI mismatch for ${descriptor.language}`);
  } finally {
    library.close();
  }
}

function rememberVerified(libraryPath: string, identity: string): void {
  if (verifiedFiles.size >= maxVerifiedAssets)
    verifiedFiles.delete(verifiedFiles.keys().next().value!);
  verifiedFiles.set(libraryPath, identity);
}

function checkedAsset(
  libraryPath: string,
  descriptor: PackDescriptor,
  identity?: string,
): NativePackAsset {
  identity ??= assetIdentity(lstatSync(libraryPath, { bigint: true }));
  if (verifiedFiles.get(libraryPath) !== identity) {
    readVerifiedBytes(libraryPath, descriptor.sha256, identity);
    checkAbi(libraryPath, descriptor);
    rememberVerified(libraryPath, identity);
  }
  return describeAsset(libraryPath, descriptor);
}

function describeAsset(
  libraryPath: string,
  descriptor: PackDescriptor,
): NativePackAsset {
  return {
    abi: descriptor.abi,
    libraryPath,
    sha256: descriptor.sha256,
    languageSymbol: descriptor.languageSymbol,
    expandoChar: descriptor.expandoChar,
    version: descriptor.version,
  };
}

/** Load project pack bytes from a private user directory outside the checkout. */
function userActivationAsset(
  userDirectory: string,
  projectLibrary: string,
  descriptor: PackDescriptor,
  projectIdentity: string,
): string {
  const userStore = privateStore(userDirectory, true);
  const directory = privateStore(path.join(userStore, ".activated"), true);
  const destination = path.join(directory, descriptor.filename);
  if (verifiedFiles.get(projectLibrary) === projectIdentity) {
    try {
      checkedAsset(destination, descriptor);
      return destination;
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
  const bytes = readVerifiedBytes(
    projectLibrary,
    descriptor.sha256,
    projectIdentity,
  );
  try {
    checkedAsset(destination, descriptor);
  } catch (error) {
    if (!missing(error)) throw error;
    const pending = path.join(
      directory,
      "." + descriptor.filename + "." + randomUUID(),
    );
    const file = openSync(pending, "wx", 0o400);
    try {
      writeFileSync(file, bytes);
      fsyncSync(file);
      checkAbi(pending, descriptor);
      try {
        linkSync(pending, destination);
      } catch (failure) {
        if ((failure as NodeJS.ErrnoException).code !== "EEXIST") throw failure;
      }
    } finally {
      try {
        closeSync(file);
      } finally {
        unlinkSync(pending);
      }
    }
  }
  rememberVerified(projectLibrary, projectIdentity);
  return destination;
}

function selectedDescriptor(
  config: ResolvedConfig,
  language: PackLanguage,
): PackDescriptor | null {
  const descriptor = nativePackDescriptor(language);
  const version =
    config.languagePacks?.versions[language] ?? packVersions[language];
  return descriptor?.version === version ? descriptor : null;
}

function readPack(
  config: ResolvedConfig,
  descriptor: PackDescriptor,
  checkoutRoot?: string,
  activate = true,
) {
  const location = languagePackStore(config, checkoutRoot);
  if (!location) return undefined;
  const directory = privateStore(location);
  const libraryPath = path.join(directory, descriptor.filename);
  const identity = assetIdentity(lstatSync(libraryPath, { bigint: true }));
  if (config.languagePacks?.scope !== "project")
    return checkedAsset(libraryPath, descriptor, identity);
  if (!activate) {
    readVerifiedBytes(libraryPath, descriptor.sha256, identity);
    return describeAsset(libraryPath, descriptor);
  }
  return checkedAsset(
    userActivationAsset(
      config.languagePacks.userDirectory,
      libraryPath,
      descriptor,
      identity,
    ),
    descriptor,
  );
}

/** Missing packs preserve the bundled grammar. Invalid installed packs fail closed. */
export function activeNativePack(
  language: string,
  config: ResolvedConfig,
  checkoutRoot?: string,
): NativePackAsset | undefined {
  if (!isPackLanguage(language)) return undefined;
  const descriptor = selectedDescriptor(config, language);
  if (!descriptor) return undefined;
  try {
    return readPack(config, descriptor, checkoutRoot);
  } catch (error) {
    if (!missing(error)) throw error;
    return undefined;
  }
}

/** Validate the exact native asset again inside an isolated worker before loading. */
export function verifyNativePackAsset(
  language: string,
  asset: NativePackAsset,
): boolean {
  if (
    !isPackLanguage(language) ||
    !asset ||
    typeof asset.libraryPath !== "string"
  )
    return false;
  const descriptor = nativePackDescriptor(language);
  if (
    !descriptor ||
    !path.isAbsolute(asset.libraryPath) ||
    path.basename(asset.libraryPath) !== descriptor.filename ||
    asset.version !== descriptor.version ||
    asset.sha256 !== descriptor.sha256 ||
    asset.languageSymbol !== descriptor.languageSymbol ||
    asset.expandoChar !== descriptor.expandoChar ||
    asset.abi !== descriptor.abi
  )
    return false;
  try {
    verifyDirectory(path.dirname(asset.libraryPath), 0o077n);
    checkedAsset(asset.libraryPath, descriptor);
    return true;
  } catch {
    return false;
  }
}

async function cleanStaging(stage: string): Promise<void> {
  try {
    verifyDirectory(stage, 0o077n);
    await rm(stage, { recursive: true });
  } catch (error) {
    if (!missing(error)) throw error;
  }
}

async function sourceBytes(
  libraryPath: string,
  descriptor: PackDescriptor,
): Promise<Buffer> {
  const handle = await open(
    libraryPath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const metadata = await handle.stat({ bigint: true });
    if (
      !metadata.isFile() ||
      !owned(metadata, 0o022n) ||
      metadata.size <= 0n ||
      metadata.size > BigInt(maxAssetBytes)
    )
      throw new Error("Bun installed an invalid language pack asset");
    const bytes = await handle.readFile();
    if (digest(bytes) !== descriptor.sha256)
      throw new Error(
        "Bun installed a language pack asset with an unexpected digest",
      );
    return bytes;
  } finally {
    await handle.close();
  }
}

async function installInto(
  directory: string,
  descriptor: PackDescriptor,
): Promise<void> {
  const destination = path.join(directory, descriptor.filename);
  const pending = path.join(directory, "." + descriptor.filename + ".pending");
  const deadline = Date.now() + 35_000;
  const signal = AbortSignal.timeout(35_000);
  const lock = await acquireTransactionLock(destination, { deadline, signal });
  let stage: string | undefined;
  try {
    await unlink(pending).catch((error) => {
      if (!missing(error)) throw error;
    });
    try {
      checkedAsset(destination, descriptor);
      return;
    } catch (error) {
      if (!missing(error)) throw error;
    }
    // Keep Bun's extracted paths short, with a fresh directory per install.
    stage = await mkdtemp(
      path.join(realpathSync(os.tmpdir()), "ast-mcp-pack-"),
    );
    const libraryPath = await stagePackWithBun(stage, descriptor, signal);
    const bytes = await sourceBytes(libraryPath, descriptor);
    signal.throwIfAborted();
    const file = await open(pending, "wx", 0o400);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    checkAbi(pending, descriptor);
    signal.throwIfAborted();
    lock.fence();
    linkSync(pending, destination);
    await syncDirectory(directory);
  } finally {
    try {
      await unlink(pending).catch((error) => {
        if (!missing(error)) throw error;
      });
    } finally {
      try {
        if (stage) await cleanStaging(stage);
      } finally {
        lock.release();
      }
    }
  }
}

function waitForInstall<T>(
  pending: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return pending;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cancelled = () => reject(signal.reason);
    signal.addEventListener("abort", cancelled, { once: true });
    void pending
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", cancelled));
  });
}

export async function installNativeLanguagePack(
  config: ResolvedConfig,
  language: PackLanguage,
  options: NativePackOptions & { offline?: boolean } = {},
): Promise<NativePackAsset> {
  options.signal?.throwIfAborted();
  const descriptor = selectedDescriptor(config, language);
  if (!descriptor)
    throw new Error(
      `No pinned native language pack for ${language} on ${process.platform}-${process.arch}`,
    );
  const location = languagePackStore(config, options.checkoutRoot);
  if (!location)
    throw new Error(
      "Project language pack storage requires the host --allow-project-language-packs flag",
    );
  if (options.offline) {
    const existing = activeNativePack(language, config, options.checkoutRoot);
    if (!existing)
      throw new Error(
        `No verified installed ${language} language pack is available offline`,
      );
    return existing;
  }
  const directory = privateStore(location, true);
  const key = path.join(directory, descriptor.filename);
  let pending = pendingInstalls.get(key);
  if (!pending) {
    pending = installInto(directory, descriptor).finally(() =>
      pendingInstalls.delete(key),
    );
    pendingInstalls.set(key, pending);
  }
  await waitForInstall(pending, options.signal);
  const asset = readPack(config, descriptor, options.checkoutRoot);
  if (!asset) throw new Error("The installed language pack is unavailable");
  return asset;
}

export async function resolveNativeLanguagePack(
  config: ResolvedConfig,
  language: string,
  options: NativePackOptions & { allowDownload?: boolean } = {},
): Promise<NativePackAsset | null> {
  options.signal?.throwIfAborted();
  const existing = activeNativePack(language, config, options.checkoutRoot);
  if (existing) return existing;
  if (
    !isPackLanguage(language) ||
    !options.allowDownload ||
    !config.languagePacks?.allowFirstUse
  )
    return null;
  try {
    return await installNativeLanguagePack(config, language, options);
  } catch {
    options.signal?.throwIfAborted();
    return null;
  }
}

export function listNativeLanguagePacks(
  config: ResolvedConfig,
  checkoutRoot?: string,
) {
  return packLanguages.map((language) => {
    const version = packVersions[language];
    const descriptor = selectedDescriptor(config, language);
    if (!descriptor)
      return { language, version, status: "unsupported" as const };
    try {
      const asset = readPack(config, descriptor, checkoutRoot, false);
      if (asset) return { language, ...asset, status: "installed" as const };
    } catch (error) {
      if (!missing(error))
        return {
          language,
          version,
          status: "corrupt" as const,
          reason: error instanceof Error ? error.message : String(error),
        };
    }
    return { language, version, status: "available" as const };
  });
}
