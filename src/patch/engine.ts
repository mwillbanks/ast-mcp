import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  rename,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { currentConfig } from "../config";
import {
  beginMutation,
  completeMutation,
  failMutation,
  mutationOperationId,
  recordMutationCommit,
  recordMutationRollback,
} from "../intelligence/mutation/index.ts";
import { currentWorkspace } from "../intelligence/workspace/context.ts";
import { approvalSessionId } from "../runtime/approval";
import {
  applyFileChattr,
  type FileChattr,
  resultingFileChattr,
  validateFileChattr,
} from "../runtime/attributes";
import {
  type FileCapabilities,
  inspectFileCapabilities,
  validateStructuredCandidate,
} from "../runtime/file-capabilities";
import { FILE_READ_MAX_BATCH } from "../runtime/file-read";
import { formatContent } from "../runtime/format";
import { sha256 } from "../runtime/hash";
import {
  type FileLockLease,
  withFencedFileLock,
  withFencedFileLocks,
} from "../runtime/locks";
import { resolveWritablePath } from "../runtime/paths";
import { requireExpectedHash, verifyExpectedHash } from "../runtime/policy";
import {
  type AiderBlock,
  type AstRule,
  type PatchStrategyContext,
  type PatchStrategyMetadata,
  patchStrategyAdapter,
} from "./strategy";

function readText(filePath: string): Promise<string> {
  return Bun.file(filePath).text();
}

export interface PatchRequest {
  aiderBlock?: AiderBlock;
  astRule?: AstRule;
  expectedSha256?: string;
  filePath: string;
  patchStrategy: "ast" | "aider_block";
  preview?: boolean;
}

export interface PatchBatchRequest {
  aiderBlocks?: AiderBlock[];
  astRules?: AstRule[];
  chattr?: FileChattr;
  expectedSha256?: string;
  patchStrategy?: "ast" | "aider_block";
  preview?: boolean;
  previewReceipt?: string;
}

export type PatchBatch = Record<string, PatchBatchRequest>;

export interface FileWriteRequest {
  chattr?: FileChattr;
  content: string;
  expectedSha256?: string;
}

export type FileWriteBatch = Record<string, FileWriteRequest>;

function temporary(filePath: string): string {
  const extension = path.extname(filePath);
  return path.join(
    path.dirname(filePath),
    `${path.basename(filePath, extension)}.ast-mcp-${randomUUID()}${extension}`,
  );
}

async function removeTemporary(filePath: string) {
  try {
    await unlink(filePath);
  } catch {}
}

async function ensureParent(filePath: string): Promise<string[]> {
  const parent = path.dirname(filePath);
  const first = await mkdir(parent, { recursive: true });
  const revalidated = await resolveWritablePath(filePath);
  if (revalidated !== filePath)
    throw new Error("Parent creation changed the resolved write path");
  if (!first) return [];
  const created = [first];
  let current = first;
  for (const segment of path.relative(first, parent).split(path.sep)) {
    if (!segment) continue;
    current = path.join(current, segment);
    created.push(current);
  }
  return created;
}

async function ignoreFailure(operation: Promise<unknown>): Promise<void> {
  try {
    await operation;
  } catch {}
}

async function removeCreatedDirectories(directories: string[]): Promise<void> {
  for (const directory of [...directories].reverse())
    await ignoreFailure(rmdir(directory));
}

