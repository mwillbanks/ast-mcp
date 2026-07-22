import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { callAstBro } from "../ast-bro/client";
import { parseAstBroJson } from "../ast-bro/result";
import { astRewritable } from "../ast-bro/rewrite-capability";
import {
  applyFileChattr,
  type FileChattr,
  resultingFileChattr,
} from "../runtime/attributes";
import { FILE_READ_MAX_BATCH } from "../runtime/file-read";
import { formatContent } from "../runtime/format";
import { sha256 } from "../runtime/hash";
import { withFileLock } from "../runtime/locks";
import { resolveWritablePath } from "../runtime/paths";

import { applyAiderBlock } from "./aider";
import { detectAstLanguage } from "./languages";

export interface AstRule {
  expectedMatches?: number;
  fix: string;
  pattern: string;
}
export interface AiderBlock {
  replace: string;
  search: string;
}
export interface PatchRequest {
  aiderBlock?: AiderBlock;
  astRule?: AstRule;
  expectedSha256: string;
  filePath: string;
  patchStrategy: "ast" | "aider_block";
  preview?: boolean;
}

export interface PatchBatchRequest {
  aiderBlocks?: AiderBlock[];
  astRules?: AstRule[];
  chattr?: FileChattr;
  expectedSha256: string;
  patchStrategy: "ast" | "aider_block";
  preview?: boolean;
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

async function commit(
  filePath: string,
  content: string,
  mode?: number,
  expectedSha256?: string,
  chattr?: FileChattr,
): Promise<string[]> {
  const next = temporary(filePath);
  let createdDirectories: string[] = [];
  try {
    const formatted = await formatContent(filePath, content);
    try {
      await writeFile(next, formatted, { encoding: "utf8", flag: "wx", mode });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      createdDirectories = await ensureParent(filePath);
      await writeFile(next, formatted, { encoding: "utf8", flag: "wx", mode });
    }
    if (mode !== undefined) await chmod(next, mode);
    await applyFileChattr(next, chattr);
    if (expectedSha256) {
      const current = await readFile(filePath, "utf8");
      const actual = sha256(current);
      if (actual !== expectedSha256)
        throw new Error(
          `Stale file context: expected ${expectedSha256}, found ${actual}`,
        );
    }
    await rename(next, filePath);
    return createdDirectories;
  } finally {
    await removeTemporary(next);
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

async function applyPatchBatch(
  inputPath: string,
  request: PatchBatchRequest,
): Promise<Record<string, unknown>> {
  const filePath = await resolveWritablePath(inputPath);
  return withFileLock(filePath, async () => {
    const original = await readFile(filePath, "utf8");
    const actual = sha256(original);
    if (actual !== request.expectedSha256)
      throw new Error(
        "Stale file context: expected " +
          request.expectedSha256 +
          ", found " +
          actual,
      );

    const astRules = request.astRules ?? [];
    const aiderBlocks = request.aiderBlocks ?? [];
    const language = detectAstLanguage(filePath);
    const rewritable = await astRewritable(filePath, language);
    const previewResult = async (
      candidate: string,
      metadata: {
        operations: number;
        strategy: "ast" | "aider_block";
        matches?: number;
        matchMethods?: string[];
      },
    ) => {
      const formatted = await formatContent(filePath, candidate);
      return {
        changed: formatted !== original,
        diff: previewDiff(filePath, original, formatted),
        filePath,
        matches: metadata.matches,
        matchMethods: metadata.matchMethods,
        operations: metadata.operations,
        preview: true,
        sha256: sha256(formatted),
        strategy: metadata.strategy,
      };
    };

    if (request.patchStrategy === "ast") {
      if (!rewritable || !language)
        throw new Error(
          "REJECTED: non-structurally-rewritable files require patchStrategy 'aider_block' with aiderBlocks",
        );
      if (astRules.length === 0 || aiderBlocks.length > 0)
        throw new Error(
          "REJECTED: patchStrategy 'ast' requires astRules and no aiderBlocks",
        );

      const next = temporary(filePath);
      const metadata = await lstat(filePath);
      try {
        await writeFile(next, original, {
          encoding: "utf8",
          flag: "wx",
          mode: metadata.mode,
        });
        let totalMatches = 0;
        for (const rule of astRules) {
          const preview = parseAstBroJson(
            await callAstBro(
              "run",
              {
                json: true,
                lang: language,
                paths: [next],
                pattern: rule.pattern,
              },
              path.dirname(filePath),
            ),
          );
          if (preview.error_count)
            throw new Error(
              `ast-bro preview failed with ${preview.error_count} errors`,
            );
          const matches = Array.isArray(preview.matches)
            ? preview.matches.length
            : 0;
          const expected = rule.expectedMatches ?? 1;
          if (matches !== expected)
            throw new Error(
              `AST rule matched ${matches} nodes; expected ${expected}`,
            );
          if (expected !== 1)
            throw new Error(
              "ast-bro run rewrites only the first match per file; narrow the AST rule to exactly one node",
            );

          const rewritten = parseAstBroJson(
            await callAstBro(
              "run",
              {
                json: true,
                lang: language,
                paths: [next],
                pattern: rule.pattern,
                rewrite: rule.fix,
                write: true,
              },
              path.dirname(filePath),
            ),
          );
          if (
            rewritten.error_count ||
            rewritten.rewrite_count !== 1 ||
            rewritten.files?.[0]?.status !== "rewritten"
          )
            throw new Error("ast-bro run did not rewrite exactly one file");
          totalMatches += matches;
        }

        const candidate = await readFile(next, "utf8");
        if (request.preview)
          return previewResult(candidate, {
            matches: totalMatches,
            operations: astRules.length,
            strategy: "ast",
          });

        await commit(
          filePath,
          candidate,
          metadata.mode,
          actual,
          request.chattr,
        );
        const updated = await readFile(filePath, "utf8");
        return {
          engine: "ast-bro.run",
          filePath,
          matches: totalMatches,
          operations: astRules.length,
          preview: false,
          sha256: sha256(updated),
          strategy: "ast",
        };
      } finally {
        await removeTemporary(next);
      }
    }

    if (rewritable)
      throw new Error(
        "REJECTED: structurally rewritable files require patchStrategy 'ast' with astRules",
      );
    if (aiderBlocks.length === 0 || astRules.length > 0)
      throw new Error(
        "REJECTED: patchStrategy 'aider_block' requires aiderBlocks and no astRules",
      );

    let content = original;
    const methods: string[] = [];
    for (const block of aiderBlocks) {
      const result = applyAiderBlock(content, block.search, block.replace);
      content = result.content;
      methods.push(result.method);
    }
    if (request.preview)
      return previewResult(content, {
        matchMethods: methods,
        operations: aiderBlocks.length,
        strategy: "aider_block",
      });

    await commit(
      filePath,
      content,
      (await lstat(filePath)).mode,
      actual,
      request.chattr,
    );
    const updated = await readFile(filePath, "utf8");
    return {
      filePath,
      matchMethods: methods,
      operations: aiderBlocks.length,
      preview: false,
      sha256: sha256(updated),
      strategy: "aider_block",
    };
  });
}

export async function patchFile(
  request: PatchRequest,
): Promise<Record<string, unknown>> {
  return applyPatchBatch(request.filePath, {
    aiderBlocks: request.aiderBlock ? [request.aiderBlock] : undefined,
    astRules: request.astRule ? [request.astRule] : undefined,
    expectedSha256: request.expectedSha256,
    patchStrategy: request.patchStrategy,
    preview: request.preview,
  });
}

export async function patchFiles(
  requests: PatchBatch,
): Promise<Record<string, unknown>> {
  const entries = Object.entries(requests);
  if (entries.length < 1 || entries.length > FILE_READ_MAX_BATCH)
    throw new Error(
      `file_patch requires between 1 and ${FILE_READ_MAX_BATCH} files`,
    );
  const files: Record<string, unknown> = {};
  for (const [filePath, request] of entries)
    files[filePath] = await applyPatchBatch(filePath, request);
  return { files };
}

export async function writeFileSafely(args: {
  chattr?: FileChattr;
  filePath: string;
  content: string;
  expectedSha256?: string;
}): Promise<Record<string, unknown>> {
  const filePath = await resolveWritablePath(args.filePath);
  return withFileLock(filePath, async () => {
    const existing = await readFile(filePath, "utf8").catch(() => undefined);
    let createdDirectories: string[];
    if (existing !== undefined) {
      if (!args.expectedSha256)
        throw new Error("Overwriting an existing file requires expectedSha256");
      const actual = sha256(existing);
      if (actual !== args.expectedSha256)
        throw new Error(
          "Stale file context: expected " +
            args.expectedSha256 +
            ", found " +
            actual,
        );
      const language = detectAstLanguage(filePath);
      if (await astRewritable(filePath, language))
        throw new Error(
          "REJECTED: structurally rewritable existing files require file_patch with patchStrategy 'ast'",
        );
      createdDirectories = await commit(
        filePath,
        args.content,
        (await lstat(filePath)).mode,
        actual,
        args.chattr,
      );
    } else
      createdDirectories = await commit(
        filePath,
        args.content,
        undefined,
        undefined,
        args.chattr,
      );
    const updated = await readFile(filePath, "utf8");
    return {
      chattr: await resultingFileChattr(filePath),
      created: existing === undefined,
      createdDirectories,
      filePath,
      sha256: sha256(updated),
    };
  });
}

export async function writeFilesSafely(
  requests: FileWriteBatch,
): Promise<Record<string, unknown>> {
  const entries = Object.entries(requests);
  if (entries.length < 1 || entries.length > FILE_READ_MAX_BATCH)
    throw new Error(
      `file_write requires between 1 and ${FILE_READ_MAX_BATCH} files`,
    );
  const files: Record<string, unknown> = {};
  for (const [filePath, request] of entries)
    files[filePath] = await writeFileSafely({
      chattr: request.chattr,
      content: request.content,
      expectedSha256: request.expectedSha256,
      filePath,
    });
  return { files };
}
