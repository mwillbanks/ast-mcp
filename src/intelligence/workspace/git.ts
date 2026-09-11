import { lstat, readFile, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import { sha256 } from "../../runtime/hash.ts";
import {
  createRevisionId,
  dirtyOverlayArtifactIdentity,
  type ResolvedRevision,
  type RevisionSelector,
  RevisionSelectorSchema,
} from "../contracts/index.ts";
import { WorkspaceError } from "./errors.ts";

export interface GitWorkspaceIdentity {
  branch: string | null;
  checkoutRoot: string;
  commonGitDirectory: string | null;
  gitDirectory: string | null;
  headOid: string | null;
  isGit: boolean;
  isLinkedWorktree: boolean;
  repositoryRoot: string;
}

interface GitResult {
  code: number;
  stderr: string;
  stdout: Uint8Array;
}

function sanitizedGitEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !name.startsWith("GIT_"))
      environment[name] = value;
  }
  environment.GIT_OPTIONAL_LOCKS = "0";
  return environment;
}

async function runGitRaw(
  directory: string,
  args: string[],
): Promise<GitResult> {
  const child = Bun.spawn(["git", "-C", directory, ...args], {
    env: sanitizedGitEnvironment(),
    stderr: "pipe",
    stdout: "pipe",
  });
  const [code, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).bytes(),
  ]);
  return { code, stderr: stderr.trim(), stdout };
}

async function runGitText(directory: string, args: string[]): Promise<string> {
  const result = await runGitRaw(directory, args);
  if (result.code !== 0) {
    throw new WorkspaceError(
      "workspace_git_failure",
      result.stderr || `Git failed with exit code ${result.code}`,
      { args, directory, exitCode: result.code },
    );
  }
  return Buffer.from(result.stdout).toString("utf8").trim();
}

async function canonical(target: string): Promise<string> {
  return realpath(target).catch(() => path.resolve(target));
}

function repositoryAnchor(
  checkoutRoot: string,
  commonGitDirectory: string,
): string {
  if (
    path.basename(commonGitDirectory) === ".git" &&
    path.dirname(commonGitDirectory) !== checkoutRoot
  ) {
    return path.dirname(commonGitDirectory);
  }
  return checkoutRoot;
}

export async function discoverGitWorkspace(
  directory: string,
): Promise<GitWorkspaceIdentity> {
  const selected = await canonical(directory);
  const probe = await runGitRaw(selected, [
    "rev-parse",
    "--is-inside-work-tree",
  ]);
  if (
    probe.code !== 0 ||
    Buffer.from(probe.stdout).toString("utf8").trim() !== "true"
  ) {
    return {
      branch: null,
      checkoutRoot: selected,
      commonGitDirectory: null,
      gitDirectory: null,
      headOid: null,
      isGit: false,
      isLinkedWorktree: false,
      repositoryRoot: selected,
    };
  }

  const values = (
    await runGitText(selected, [
      "rev-parse",
      "--path-format=absolute",
      "--show-toplevel",
      "--git-dir",
      "--git-common-dir",
    ])
  ).split("\n");
  if (values.length !== 3) {
    throw new WorkspaceError(
      "workspace_git_failure",
      "Git returned incomplete workspace identity",
      { directory: selected, values },
    );
  }
  const checkoutRoot = await canonical(values[0] as string);
  const gitDirectory = await canonical(values[1] as string);
  const commonGitDirectory = await canonical(values[2] as string);
  const head = await runGitRaw(checkoutRoot, ["rev-parse", "--verify", "HEAD"]);
  const branch = await runGitRaw(checkoutRoot, [
    "symbolic-ref",
    "--quiet",
    "--short",
    "HEAD",
  ]);
  return {
    branch:
      branch.code === 0
        ? Buffer.from(branch.stdout).toString("utf8").trim() || null
        : null,
    checkoutRoot,
    commonGitDirectory,
    gitDirectory,
    headOid:
      head.code === 0
        ? Buffer.from(head.stdout).toString("utf8").trim() || null
        : null,
    isGit: true,
    isLinkedWorktree: gitDirectory !== commonGitDirectory,
    repositoryRoot: await canonical(
      repositoryAnchor(checkoutRoot, commonGitDirectory),
    ),
  };
}

async function refForSelector(
  git: GitWorkspaceIdentity,
  selector: RevisionSelector,
): Promise<string | undefined> {
  if (selector.kind === "commit") return selector.oid;
  if (selector.kind !== "branch" && selector.kind !== "tag") return undefined;
  const ref = `refs/${selector.kind === "branch" ? "heads" : "tags"}/${selector.name}`;
  const validations = [
    runGitRaw(git.checkoutRoot, ["check-ref-format", ref]),
    ...(selector.kind === "branch"
      ? [
          runGitRaw(git.checkoutRoot, [
            "check-ref-format",
            "--branch",
            selector.name,
          ]),
        ]
      : []),
  ];
  const validation = (await Promise.all(validations)).find(
    (result) => result.code !== 0,
  );
  if (validation) {
    throw new WorkspaceError(
      "workspace_revision_invalid",
      `Invalid ${selector.kind} name`,
      {
        selector,
        stderr: validation.stderr,
      },
    );
  }
  return ref;
}

