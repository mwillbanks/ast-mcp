import { Worker } from "node:worker_threads";
import * as z from "zod/v4";
import { type SyntaxFacts, sha256 } from "../../parser/index.ts";
import type { SystemsAnalyzeRequest } from "./types.ts";

export const systemsExtractorFingerprint = sha256(
  "tree-sitter-wasm@1.1.8+web-tree-sitter@0.27.0",
);
export const SYSTEMS_WORKER_LIMITS = {
  maxOutstandingBytes: 8 * 1024 * 1024,
  maxPendingRequests: 64,
  timeoutMs: 10_000,
} as const;

export class SystemsWorkerError extends Error {
  constructor(
    readonly code:
      | "aborted"
      | "closed"
      | "queue-full"
      | "timeout"
      | "worker-exit"
      | "protocol",
    message: string,
  ) {
    super(message);
    this.name = "SystemsWorkerError";
  }
}

interface WorkerSuccess {
  facts: SyntaxFacts;
  id: number;
  ok: true;
  type: "result";
}
interface WorkerFailure {
  error: string;
  id: number;
  ok: false;
  type: "result";
}
type WorkerResponse = WorkerSuccess | WorkerFailure;

const nonnegativeInteger = z.number().int().nonnegative();
const positiveId = z.number().int().positive().safe();
const coordinateSchema = z
  .object({
    byteOffset: nonnegativeInteger,
    characterOffset: nonnegativeInteger,
    column: nonnegativeInteger,
    line: nonnegativeInteger,
    utf16Column: nonnegativeInteger,
    utf16Offset: nonnegativeInteger,
  })
  .strict();
const positionSchema = z
  .object({ column: nonnegativeInteger, line: nonnegativeInteger })
  .strict();
const rangeSchema = z
  .object({
    end: positionSchema,
    endByte: nonnegativeInteger,
    endCoordinate: coordinateSchema,
    start: positionSchema,
    startByte: nonnegativeInteger,
    startCoordinate: coordinateSchema,
  })
  .strict();
const nullableString = z.string().nullable();
const nodeSchema = z
  .object({
    childIds: z.array(z.string()),
    id: z.string(),
    kind: z.string(),
    named: z.boolean(),
    parentId: nullableString,
    range: rangeSchema,
  })
  .strict();
const symbolSchema = z
  .object({
    declarationRange: rangeSchema,
    exported: z.boolean(),
    id: z.string(),
    kind: z.enum([
      "class",
      "interface",
      "function",
      "method",
      "variable",
      "type",
      "enum",
      "namespace",
      "unknown",
    ]),
    name: z.string(),
    qualifiedName: z.string(),
    range: rangeSchema,
  })
  .strict();
const importSchema = z
  .object({
    id: z.string(),
    importedName: z.string(),
    localName: z.string(),
    range: rangeSchema,
    source: z.string(),
    typeOnly: z.boolean(),
  })
  .strict();
const exportSchema = z
  .object({
    exportedName: z.string(),
    id: z.string(),
    localName: nullableString,
    range: rangeSchema,
    source: nullableString,
    typeOnly: z.boolean(),
  })
  .strict();
const callSchema = z
  .object({
    callee: z.string(),
    enclosingSymbolId: nullableString,
    id: z.string(),
    range: rangeSchema,
  })
  .strict();
const relationshipSchema = z
  .object({
    id: z.string(),
    range: rangeSchema,
    sourceSymbolId: nullableString,
    targetName: z.string(),
  })
  .strict();
const referenceSchema = z
  .object({
    enclosingSymbolId: nullableString,
    id: z.string(),
    name: z.string(),
    range: rangeSchema,
    role: z.enum(["read", "write", "type"]),
  })
  .strict();
const diagnosticSchema = z
  .object({
    code: z.enum(["parse-error", "missing-node", "truncated"]),
    message: z.string(),
    range: rangeSchema,
    severity: z.enum(["error", "warning"]),
  })
  .strict();