async function commit(
  filePath: string,
  content: string,
  mode?: number,
  expectedSha256?: string,
  chattr?: FileChattr,
  alreadyFormatted = false,
  beforeReplace?: () => Promise<void>,
): Promise<{
  chattr: Awaited<ReturnType<typeof resultingFileChattr>>;
  createdDirectories: string[];
  sha256: string;
}> {
  const next = temporary(filePath);
  let createdDirectories: string[] = [];
  let committed = false;
  try {
    const parentExists = await lstat(path.dirname(filePath)).then(
      () => true,
      () => false,
    );
    createdDirectories = parentExists ? [] : await ensureParent(filePath);
    const formatted = alreadyFormatted
      ? content
      : await formatContent(filePath, content);
    await beforeReplace?.();
    await writeFile(next, formatted, { encoding: "utf8", flag: "wx", mode });
    if (mode !== undefined) {
      await beforeReplace?.();
      await chmod(next, mode);
    }
    await applyFileChattr(next, chattr, beforeReplace);
    const committedChattr = await resultingFileChattr(next);
    const committedSha256 = sha256(formatted);
    if (expectedSha256) {
      const current = await readText(filePath);
      const actual = sha256(current);
      if (actual !== expectedSha256)
        throw new Error(
          `Stale file context: expected ${expectedSha256}, found ${actual}`,
        );
    }
    await beforeReplace?.();
    await rename(next, filePath);
    committed = true;
    return {
      chattr: committedChattr,
      createdDirectories,
      sha256: committedSha256,
    };
  } finally {
    await removeTemporary(next);
    if (!committed) await removeCreatedDirectories(createdDirectories);
  }
}
function previewDiff(filePath: string, before: string, after: string): string {
  if (before === after) return "";
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  let start = 0;
  while (
    start < beforeLines.length &&
    start < afterLines.length &&
    beforeLines[start] === afterLines[start]
  )
    start += 1;
  let beforeEnd = beforeLines.length;
  let afterEnd = afterLines.length;
  while (
    beforeEnd > start &&
    afterEnd > start &&
    beforeLines[beforeEnd - 1] === afterLines[afterEnd - 1]
  ) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }
  const lines = [
    `--- ${filePath}`,
    `+++ ${filePath}`,
    `@@ -${start + 1},${beforeEnd - start} +${start + 1},${afterEnd - start} @@`,
    ...beforeLines.slice(start, beforeEnd).map((line) => `-${line}`),
    ...afterLines.slice(start, afterEnd).map((line) => `+${line}`),
  ];
  return lines.length > 200
    ? [...lines.slice(0, 199), "... diff truncated"].join("\n")
    : lines.join("\n");
}

interface PatchContext extends PatchStrategyContext {
  actual: string;
  capabilities: FileCapabilities;
  request: PatchBatchRequest;
}

type PreviewMetadata = PatchStrategyMetadata;

interface PreviewReceipt {
  candidate: string;
  candidateSha256: string;
  chattr?: FileChattr;
  configurationIdentity: string;
  expiresAt: number;
  expiryTimer: ReturnType<typeof setTimeout>;
  filePath: string;
  generation: number;
  metadata: PreviewMetadata;
  normalizedOperations: Pick<
    PatchBatchRequest,
    "aiderBlocks" | "astRules" | "chattr" | "patchStrategy"
  >;
  payloadBytes: number;
  sessionId: string;
  sourceSha256: string;
  workspaceBinding: {
    dirtyOverlayId: string | null;
    repositoryId: string;
    revisionId: string;
    storageDomainId: string;
    workspaceId: string;
  } | null;
}

const PREVIEW_RECEIPT_TTL_MS = 5 * 60 * 1000;
const previewConfigurationIdentity = (
  config: Awaited<ReturnType<typeof currentConfig>>,
) =>
  sha256(
    JSON.stringify({
      dependencies: config.dependencies,
      formatting: config.formatting,
      projectRoot: config.projectRoot,
      safety: config.safety,
      sources: config.sources,
      trustedRoots: config.trustedRoots,
      version: config.version,
      workspace: config.workspace,
    }),
  );
const MAX_PREVIEW_CANDIDATE_BYTES = 4 * 1024 * 1024;
const MAX_PREVIEW_SESSION_BYTES = 16 * 1024 * 1024;
const MAX_PREVIEW_SESSION_RECEIPTS = 32;
const previewReceipts = new Map<string, PreviewReceipt>();

function previewPayloadBytes(
  sessionId: string,
  candidate: string,
  operations: PreviewReceipt["normalizedOperations"],
): number {
  const candidateBytes = Buffer.byteLength(candidate);
  const payloadBytes =
    candidateBytes + Buffer.byteLength(JSON.stringify(operations));
  const outstanding = [...previewReceipts.values()].filter(
    (receipt) => receipt.sessionId === sessionId,
  );
  const retainedBytes = outstanding.reduce(
    (total, receipt) => total + receipt.payloadBytes,
    0,
  );
  if (
    candidateBytes > MAX_PREVIEW_CANDIDATE_BYTES ||
    outstanding.length >= MAX_PREVIEW_SESSION_RECEIPTS ||
    retainedBytes + payloadBytes > MAX_PREVIEW_SESSION_BYTES
  )
    throw Object.assign(
      new Error(
        "Preview receipt storage limit exceeded; narrow the patch or commit/discard outstanding previews",
      ),
      { code: "preview_receipt_limit", retryable: true },
    );
  return payloadBytes;
}

