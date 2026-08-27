import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

const cache = new Map<string, { fingerprint: string; paths: string[] }>();

export function clearGitWorktreeCache(): void {
  cache.clear();
}

async function gitEntry(
  start: string,
): Promise<{ gitPath: string; workTree: string } | undefined> {
  let current = path.resolve(start);
  while (true) {
    const gitPath = path.join(current, ".git");
    const metadata = await lstat(gitPath).catch(() => undefined);
    if (metadata?.isDirectory() || metadata?.isFile())
      return { gitPath, workTree: current };
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function gitDirPointer(source: string, gitPath: string): string | undefined {
  const match = /^\s*gitdir:\s*(.+?)\s*$/m.exec(source);
  const value = match?.[1]?.trim();
  if (!value) return undefined;
  return path.isAbsolute(value)
    ? path.resolve(value)
    : path.resolve(path.dirname(gitPath), value);
}

async function resolveGitDir(gitPath: string): Promise<string | undefined> {
  const metadata = await lstat(gitPath).catch(() => undefined);
  if (!metadata) return undefined;
  if (metadata.isDirectory()) return gitPath;
  if (!metadata.isFile()) return undefined;
  const source = await readFile(gitPath, "utf8").catch(() => undefined);
  return source ? gitDirPointer(source, gitPath) : undefined;
}

async function commonGitDir(gitDir: string): Promise<string> {
  const source = await readFile(path.join(gitDir, "commondir"), "utf8").catch(
    () => undefined,
  );
  const value = source?.trim();
  if (!value) return gitDir;
  return path.isAbsolute(value)
    ? path.resolve(value)
    : path.resolve(gitDir, value);
}

function mainWorkTree(commonDir: string, discoveredWorkTree: string): string {
  return path.basename(commonDir) === ".git"
    ? path.dirname(commonDir)
    : discoveredWorkTree;
}

async function worktreeFromGitdirFile(
  gitdirFile: string,
): Promise<string | undefined> {
  const source = await readFile(gitdirFile, "utf8").catch(() => undefined);
  const pointer = source?.trim();
  if (!pointer) return undefined;
  const gitFile = path.isAbsolute(pointer)
    ? path.resolve(pointer)
    : path.resolve(path.dirname(gitdirFile), pointer);
  const workTree = path.dirname(gitFile);
  const metadata = await stat(workTree).catch(() => undefined);
  return metadata?.isDirectory() ? workTree : undefined;
}

async function linkedFromGitdirFiles(commonDir: string): Promise<string[]> {
  const worktreesDir = path.join(commonDir, "worktrees");
  const entries = await readdir(worktreesDir, { withFileTypes: true }).catch(
    () => [],
  );
  const paths: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const workTree = await worktreeFromGitdirFile(
      path.join(worktreesDir, entry.name, "gitdir"),
    );
    if (workTree) paths.push(workTree);
  }
  return paths;
}

async function cacheFingerprint(commonDir: string): Promise<string> {
  const gitStat = await stat(commonDir).catch(() => undefined);
  const worktreesStat = await stat(path.join(commonDir, "worktrees")).catch(
    () => undefined,
  );
  return `${gitStat?.mtimeMs ?? 0}:${worktreesStat?.mtimeMs ?? 0}`;
}

async function uniqueCanonical(paths: string[]): Promise<string[]> {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const item of paths) {
    const canonical = await realpath(item).catch(() => path.resolve(item));
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    unique.push(canonical);
  }
  return unique;
}

export async function linkedWorktrees(root: string): Promise<string[]> {
  const entry = await gitEntry(root);
  if (!entry) return [];
  const gitDir = await resolveGitDir(entry.gitPath);
  if (!gitDir) return [];
  const commonDir = await commonGitDir(gitDir);
  const common = await stat(commonDir).catch(() => undefined);
  if (!common?.isDirectory()) return uniqueCanonical([entry.workTree]);
  const fingerprint = await cacheFingerprint(commonDir);
  const cached = cache.get(commonDir);
  if (cached?.fingerprint === fingerprint) return cached.paths;
  const paths = await uniqueCanonical([
    mainWorkTree(commonDir, entry.workTree),
    ...(await linkedFromGitdirFiles(commonDir)),
  ]);
  cache.set(commonDir, { fingerprint, paths });
  return paths;
}