const syntaxFactsSchema = z
  .object({
    calls: z.array(callSchema),
    diagnostics: z.array(diagnosticSchema),
    exports: z.array(exportSchema),
    extractorFingerprint: z.string(),
    grammarFingerprint: z.string(),
    implementations: z.array(relationshipSchema),
    imports: z.array(importSchema),
    inheritance: z.array(relationshipSchema),
    languageId: z.string(),
    nodes: z.array(nodeSchema),
    parserFingerprint: z.string(),
    partial: z.boolean(),
    references: z.array(referenceSchema),
    rootNodeId: z.string(),
    schemaVersion: z.literal("ast-mcp.syntax-facts.v1"),
    sourceArtifactId: z.string(),
    sourceDigest: z.string(),
    symbols: z.array(symbolSchema),
    syntaxFactsArtifactId: z.string(),
  })
  .strict();
const workerResponseSchema = z.discriminatedUnion("ok", [
  z
    .object({
      facts: syntaxFactsSchema,
      id: positiveId,
      ok: z.literal(true),
      type: z.literal("result"),
    })
    .strict(),
  z
    .object({
      error: z.string(),
      id: positiveId,
      ok: z.literal(false),
      type: z.literal("result"),
    })
    .strict(),
]);

function validateFactConsistency(
  facts: SyntaxFacts,
  expected: { languageId: string; source: string },
): void {
  const fail = () => {
    throw new SystemsWorkerError(
      "protocol",
      "SYSTEMS worker facts are internally inconsistent",
    );
  };
  const hex = /^[a-f0-9]{64}$/;
  const ranges = [
    ...facts.nodes.map((item) => item.range),
    ...facts.symbols.flatMap((item) => [item.range, item.declarationRange]),
    ...facts.imports.map((item) => item.range),
    ...facts.exports.map((item) => item.range),
    ...facts.calls.map((item) => item.range),
    ...facts.inheritance.map((item) => item.range),
    ...facts.implementations.map((item) => item.range),
    ...facts.references.map((item) => item.range),
    ...facts.diagnostics.map((item) => item.range),
  ];
  for (const range of ranges) {
    const a = range.startCoordinate,
      b = range.endCoordinate;
    if (
      range.startByte !== a.byteOffset ||
      range.endByte !== b.byteOffset ||
      range.start.line !== a.line ||
      range.start.column !== a.column ||
      range.end.line !== b.line ||
      range.end.column !== b.column ||
      a.byteOffset > b.byteOffset ||
      a.utf16Offset > b.utf16Offset ||
      a.characterOffset > b.characterOffset ||
      a.line > b.line ||
      (a.line === b.line &&
        (a.column > b.column || a.utf16Column > b.utf16Column))
    )
      fail();
  }
  const collections = [
    facts.nodes,
    facts.symbols,
    facts.imports,
    facts.exports,
    facts.calls,
    facts.inheritance,
    facts.implementations,
    facts.references,
  ];
  const ids = collections.flatMap((items) => items.map((item) => item.id));
  if (ids.some((id) => !hex.test(id)) || new Set(ids).size !== ids.length)
    fail();
  const nodeIds = new Set(facts.nodes.map((node) => node.id));
  if (!nodeIds.has(facts.rootNodeId)) fail();
  for (const node of facts.nodes) {
    if (
      (node.parentId && !nodeIds.has(node.parentId)) ||
      new Set(node.childIds).size !== node.childIds.length ||
      node.childIds.some((id) => !nodeIds.has(id))
    )
      fail();
  }
  const symbolIds = new Set(facts.symbols.map((symbol) => symbol.id));
  const symbolPointers = [
    ...facts.calls.map((item) => item.enclosingSymbolId),
    ...facts.references.map((item) => item.enclosingSymbolId),
    ...facts.inheritance.map((item) => item.sourceSymbolId),
    ...facts.implementations.map((item) => item.sourceSymbolId),
  ];
  if (symbolPointers.some((id) => id !== null && !symbolIds.has(id))) fail();
  const digest = sha256(expected.source);
  const grammarIdentity =
    expected.languageId === "apex"
      ? "java:apex-compatible-subset-v1"
      : expected.languageId;
  const fingerprint = sha256(
    JSON.stringify(["tree-sitter-wasm", "1.1.8", grammarIdentity]),
  );
  const syntaxId = sha256(
    JSON.stringify([
      digest,
      fingerprint,
      facts.symbols.map((x) => x.id),
      facts.imports.map((x) => x.id),
      facts.calls.map((x) => x.id),
      facts.inheritance.map((x) => x.id),
      facts.implementations.map((x) => x.id),
      facts.exports.map((x) => x.id),
    ]),
  );
  if (
    facts.languageId !== expected.languageId ||
    facts.sourceDigest !== digest ||
    facts.sourceArtifactId !== sha256(JSON.stringify(["source", digest])) ||
    facts.extractorFingerprint !== fingerprint ||
    facts.grammarFingerprint !== fingerprint ||
    facts.parserFingerprint !== sha256("web-tree-sitter@0.27.0") ||
    facts.syntaxFactsArtifactId !== syntaxId ||
    ![
      facts.sourceDigest,
      facts.sourceArtifactId,
      facts.extractorFingerprint,
      facts.grammarFingerprint,
      facts.parserFingerprint,
      facts.syntaxFactsArtifactId,
      facts.rootNodeId,
    ].every((id) => hex.test(id))
  )
    fail();
}