async function validatePreviewReceipt(filePath: string, token: string) {
  const receipt = previewReceipts.get(token);
  if (!receipt)
    throw new Error("Preview receipt is unknown or has already been used");
  if (receipt.expiresAt < Date.now()) {
    previewReceipts.delete(token);
    clearTimeout(receipt.expiryTimer);
    throw new Error("Preview receipt has expired; preview the patch again");
  }
  if (receipt.filePath !== filePath)
    throw new Error("Preview receipt does not belong to this file");
  if (receipt.sessionId !== approvalSessionId())
    throw new Error("Preview receipt belongs to a different MCP session");
  const workspace = currentWorkspace();
  const currentBinding = workspace
    ? {
        dirtyOverlayId: workspace.dirtyOverlayId,
        repositoryId: workspace.repositoryId,
        revisionId: workspace.selectedRevision.revisionId,
        storageDomainId: workspace.storageDomain.domainId,
        workspaceId: workspace.workspaceId,
      }
    : null;
  if (
    JSON.stringify(receipt.workspaceBinding) !== JSON.stringify(currentBinding)
  )
    throw new Error(
      "Preview receipt belongs to a different workspace or revision",
    );
  const config = await currentConfig();
  if (
    receipt.generation !== config.generation ||
    receipt.configurationIdentity !== previewConfigurationIdentity(config)
  )
    throw new Error("Preview receipt is stale because configuration changed");
  await resolveWritablePath(filePath);
  const source = await readText(filePath);
  const actual = sha256(source);
  if (actual !== receipt.sourceSha256)
    throw new Error(
      `Stale file context: expected ${receipt.sourceSha256}, found ${actual}`,
    );
  if (sha256(receipt.candidate) !== receipt.candidateSha256)
    throw new Error("Preview receipt candidate integrity check failed");
  return receipt;
}

async function createPatchContext(
  filePath: string,
  request: PatchBatchRequest,
): Promise<PatchContext> {
  const original = await readText(filePath);
  const actual = sha256(original);
  await requireExpectedHash(request.expectedSha256, "file_patch");
  verifyExpectedHash(request.expectedSha256, actual);
  const capabilities = await inspectFileCapabilities(filePath);
  return {
    actual,
    aiderBlocks: request.aiderBlocks ?? [],
    astRules: request.astRules ?? [],
    capabilities,
    filePath,
    language: capabilities.language,
    mode: (await lstat(filePath)).mode,
    original,
    request,
  };
}

async function patchPreview(
  context: PatchContext,
  candidate: string,
  metadata: PreviewMetadata,
) {
  const config = await currentConfig();
  const receipt = randomUUID();
  const expiresAt = Date.now() + PREVIEW_RECEIPT_TTL_MS;
  const sessionId = approvalSessionId();
  const normalizedOperations = {
    aiderBlocks: context.request.aiderBlocks,
    astRules: context.request.astRules,
    chattr: context.request.chattr,
    patchStrategy: context.request.patchStrategy,
  };
  const payloadBytes = previewPayloadBytes(
    sessionId,
    candidate,
    normalizedOperations,
  );
  const expiryTimer = setTimeout(
    previewReceipts.delete.bind(previewReceipts, receipt),
    PREVIEW_RECEIPT_TTL_MS,
  );
  expiryTimer.unref?.();
  previewReceipts.set(receipt, {
    candidate,
    candidateSha256: sha256(candidate),
    chattr: context.request.chattr,
    configurationIdentity: previewConfigurationIdentity(config),
    expiresAt,
    expiryTimer,
    filePath: context.filePath,
    generation: config.generation,
    metadata,
    normalizedOperations,
    payloadBytes,
    sessionId,
    sourceSha256: context.actual,
    workspaceBinding: currentWorkspace()
      ? {
          dirtyOverlayId: currentWorkspace()?.dirtyOverlayId ?? null,
          repositoryId: currentWorkspace()?.repositoryId ?? "",
          revisionId: currentWorkspace()?.selectedRevision.revisionId ?? "",
          storageDomainId: currentWorkspace()?.storageDomain.domainId ?? "",
          workspaceId: currentWorkspace()?.workspaceId ?? "",
        }
      : null,
  });
  return {
    changed: candidate !== context.original,
    diff: previewDiff(context.filePath, context.original, candidate),
    filePath: context.filePath,
    matches: metadata.matches,
    matchMethods: metadata.matchMethods,
    operations: metadata.operations,
    preview: true,
    previewReceipt: receipt,
    receiptExpiresAt: new Date(expiresAt).toISOString(),
    sha256: sha256(candidate),
    strategy: metadata.strategy,
  };
}