function intentToAddPaths(status: Uint8Array): string[] {
  return Buffer.from(status)
    .toString("utf8")
    .split("\0")
    .flatMap((record) => {
      const match = /^1 \.A [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ (.*)$/su.exec(
        record,
      );
      return match?.[1] ? [match[1]] : [];
    });
}

async function intentToAddIdentity(
  checkoutRoot: string,
  repositoryPath: string,
) {
  const absolutePath = path.join(checkoutRoot, repositoryPath);
  const metadata = await lstat(absolutePath).catch(() => undefined);
  if (!metadata)
    return { contentDigest: null, kind: "missing", path: repositoryPath };
  const content = metadata.isSymbolicLink()
    ? await readlink(absolutePath)
    : await readFile(absolutePath);
  return {
    contentDigest: sha256(content),
    kind: metadata.isSymbolicLink() ? "symlink" : "file",
    path: repositoryPath,
  };
}

export async function gitIndexFingerprint(
  git: GitWorkspaceIdentity,
): Promise<string> {
  if (!git.isGit)
    throw new WorkspaceError(
      "workspace_revision_invalid",
      "Index fingerprints require a Git workspace",
    );
  const [listing, status] = await Promise.all([
    runGitRaw(git.checkoutRoot, ["ls-files", "--stage", "-z"]),
    runGitRaw(git.checkoutRoot, [
      "status",
      "--porcelain=v2",
      "-z",
      "--untracked-files=no",
    ]),
  ]);
  const failed = [listing, status].find((result) => result.code !== 0);
  if (failed)
    throw new WorkspaceError(
      "workspace_git_failure",
      failed.stderr || "Unable to fingerprint the Git index",
      { checkoutRoot: git.checkoutRoot },
    );
  const intentToAdd = await Promise.all(
    intentToAddPaths(status.stdout)
      .sort((left, right) => left.localeCompare(right))
      .map((repositoryPath) =>
        intentToAddIdentity(git.checkoutRoot, repositoryPath),
      ),
  );
  return sha256(
    JSON.stringify({
      indexEntries: Buffer.from(listing.stdout).toString("base64"),
      intentToAdd,
      version: 1,
    }),
  );
}

export async function resolveRevision(
  git: GitWorkspaceIdentity,
  repositoryId: string,
  input: RevisionSelector = { kind: "working" },
): Promise<ResolvedRevision> {
  const selector = RevisionSelectorSchema.parse(input);
  if (!git.isGit && selector.kind !== "working") {
    throw new WorkspaceError(
      "workspace_revision_invalid",
      "Non-Git workspaces support only the working revision",
      { selector },
    );
  }

  let resolvedCommitOid =
    selector.kind === "index" ? await gitIndexFingerprint(git) : git.headOid;
  const ref = await refForSelector(git, selector);
  if (ref) {
    const result = await runGitRaw(git.checkoutRoot, [
      "rev-parse",
      "--verify",
      `${ref}^{commit}`,
    ]);
    if (result.code !== 0) {
      throw new WorkspaceError(
        "workspace_revision_invalid",
        `Unable to resolve ${selector.kind} revision`,
        { selector, stderr: result.stderr },
      );
    }
    resolvedCommitOid =
      Buffer.from(result.stdout).toString("utf8").trim() || null;
  }

  return {
    readOnly: selector.kind !== "working",
    resolvedCommitOid,
    revisionId: createRevisionId({
      repositoryId,
      resolvedCommitOid,
      selector,
    }),
    selector,
  };
}

function repositoryRelativePath(
  git: GitWorkspaceIdentity,
  absolutePath: string,
): string {
  const relative = path.relative(git.checkoutRoot, absolutePath);
  if (
    relative === "" ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    throw new WorkspaceError(
      "workspace_mismatch",
      "Revision path must identify a file inside the selected checkout",
      { absolutePath, checkoutRoot: git.checkoutRoot },
    );
  }
  return relative.split(path.sep).join("/");
}

export async function readGitRevisionFile(
  git: GitWorkspaceIdentity,
  revision: ResolvedRevision,
  absolutePath: string,
): Promise<Uint8Array> {
  if (!git.isGit || revision.selector.kind === "working") {
    throw new WorkspaceError(
      "workspace_revision_invalid",
      "Git revision reads require a historical or index workspace",
      { selector: revision.selector },
    );
  }
  const relative = repositoryRelativePath(git, absolutePath);
  const object =
    revision.selector.kind === "index"
      ? `:${relative}`
      : `${revision.resolvedCommitOid}:${relative}`;
  const result = await runGitRaw(git.checkoutRoot, ["show", object]);
  if (result.code !== 0) {
    throw new WorkspaceError(
      "workspace_revision_invalid",
      `File is unavailable in the selected ${revision.selector.kind} revision`,
      { path: relative, selector: revision.selector, stderr: result.stderr },
    );
  }
  return result.stdout;
}

async function directoryStateDigest(
  directory: string,
  statusCode: string,
): Promise<string> {
  const [head, status] = await Promise.all([
    runGitRaw(directory, ["rev-parse", "--verify", "HEAD"]),
    runGitRaw(directory, ["status", "--porcelain=v1", "-z"]),
  ]);
  return sha256(
    Buffer.concat([
      Buffer.from(statusCode),
      Buffer.from(head.stdout),
      Buffer.from(status.stdout),
    ]),
  );
}

interface GitStatusRecord {
  code: string;
  path: string;
  sourcePath?: string;
}

function normalizedStatusPath(value: string): string {
  return value.split(path.sep).join("/").replace(/\/+$/u, "");
}

export function parseGitPorcelainV1Z(
  output: Uint8Array | string,
): GitStatusRecord[] {
  const fields = (
    typeof output === "string" ? output : Buffer.from(output).toString("utf8")
  )
    .split("\0")
    .filter(Boolean);
  const records: GitStatusRecord[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index] as string;
    const code = field.slice(0, 2);
    const destination = normalizedStatusPath(field.slice(3));
    if (!destination) continue;
    const renamedOrCopied =
      code[0] === "R" || code[0] === "C" || code[1] === "R" || code[1] === "C";
    const source = renamedOrCopied ? fields[++index] : undefined;
    records.push({
      code,
      path: destination,
      sourcePath: source ? normalizedStatusPath(source) : undefined,
    });
  }
  return records;
}