export function validateSystemsWorkerResponse(
  value: unknown,
  expected?: { id: number; languageId: string; source: string },
): WorkerResponse {
  const response = workerResponseSchema.parse(value) as WorkerResponse;
  if (expected && response.id !== expected.id) {
    throw new SystemsWorkerError(
      "protocol",
      "SYSTEMS worker response id mismatch",
    );
  }
  if (expected && response.ok) {
    const sourceDigest = sha256(expected.source);
    const sourceArtifactId = sha256(JSON.stringify(["source", sourceDigest]));
    if (
      response.facts.languageId !== expected.languageId ||
      response.facts.sourceDigest !== sourceDigest ||
      response.facts.sourceArtifactId !== sourceArtifactId
    ) {
      throw new SystemsWorkerError(
        "protocol",
        "SYSTEMS worker facts do not match the requested language and source",
      );
    }
    validateFactConsistency(response.facts, expected);
  }
  return response;
}

interface Pending {
  bytes: number;
  cleanup(): void;
  languageId: string;
  reject(error: Error): void;
  resolve(facts: SyntaxFacts): void;
  source: string;
}
let worker: Worker | undefined;
let nextId = 1;
let outstandingBytes = 0;
let termination: Promise<void> | undefined;
const pending = new Map<number, Pending>();
const drainWaiters = new Set<() => void>();

function notifyDrained(): void {
  if (pending.size !== 0 || termination) return;
  for (const resolve of drainWaiters) resolve();
  drainWaiters.clear();
}
function finish(id: number): Pending | undefined {
  const request = pending.get(id);
  if (!request) return undefined;
  pending.delete(id);
  outstandingBytes -= request.bytes;
  request.cleanup();
  notifyDrained();
  return request;
}
export function rejectPendingSystemsRequests(error: unknown): void {
  const failure = error instanceof Error ? error : new Error(String(error));
  const requests = [...pending.entries()];
  for (const [id, request] of requests) {
    finish(id);
    request.reject(failure);
  }
  worker = undefined;
}
export function handleSystemsWorkerError(active: Worker, error: Error): void {
  if (worker === active) rejectPendingSystemsRequests(error);
}
async function terminateWorker(
  active: Worker | undefined,
  failure: SystemsWorkerError,
  canceledId?: number,
): Promise<void> {
  if (canceledId !== undefined) {
    active?.postMessage({ id: canceledId, type: "cancel" });
  }
  if (!termination) {
    worker = undefined;
    termination = (async () => {
      if (active) await active.terminate();
      rejectPendingSystemsRequests(failure);
    })().finally(() => {
      termination = undefined;
      notifyDrained();
    });
  }
  await termination;
}
export function handleSystemsWorkerResponse(
  active: Worker,
  value: unknown,
): void {
  try {
    const response = validateSystemsWorkerResponse(value);
    const pendingRequest = pending.get(response.id);
    if (!pendingRequest) return;
    const validated = validateSystemsWorkerResponse(value, {
      id: response.id,
      languageId: pendingRequest.languageId,
      source: pendingRequest.source,
    });
    const request = finish(validated.id);
    if (!request) return;
    if (validated.ok) request.resolve(validated.facts);
    else request.reject(new Error(validated.error));
  } catch {
    void terminateWorker(
      active,
      new SystemsWorkerError(
        "protocol",
        "SYSTEMS parser worker returned an invalid response",
      ),
    );
  }
}
export function handleSystemsWorkerExit(active: Worker, code: number): void {
  if (worker !== active) return;
  rejectPendingSystemsRequests(
    new SystemsWorkerError(
      "worker-exit",
      `Systems parser worker exited with code ${code}`,
    ),
  );
}
function parserWorker(): Worker {
  if (worker) return worker;
  const active = new Worker(new URL("./wasm-worker.ts", import.meta.url));
  worker = active;
  active.unref();
  active.on("message", handleSystemsWorkerResponse.bind(undefined, active));
  active.on("error", handleSystemsWorkerError.bind(undefined, active));
  active.on("exit", handleSystemsWorkerExit.bind(undefined, active));
  return active;
}