async function prepareStrategyPatch(context: PatchContext) {
  const prepared = await patchStrategyAdapter(
    context.request.patchStrategy,
  ).prepare(context);
  await validateStructuredCandidate(context.capabilities, prepared.candidate);
  return { candidate: prepared.candidate, metadata: prepared.metadata };
}

async function formatCandidate(
  filePath: string,
  candidate: string,
  capabilities: FileCapabilities,
) {
  const formatted = await formatContent(filePath, candidate);
  await validateStructuredCandidate(capabilities, formatted);
  return formatted;
}

async function applyLockedPatch(
  filePath: string,
  request: PatchBatchRequest,
  beforeReplace?: () => Promise<void>,
) {
  if (request.previewReceipt)
    return applyPreparedPatch(
      filePath,
      request,
      await preflightPatchBatch(filePath, request),
    );
  const context = await createPatchContext(filePath, request);
  const prepared = await prepareStrategyPatch(context);
  if (request.preview)
    return patchPreview(context, prepared.candidate, prepared.metadata);
  const candidate = await formatCandidate(
    filePath,
    prepared.candidate,
    context.capabilities,
  );
  await commit(
    filePath,
    candidate,
    context.mode,
    context.actual,
    request.chattr,
    true,
    beforeReplace,
  );
  return {
    ...prepared.metadata,
    filePath,
    preview: false,
    sha256: sha256(candidate),
  };
}

async function applyPatchBatch(
  filePath: string,
  request: PatchBatchRequest,
): Promise<Record<string, unknown>> {
  return withFencedFileLock(filePath, (lease) =>
    applyLockedPatch(filePath, request, () => lease.fence()),
  );
}

export async function patchFile(
  request: PatchRequest,
): Promise<Record<string, unknown>> {
  return applyPatchBatch(await resolveWritablePath(request.filePath), {
    aiderBlocks: request.aiderBlock ? [request.aiderBlock] : undefined,
    astRules: request.astRule ? [request.astRule] : undefined,
    expectedSha256: request.expectedSha256,
    patchStrategy: request.patchStrategy,
    preview: request.preview,
  });
}

interface PreparedPatch {
  candidate?: string;
  chattr?: FileChattr;
  mode?: number;
  previewResult?: Record<string, unknown>;
  receiptToken?: string;
  result?: Record<string, unknown>;
  sourceSha256?: string;
}

async function preflightPatchBatch(
  filePath: string,
  request: PatchBatchRequest,
): Promise<PreparedPatch> {
  if (request.preview)
    return { previewResult: await applyLockedPatch(filePath, request) };
  if (request.previewReceipt) {
    const receipt = await validatePreviewReceipt(
      filePath,
      request.previewReceipt,
    );
    await requireExpectedHash(request.expectedSha256, "file_patch");
    verifyExpectedHash(request.expectedSha256, receipt.sourceSha256);
    return {
      candidate: receipt.candidate,
      chattr: receipt.chattr,
      mode: (await lstat(filePath)).mode,
      receiptToken: request.previewReceipt,
      result: {
        filePath,
        matches: receipt.metadata.matches,
        matchMethods: receipt.metadata.matchMethods,
        operations: receipt.metadata.operations,
        preview: false,
        receiptCommitted: true,
        sha256: receipt.candidateSha256,
        strategy: receipt.metadata.strategy,
      },
      sourceSha256: receipt.sourceSha256,
    };
  }

  const context = await createPatchContext(filePath, request);
  const prepared = await prepareStrategyPatch(context);
  return {
    candidate: prepared.candidate,
    chattr: request.chattr,
    mode: context.mode,
    result: {
      ...prepared.metadata,
      filePath,
      preview: false,
      sha256: sha256(prepared.candidate),
    },
    sourceSha256: context.actual,
  };
}