type DirtyEntry = {
  contentDigest: string | null;
  path: string;
  status: "added" | "modified" | "deleted";
};

async function dirtyEntry(
  git: GitWorkspaceIdentity,
  filePath: string,
  code: string,
  forcedStatus?: DirtyEntry["status"],
): Promise<DirtyEntry> {
  const absolute = path.join(git.checkoutRoot, filePath);
  const metadata = await lstat(absolute).catch(() => undefined);
  const deleted = forcedStatus === "deleted" || code.includes("D") || !metadata;
  const status =
    forcedStatus ??
    (deleted
      ? "deleted"
      : code === "??" || code.includes("A")
        ? "added"
        : "modified");
  const contentDigest = deleted
    ? null
    : metadata?.isDirectory()
      ? await directoryStateDigest(absolute, code)
      : sha256(
          metadata?.isSymbolicLink()
            ? await readlink(absolute)
            : await readFile(absolute),
        );
  return { contentDigest, path: filePath, status };
}

export async function gitDirtyOverlayId(
  git: GitWorkspaceIdentity,
  repositoryId: string,
  baseRevisionId: string,
): Promise<string | null> {
  if (!git.isGit) return null;
  const result = await runGitRaw(git.checkoutRoot, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  if (result.code !== 0)
    throw new WorkspaceError(
      "workspace_git_failure",
      result.stderr || "Unable to inspect Git working state",
      { checkoutRoot: git.checkoutRoot },
    );
  const records = parseGitPorcelainV1Z(result.stdout);
  const entries: DirtyEntry[] = [];
  for (const record of records) {
    entries.push(await dirtyEntry(git, record.path, record.code));
    if (record.sourcePath) {
      const copied = record.code.includes("C");
      entries.push(
        await dirtyEntry(
          git,
          record.sourcePath,
          record.code,
          copied ? "modified" : "deleted",
        ),
      );
    }
  }
  if (entries.length === 0) return null;
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return dirtyOverlayArtifactIdentity({
    baseRevisionId,
    checkoutRoot: git.checkoutRoot,
    entries,
    repositoryId,
  });
}

export async function gitWorkingState(git: GitWorkspaceIdentity) {
  if (!git.isGit)
    return { deleted: false, dirty: false, staged: false, untracked: false };
  const result = await runGitRaw(git.checkoutRoot, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  if (result.code !== 0) {
    throw new WorkspaceError(
      "workspace_git_failure",
      result.stderr || "Unable to inspect Git working state",
      { checkoutRoot: git.checkoutRoot },
    );
  }
  const records = parseGitPorcelainV1Z(result.stdout);
  return {
    deleted: records.some(
      (record) =>
        record.code[0] === "D" ||
        record.code[1] === "D" ||
        record.code.includes("R"),
    ),
    dirty: records.length > 0,
    staged: records.some(
      (record) => record.code[0] !== " " && record.code[0] !== "?",
    ),
    untracked: records.some((record) => record.code === "??"),
  };
}