export function analyzeSystemsLanguage(
  request: SystemsAnalyzeRequest,
): Promise<SyntaxFacts> {
  if (termination) {
    return termination.then(() => analyzeSystemsLanguage(request));
  }
  const bytes = Buffer.byteLength(request.source);
  if (
    pending.size >= SYSTEMS_WORKER_LIMITS.maxPendingRequests ||
    outstandingBytes + bytes > SYSTEMS_WORKER_LIMITS.maxOutstandingBytes
  ) {
    return Promise.reject(
      new SystemsWorkerError("queue-full", "Systems parser capacity exceeded"),
    );
  }
  if (request.signal?.aborted) {
    return Promise.reject(
      new SystemsWorkerError("aborted", "Systems parser request aborted"),
    );
  }
  const id = nextId++;
  const timeoutMs = request.timeoutMs ?? SYSTEMS_WORKER_LIMITS.timeoutMs;
  return new Promise<SyntaxFacts>((resolve, reject) => {
    const abort = () => {
      void terminateWorker(
        worker,
        new SystemsWorkerError("aborted", "Systems parser request aborted"),
        id,
      );
    };
    const timer = setTimeout(() => {
      void terminateWorker(
        worker,
        new SystemsWorkerError("timeout", "Systems parser request timed out"),
        id,
      );
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", abort);
    };
    pending.set(id, {
      bytes,
      cleanup,
      languageId: request.languageId,
      reject,
      resolve,
      source: request.source,
    });
    outstandingBytes += bytes;
    request.signal?.addEventListener("abort", abort, { once: true });
    queueMicrotask(() => {
      if (!pending.has(id)) return;
      parserWorker().postMessage({
        id,
        languageId: request.languageId,
        source: request.source,
        type: "start",
      });
    });
  });
}

export function systemsWorkerStats(): {
  outstandingBytes: number;
  pendingRequests: number;
} {
  return { outstandingBytes, pendingRequests: pending.size };
}
export function drainSystemsLanguageWorker(): Promise<void> {
  if (pending.size === 0 && !termination) return Promise.resolve();
  return new Promise((resolve) => drainWaiters.add(resolve));
}
export async function interruptSystemsLanguageWorker(): Promise<void> {
  const active = worker;
  if (!active) {
    await terminateWorker(
      undefined,
      new SystemsWorkerError(
        "worker-exit",
        "Systems parser worker exited unexpectedly",
      ),
    );
    return;
  }
  handleSystemsWorkerError(
    active,
    new SystemsWorkerError(
      "worker-exit",
      "Systems parser worker exited unexpectedly",
    ),
  );
  await active.terminate();
}
export async function closeSystemsLanguageWorker(): Promise<void> {
  if (termination) await termination;
  await terminateWorker(
    worker,
    new SystemsWorkerError("closed", "Systems parser worker closed"),
  );
}
export async function restartSystemsLanguageWorker(): Promise<void> {
  await closeSystemsLanguageWorker();
}