async function applyPreparedPatch(
  filePath: string,
  _request: PatchBatchRequest,
  prepared: PreparedPatch,
  beforeReplace?: () => Promise<void>,
): Promise<Record<string, unknown>> {
  if (prepared.previewResult) return prepared.previewResult;
  if (
    prepared.candidate === undefined ||
    prepared.mode === undefined ||
    !prepared.result ||
    prepared.sourceSha256 === undefined
  )
    throw new Error("Patch batch preflight did not produce a commit candidate");
  const candidate = await formatCandidate(
    filePath,
    prepared.candidate,
    await inspectFileCapabilities(filePath),
  );
  if (prepared.receiptToken) {
    const receipt = previewReceipts.get(prepared.receiptToken);
    if (receipt) clearTimeout(receipt.expiryTimer);
    previewReceipts.delete(prepared.receiptToken);
  }
  await commit(
    filePath,
    candidate,
    prepared.mode,
    prepared.sourceSha256,
    prepared.chattr,
    true,
    beforeReplace,
  );
  return { ...prepared.result, sha256: sha256(candidate) };
}

interface PreparedWrite {
  actual?: string;
  content: string;
  existing: boolean;
  mode?: number;
}

function preparedCandidateSha256(prepared: unknown): string | null {
  const candidate = (prepared as Partial<PreparedPatch>).candidate;
  if (typeof candidate === "string") return sha256(candidate);
  const content = (prepared as Partial<PreparedWrite>).content;
  return typeof content === "string" ? sha256(content) : null;
}

async function preflightFileWrite(
  filePath: string,
  request: FileWriteRequest,
): Promise<PreparedWrite> {
  validateFileChattr(request.chattr);
  const existing = await readText(filePath).catch(() => undefined);
  let actual: string | undefined;
  let mode: number | undefined;
  if (existing !== undefined) {
    await requireExpectedHash(request.expectedSha256, "file_write overwrite");
    actual = sha256(existing);
    verifyExpectedHash(request.expectedSha256, actual);
    const capabilities = await inspectFileCapabilities(filePath);
    if (capabilities.effective.patch.includes("ast"))
      throw new Error(
        "REJECTED: structurally rewritable existing files require file_patch with patchStrategy 'ast'",
      );
    mode = (await lstat(filePath)).mode;
  }
  const parentExists = await lstat(path.dirname(filePath)).then(
    () => true,
    () => false,
  );
  const createdDirectories = parentExists ? [] : await ensureParent(filePath);
  try {
    return {
      actual,
      content: await formatContent(filePath, request.content),
      existing: existing !== undefined,
      mode,
    };
  } finally {
    await removeCreatedDirectories(createdDirectories);
  }
}

interface ResolvedBatchEntry<T> {
  inputPath: string;
  request: T;
  resolvedPath: string;
}

type BatchFileSnapshot =
  | undefined
  | {
      chattr: Awaited<ReturnType<typeof resultingFileChattr>>;
      content: string;
      mode: number;
    };

interface CommittedBatchEntry {
  resolvedPath: string;
  result: Record<string, unknown>;
}

async function optionalContent(filePath: string): Promise<string | undefined> {
  try {
    return await readText(filePath);
  } catch {
    return undefined;
  }
}

async function captureBatchSnapshots<T>(
  entries: ResolvedBatchEntry<T>[],
): Promise<Map<string, BatchFileSnapshot>> {
  const snapshots = new Map<string, BatchFileSnapshot>();
  for (const { resolvedPath } of entries) {
    const content = await optionalContent(resolvedPath);
    snapshots.set(
      resolvedPath,
      content === undefined
        ? undefined
        : {
            chattr: await resultingFileChattr(resolvedPath),
            content,
            mode: (await lstat(resolvedPath)).mode,
          },
    );
  }
  return snapshots;
}

function discardPreparedPreviews<Prepared>(prepared: Prepared[]): void {
  for (const item of prepared) {
    const token = (item as PreparedPatch).previewResult?.previewReceipt;
    if (typeof token !== "string") continue;
    const receipt = previewReceipts.get(token);
    if (receipt) clearTimeout(receipt.expiryTimer);
    previewReceipts.delete(token);
  }
}

async function prepareFileBatch<T, Prepared>(
  entries: ResolvedBatchEntry<T>[],
  preflight: (filePath: string, request: T) => Promise<Prepared>,
): Promise<Prepared[]> {
  const prepared: Prepared[] = [];
  try {
    for (const { request, resolvedPath } of entries)
      prepared.push(await preflight(resolvedPath, request));
    return prepared;
  } catch (error) {
    discardPreparedPreviews(prepared);
    throw error;
  }
}

async function rollbackFileBatch(
  committed: CommittedBatchEntry[],
  snapshots: Map<string, BatchFileSnapshot>,
  fence: () => Promise<void>,
): Promise<void> {
  const failures: unknown[] = [];
  for (const { resolvedPath, result } of committed.reverse()) {
    const snapshot = snapshots.get(resolvedPath);
    try {
      await fence();
      if (snapshot) {
        await commit(
          resolvedPath,
          snapshot.content,
          process.platform === "win32" ? undefined : snapshot.mode,
          undefined,
          process.platform === "win32"
            ? { chmod: snapshot.chattr.chmod }
            : snapshot.chattr,
          true,
          fence,
        );
        continue;
      }
      await unlink(resolvedPath);
      const createdDirectories = result.createdDirectories;
      if (Array.isArray(createdDirectories))
        await removeCreatedDirectories(
          createdDirectories.filter(
            (value): value is string => typeof value === "string",
          ),
        );
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0)
    throw new AggregateError(failures, "Mutation rollback requires recovery");
}

async function executePreparedFileBatch<T, Prepared>(
  tool: "file_patch" | "file_write",
  entries: ResolvedBatchEntry<T>[],
  handler: (
    filePath: string,
    request: T,
    prepared: Prepared,
    beforeReplace: () => Promise<void>,
  ) => Promise<Record<string, unknown>>,
  preflight: (filePath: string, request: T) => Promise<Prepared>,
  mutates: (request: T) => boolean,
  fence: () => Promise<void>,
): Promise<Record<string, unknown>> {
  const snapshots = await captureBatchSnapshots(entries);
  const prepared = await prepareFileBatch(entries, preflight);
  const files: Record<string, unknown> = {};
  const committed: CommittedBatchEntry[] = [];
  const workspace = currentWorkspace() ?? null;
  const plannedEntries = entries.filter((entry) => mutates(entry.request));
  const sourcePlan = plannedEntries.map((entry) => {
    const entryIndex = entries.indexOf(entry);
    const snapshot = snapshots.get(entry.resolvedPath);
    return {
      candidateSha256: preparedCandidateSha256(prepared[entryIndex]),
      filePath: entry.resolvedPath,
      sourceContentBase64: snapshot
        ? Buffer.from(snapshot.content).toString("base64")
        : null,
      sourceGid:
        process.platform === "win32"
          ? null
          : (snapshot?.chattr.chown.gid ?? null),
      sourceMode: snapshot?.mode ?? null,
      sourceSha256: snapshot ? sha256(snapshot.content) : null,
      sourceUid:
        process.platform === "win32"
          ? null
          : (snapshot?.chattr.chown.uid ?? null),
    };
  });
  const operationId = workspace
    ? mutationOperationId({
        files: sourcePlan,
        nonce: randomUUID(),
        storageDomainId: workspace.storageDomain.domainId,
        workspaceId: workspace.workspaceId,
      })
    : randomUUID();
  let began = false;
  try {
    if (plannedEntries.length > 0) {
      await beginMutation({
        files: sourcePlan,
        operationId,
        tool,
        workspace,
      });
      began = true;
    }
    for (const [
      index,
      { inputPath, request, resolvedPath },
    ] of entries.entries()) {
      if (mutates(request)) await fence();
      const result = await handler(
        resolvedPath,
        request,
        prepared[index] as Prepared,
        fence,
      );
      files[inputPath] = result;
      if (mutates(request)) {
        committed.push({ resolvedPath, result });
        if (typeof result.sha256 !== "string")
          throw new Error("Committed mutation did not report its SHA-256");
        await recordMutationCommit(operationId, {
          filePath: resolvedPath,
          sha256: result.sha256,
        });
      }
    }
    const commits = committed.map(({ resolvedPath, result }) => ({
      filePath: resolvedPath,
      sha256: String(result.sha256),
    }));
    const intelligenceRefresh =
      began && commits.length > 0
        ? await completeMutation(operationId, commits)
        : null;
    return intelligenceRefresh ? { files, intelligenceRefresh } : { files };
  } catch (error) {
    discardPreparedPreviews(prepared);
    if (began) await ignoreFailure(failMutation(operationId, error));
    try {
      await rollbackFileBatch(committed, snapshots, fence);
      if (began) await ignoreFailure(recordMutationRollback(operationId));
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "Mutation failed and rollback requires recovery",
      );
    }
    throw error;
  }
}

async function processFileBatch<T, Prepared>(
  tool: "file_patch" | "file_write",
  requests: Record<string, T>,
  handler: (
    filePath: string,
    request: T,
    prepared: Prepared,
    beforeReplace: () => Promise<void>,
  ) => Promise<Record<string, unknown>>,
  preflight: (filePath: string, request: T) => Promise<Prepared>,
  mutates: (request: T) => boolean,
): Promise<Record<string, unknown>> {
  const entries = Object.entries(requests);
  if (entries.length < 1 || entries.length > FILE_READ_MAX_BATCH)
    throw new Error(
      `${tool} requires between 1 and ${FILE_READ_MAX_BATCH} files`,
    );
  const resolvedEntries = await Promise.all(
    entries.map(async ([inputPath, request]) => ({
      inputPath,
      request,
      resolvedPath: await resolveWritablePath(inputPath),
    })),
  );
  return withFencedFileLocks(
    resolvedEntries.map(({ resolvedPath }) => resolvedPath),
    (leases: readonly FileLockLease[]) =>
      executePreparedFileBatch(
        tool,
        resolvedEntries,
        handler,
        preflight,
        mutates,
        async () => {
          for (const lease of leases) await lease.fence();
        },
      ),
  );
}

export async function patchFiles(
  requests: PatchBatch,
): Promise<Record<string, unknown>> {
  return processFileBatch(
    "file_patch",
    requests,
    applyPreparedPatch,
    preflightPatchBatch,
    (request) => request.preview !== true,
  );
}

async function writeFileResolved(
  args: {
    chattr?: FileChattr;
    filePath: string;
    content: string;
    expectedSha256?: string;
  },
  prepared?: PreparedWrite,
  beforeReplace?: () => Promise<void>,
): Promise<Record<string, unknown>> {
  const candidate = prepared ?? (await preflightFileWrite(args.filePath, args));
  const committed = await commit(
    args.filePath,
    candidate.content,
    candidate.mode,
    candidate.actual,
    args.chattr,
    true,
    beforeReplace,
  );
  return {
    chattr: committed.chattr,
    created: !candidate.existing,
    createdDirectories: committed.createdDirectories,
    filePath: args.filePath,
    sha256: committed.sha256,
  };
}

export async function writeFileSafely(args: {
  chattr?: FileChattr;
  filePath: string;
  content: string;
  expectedSha256?: string;
}): Promise<Record<string, unknown>> {
  const filePath = await resolveWritablePath(args.filePath);
  return withFencedFileLock(filePath, (lease) =>
    writeFileResolved({ ...args, filePath }, undefined, () => lease.fence()),
  );
}

export async function writeFilesSafely(
  requests: FileWriteBatch,
): Promise<Record<string, unknown>> {
  return processFileBatch(
    "file_write",
    requests,
    (filePath, request, prepared, beforeReplace) =>
      writeFileResolved(
        {
          chattr: request.chattr,
          content: request.content,
          expectedSha256: request.expectedSha256,
          filePath,
        },
        prepared,
        beforeReplace,
      ),
    preflightFileWrite,
    () => true,
  );
}
