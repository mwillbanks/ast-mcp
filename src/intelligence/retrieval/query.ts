import { createHash } from "node:crypto";

import * as lancedb from "@lancedb/lancedb";

import { type GraphSnapshot, GraphSnapshotSchema } from "../graph/types.ts";
import type {
  LanceIntelligenceStore,
  PinnedGenerationReader,
} from "../storage/store.ts";
import {
  currentWorkspace,
  type WorkspaceHandle,
} from "../workspace/context.ts";
import {
  artifactManifestFingerprint,
  modelSpaceId,
  normalizeEmbedding,
} from "./embedding.ts";
import {
  type EmbeddingModelConfig,
  EmbeddingModelConfigSchema,
  type ResolvedRetrievalRequest,
  type RetrievalCandidate,
  type RetrievalRequest,
  RetrievalRequestSchema,
  type RetrievalResponse,
  type RetrievalSignal,
} from "./types.ts";

type Row = Readonly<Record<string, unknown>>;
type Clock = () => number;

const STORED_DTYPES = {
  fp16: "float16",
  fp32: "float32",
  q4: "uint8",
  q8: "int8",
} as const;

interface DecodedChunk {
  artifactId: string;
  createdAt: string;
  documentKind: string;
  language: string;
  range: RetrievalCandidate["range"];
  sourceArtifactId: string;
  symbols: string[];
  text: string;
}

interface RankedSignal {
  artifactId: string;
  rank: number;
  score: number;
  signal: RetrievalSignal;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function parsePayload(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") throw new Error("invalid_retrieval_payload");
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("invalid_retrieval_payload");
  return parsed as Record<string, unknown>;
}

function decodeRange(value: unknown): RetrievalCandidate["range"] {
  if (!value || typeof value !== "object")
    throw new Error("invalid_chunk_range");
  const range = value as RetrievalCandidate["range"];
  if (
    !Number.isSafeInteger(range.startByte) ||
    !Number.isSafeInteger(range.endByte) ||
    !Number.isSafeInteger(range.start?.line) ||
    !Number.isSafeInteger(range.start?.column) ||
    !Number.isSafeInteger(range.end?.line) ||
    !Number.isSafeInteger(range.end?.column) ||
    range.startByte < 0 ||
    range.endByte < range.startByte
  )
    throw new Error("invalid_chunk_range");
  return range;
}

function decodeChunk(
  row: Row,
  deadline = Number.POSITIVE_INFINITY,
  clock: Clock = Date.now,
): DecodedChunk {
  const payload = parsePayload(row.payload_json);
  if (
    typeof row.artifact_id !== "string" ||
    typeof row.source_artifact_id !== "string" ||
    typeof row.text !== "string" ||
    typeof row.created_at !== "string" ||
    typeof row.document_kind !== "string" ||
    typeof payload.language !== "string" ||
    !Array.isArray(payload.symbols)
  )
    throw new Error("invalid_chunk_row");
  const symbols: string[] = [];
  for (const value of payload.symbols) {
    if (clock() >= deadline) throw new Error("retrieval_deadline");
    if (typeof value !== "string") throw new Error("invalid_chunk_row");
    symbols.push(value);
  }
  return {
    artifactId: row.artifact_id,
    createdAt: row.created_at,
    documentKind: row.document_kind,
    language: payload.language,
    range: decodeRange(payload.range),
    sourceArtifactId: row.source_artifact_id,
    symbols,
    text: row.text,
  };
}

function sql(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function pathMatches(path: string, selector: string): boolean {
  return path === selector || path.startsWith(`${selector}/`);
}

function isEligiblePath(
  path: string,
  included: readonly string[],
  denied: readonly string[],
): boolean {
  for (const selector of denied) if (pathMatches(path, selector)) return false;
  if (included.length === 0) return true;
  for (const selector of included) if (pathMatches(path, selector)) return true;
  return false;
}

function tokens(
  value: string,
  deadline = Number.POSITIVE_INFINITY,
  clock: Clock = Date.now,
): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  const raw = value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .split(/[^\p{L}\p{N}_$]+/u);
  for (const token of raw) {
    if (clock() >= deadline) break;
    if (token.length > 0 && !seen.has(token)) {
      seen.add(token);
      result.push(token);
    }
  }
  return result;
}

function localBm25(
  query: string,
  chunks: readonly DecodedChunk[],
  limit: number,
  deadline: number,
  clock: Clock = Date.now,
): RankedSignal[] {
  const terms = tokens(query, deadline, clock);
  if (terms.length === 0 || clock() >= deadline) return [];
  const documents: string[][] = [];
  let totalLength = 0;
  for (const chunk of chunks) {
    if (clock() >= deadline) break;
    const document = tokens(chunk.text, deadline, clock);
    documents.push(document);
    totalLength += document.length;
  }
  const scored: Array<{ artifactId: string; score: number }> = [];
  const averageLength = totalLength / Math.max(1, documents.length);
  for (let index = 0; index < documents.length; index += 1) {
    if (clock() >= deadline) break;
    const document = documents[index] ?? [];
    const chunk = chunks[index];
    if (!chunk) break;
    let score = 0;
    for (const term of terms) {
      if (clock() >= deadline) break;
      let frequency = 0;
      for (const token of document) {
        if (clock() >= deadline) break;
        if (token === term) frequency += 1;
      }
      if (!frequency) continue;
      let documentsWithTerm = 0;
      for (const candidate of documents) {
        if (clock() >= deadline) break;
        for (const token of candidate) {
          if (clock() >= deadline) break;
          if (token === term) {
            documentsWithTerm += 1;
            break;
          }
        }
      }
      const idf = Math.log(
        1 +
          (documents.length - documentsWithTerm + 0.5) /
            (documentsWithTerm + 0.5),
      );
      const denominator =
        frequency + 1.2 * (0.25 + (0.75 * document.length) / averageLength);
      score += (idf * (frequency * 2.2)) / denominator;
    }
    if (score > 0)
      insertScore(scored, { artifactId: chunk.artifactId, score }, limit);
  }
  const ranked: RankedSignal[] = [];
  for (let rank = 0; rank < scored.length; rank += 1) {
    if (clock() >= deadline) break;
    const item = scored[rank];
    if (item) ranked.push({ ...item, rank: rank + 1, signal: "lexical" });
  }
  return ranked;
}

async function pinnedTable(
  store: LanceIntelligenceStore,
  reader: PinnedGenerationReader,
  name: "chunks" | "embeddings",
) {
  let pin: PinnedGenerationReader["pin"]["tableVersions"][number] | undefined;
  for (const candidate of reader.pin.tableVersions) {
    if (candidate.table === name) {
      pin = candidate;
      break;
    }
  }
  if (!pin) throw new Error("mixed_generation");
  const connection = await lancedb.connect(store.storagePath);
  const table = await connection.openTable(name);
  await table.checkout(pin.version);
  return { connection, table };
}

async function lexicalRanks(
  store: LanceIntelligenceStore,
  reader: PinnedGenerationReader,
  query: string,
  eligibleChunks: readonly DecodedChunk[],
  limit: number,
  deadline: number,
  clock: Clock = Date.now,
): Promise<RankedSignal[]> {
  if (eligibleChunks.length === 0 || clock() >= deadline) return [];
  const eligibleIds: string[] = [];
  for (const chunk of eligibleChunks) {
    if (clock() >= deadline) return [];
    eligibleIds.push(sql(chunk.artifactId));
  }
  const artifactPredicate = `artifact_id IN (${eligibleIds.join(", ")})`;
  const predicate =
    reader.pin.publicationProtocol !== "reservation-v2"
      ? `publication_generation_id = ${sql(reader.pin.generationId)} AND ${artifactPredicate}`
      : artifactPredicate;
  const { connection, table } = await pinnedTable(store, reader, "chunks");
  try {
    const rows = await table
      .search(query)
      .where(predicate)
      .limit(limit)
      .toArray({ timeoutMs: Math.max(1, deadline - clock()) });
    const ranked: RankedSignal[] = [];
    for (let rank = 0; rank < rows.length && rank < limit; rank += 1) {
      if (clock() >= deadline) break;
      const row = rows[rank];
      if (!row) continue;
      ranked.push({
        artifactId: String(row.artifact_id),
        rank: rank + 1,
        score: Number(row._score ?? 1 / (rank + 1)),
        signal: "lexical",
      });
    }
    if (ranked.length > 0) return ranked;
    return localBm25(query, eligibleChunks, limit, deadline, clock);
  } catch {
    return localBm25(query, eligibleChunks, limit, deadline, clock);
  } finally {
    table.close();
    connection.close();
  }
}

function isTimeoutError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return message.includes("timeout") || message.includes("deadline");
}

async function boundedRows(
  load: (timeoutMs: number) => Promise<readonly Row[]>,
  deadline: number,
  clock: Clock,
): Promise<{ rows: readonly Row[]; timedOut: boolean }> {
  const timeoutMs = deadline - clock();
  if (timeoutMs <= 0) return { rows: [], timedOut: true };
  try {
    return { rows: await load(timeoutMs), timedOut: false };
  } catch (error) {
    if (clock() >= deadline || isTimeoutError(error))
      return { rows: [], timedOut: true };
    throw error;
  }
}

interface VectorSelection {
  corrupt: number;
  scanned: number;
  timeTruncated: boolean;
  truncated: boolean;
  vectors: Map<string, number[]>;
}

function embeddingRows(
  rows: readonly Row[],
  config: EmbeddingModelConfig,
  eligible: ReadonlySet<string>,
  generationId: string,
  requireGenerationTag: boolean,
  scanLimit: number,
  deadline: number,
  clock: Clock = Date.now,
): VectorSelection {
  const manifestFingerprint = artifactManifestFingerprint(config);
  const space = modelSpaceId(config);
  const vectors = new Map<string, number[]>();
  let corrupt = 0;
  let eligibleScanned = 0;
  let scanned = 0;
  let truncated = false;
  for (const row of rows) {
    if (clock() >= deadline)
      return {
        corrupt,
        scanned,
        timeTruncated: true,
        truncated: true,
        vectors,
      };
    scanned += 1;
    const chunkArtifactId = String(row.chunk_artifact_id);
    if (
      (requireGenerationTag &&
        row.publication_generation_id !== generationId) ||
      !eligible.has(chunkArtifactId) ||
      row.model_id !== config.modelId ||
      row.model_revision !== config.revision ||
      row.dimensions !== config.dimensions ||
      row.pooling !== config.pooling
    )
      continue;
    try {
      const payload = parsePayload(row.payload_json);
      if (
        payload.artifactManifestFingerprint !== manifestFingerprint ||
        payload.modelSpaceId !== space
      )
        continue;
      if (eligibleScanned >= scanLimit) {
        truncated = true;
        break;
      }
      eligibleScanned += 1;
      const vector = row.vector;
      if (
        row.dtype !== STORED_DTYPES[config.dtype] ||
        row.normalized !== true ||
        payload.inferenceDtype !== config.dtype ||
        vector === null ||
        vector === undefined ||
        typeof (vector as Iterable<number>)[Symbol.iterator] !== "function"
      )
        throw new Error("invalid_embedding_row");
      const values: number[] = [];
      for (const value of vector as Iterable<number>) {
        if (clock() >= deadline) throw new Error("retrieval_deadline");
        if (values.length >= config.dimensions)
          throw new Error("invalid_embedding_row");
        values.push(value);
      }
      vectors.set(
        chunkArtifactId,
        normalizeEmbedding(values, config.dimensions),
      );
    } catch (error) {
      if (error instanceof Error && error.message === "retrieval_deadline")
        return {
          corrupt,
          scanned,
          timeTruncated: true,
          truncated: true,
          vectors,
        };
      corrupt += 1;
    }
  }
  return {
    corrupt,
    scanned,
    timeTruncated: false,
    truncated,
    vectors,
  };
}

function dot(
  left: readonly number[],
  right: readonly number[],
  deadline: number,
  clock: Clock = Date.now,
): number | null {
  let score = 0;
  for (let index = 0; index < left.length; index += 1) {
    if (clock() >= deadline) return null;
    score += (left[index] ?? 0) * (right[index] ?? 0);
  }
  return score;
}

function insertScore(
  scores: Array<{ artifactId: string; score: number }>,
  item: { artifactId: string; score: number },
  limit: number,
): void {
  let index = 0;
  while (
    index < scores.length &&
    (scores[index]?.score ?? Number.NEGATIVE_INFINITY) > item.score
  )
    index += 1;
  while (
    index < scores.length &&
    scores[index]?.score === item.score &&
    (scores[index]?.artifactId ?? "").localeCompare(item.artifactId) < 0
  )
    index += 1;
  scores.splice(index, 0, item);
  if (scores.length > limit) scores.pop();
}

async function vectorRanks(
  store: LanceIntelligenceStore,
  reader: PinnedGenerationReader,
  queryVector: readonly number[],
  eligibleChunks: readonly DecodedChunk[],
  config: EmbeddingModelConfig,
  limit: number,
  scanLimit: number,
  deadline: number,
  forceExact: boolean,
  clock: Clock = Date.now,
): Promise<{
  corrupt: number;
  exactFallback: boolean;
  ranks: RankedSignal[];
  scanned: number;
  timeTruncated: boolean;
  truncated: boolean;
}> {
  if (queryVector.length !== config.dimensions)
    throw new TypeError(
      `embedding_dimension_mismatch:${queryVector.length}:${config.dimensions}`,
    );
  const query = normalizeEmbedding(queryVector, config.dimensions);
  const eligible = new Set<string>();
  for (const chunk of eligibleChunks) {
    if (clock() >= deadline) break;
    eligible.add(chunk.artifactId);
  }
  const embeddingRead = await boundedRows(
    (timeoutMs) => reader.rows("embeddings", undefined, { timeoutMs }),
    deadline,
    clock,
  );
  if (embeddingRead.timedOut)
    return {
      corrupt: 0,
      exactFallback: forceExact,
      ranks: [],
      scanned: 0,
      timeTruncated: true,
      truncated: true,
    };
  const selected = embeddingRows(
    embeddingRead.rows,
    config,
    eligible,
    reader.pin.generationId,
    reader.pin.publicationProtocol !== "reservation-v2",
    scanLimit,
    deadline,
    clock,
  );
  const stored = selected.vectors;
  const candidateIds = new Set<string>();
  let exactFallback = forceExact;
  if (!forceExact && clock() < deadline && stored.size > 0) {
    const identifiers: string[] = [];
    for (const id of stored.keys()) {
      if (clock() >= deadline) break;
      identifiers.push(id);
    }
    const encodedIdentifiers: string[] = [];
    for (const identifier of identifiers) {
      if (clock() >= deadline) break;
      encodedIdentifiers.push(sql(identifier));
    }
    const embeddingPredicate = `model_id = ${sql(config.modelId)} AND model_revision = ${sql(config.revision)} AND dimensions = ${config.dimensions} AND dtype = ${sql(STORED_DTYPES[config.dtype])} AND pooling = ${sql(config.pooling)} AND chunk_artifact_id IN (${encodedIdentifiers.join(", ")})`;
    const predicate =
      reader.pin.publicationProtocol !== "reservation-v2"
        ? `publication_generation_id = ${sql(reader.pin.generationId)} AND ${embeddingPredicate}`
        : embeddingPredicate;
    const { connection, table } = await pinnedTable(
      store,
      reader,
      "embeddings",
    );
    try {
      const rows = await table
        .search(query)
        .where(predicate)
        .limit(limit)
        .toArray({ timeoutMs: Math.max(1, deadline - clock()) });
      for (const row of rows) {
        if (clock() >= deadline) break;
        const id = String(row.chunk_artifact_id);
        if (stored.has(id) && candidateIds.size < limit) candidateIds.add(id);
      }
      if (candidateIds.size < Math.min(limit, stored.size))
        exactFallback = true;
    } catch {
      exactFallback = true;
    } finally {
      table.close();
      connection.close();
    }
  }
  const scores: Array<{ artifactId: string; score: number }> = [];
  const scoreIds: Iterable<string> = exactFallback
    ? stored.keys()
    : candidateIds.values();
  let timeTruncated = selected.timeTruncated;
  for (const artifactId of scoreIds) {
    if (clock() >= deadline) {
      timeTruncated = true;
      break;
    }
    const score = dot(query, stored.get(artifactId) ?? [], deadline, clock);
    if (score === null) {
      timeTruncated = true;
      break;
    }
    if (Number.isFinite(score))
      insertScore(scores, { artifactId, score }, limit);
  }
  const ranks: RankedSignal[] = [];
  for (let rank = 0; rank < scores.length; rank += 1) {
    if (clock() >= deadline) {
      timeTruncated = true;
      break;
    }
    const item = scores[rank];
    if (!item) continue;
    ranks.push({ ...item, rank: rank + 1, signal: "semantic" });
  }
  return {
    corrupt: selected.corrupt,
    exactFallback,
    ranks,
    scanned: selected.scanned,
    timeTruncated,
    truncated: selected.truncated || timeTruncated,
  };
}

function propertyStrings(
  properties: readonly unknown[],
  deadline: number,
  clock: Clock = Date.now,
): string[] {
  const result: string[] = [];
  for (const property of properties) {
    if (clock() >= deadline) break;
    if (!property || typeof property !== "object") continue;
    const value = (property as { value?: unknown }).value;
    if (typeof value === "string") {
      result.push(value);
      continue;
    }
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (clock() >= deadline) break;
      if (typeof item === "string") result.push(item);
    }
  }
  return result;
}

function graphDistances(
  graph: GraphSnapshot,
  symbols: ReadonlySet<string>,
  eligibleNodeIds: ReadonlySet<string>,
  maxDepth: number,
  maxNodes: number,
  maxBytes: number,
  deadline: number,
  clock: Clock = Date.now,
): {
  bytesVisited: number;
  distances: Map<string, number>;
  edgesVisited: number;
  truncated: boolean;
} {
  const normalized = new Set<string>();
  for (const value of symbols) {
    if (clock() >= deadline) break;
    normalized.add(value.toLowerCase());
  }
  const seeds: string[] = [];
  let bytesVisited = 0;
  let truncated = false;
  for (const node of graph.nodes) {
    if (clock() >= deadline) {
      truncated = true;
      break;
    }
    if (!eligibleNodeIds.has(node.nodeId)) continue;
    const nodeBytes = Buffer.byteLength(JSON.stringify(node));
    if (bytesVisited + nodeBytes > maxBytes) {
      truncated = true;
      break;
    }
    bytesVisited += nodeBytes;
    const names = [
      node.canonicalName,
      ...propertyStrings(node.properties, deadline, clock),
    ];
    let matched = false;
    for (const name of names) {
      if (clock() >= deadline) {
        truncated = true;
        break;
      }
      if (normalized.has(name.toLowerCase())) {
        matched = true;
        break;
      }
    }
    if (!matched) continue;
    if (seeds.length >= maxNodes) {
      truncated = true;
      break;
    }
    let index = 0;
    while (
      index < seeds.length &&
      (seeds[index] ?? "").localeCompare(node.nodeId) < 0
    ) {
      if (clock() >= deadline) {
        truncated = true;
        break;
      }
      index += 1;
    }
    if (truncated) break;
    seeds.splice(index, 0, node.nodeId);
  }
  const distances = new Map<string, number>();
  for (const id of seeds) {
    if (clock() >= deadline) {
      truncated = true;
      break;
    }
    distances.set(id, 0);
  }
  const queue = [...seeds];
  let edgesVisited = 0;
  traversal: while (queue.length) {
    if (
      clock() >= deadline ||
      distances.size >= maxNodes ||
      edgesVisited >= maxNodes
    ) {
      truncated = true;
      break;
    }
    const nodeId = queue.shift();
    if (!nodeId) break;
    const depth = distances.get(nodeId) ?? 0;
    if (depth >= maxDepth) continue;
    for (const edge of graph.edges) {
      if (clock() >= deadline || edgesVisited >= maxNodes) {
        truncated = true;
        break traversal;
      }
      if (
        !eligibleNodeIds.has(edge.sourceNodeId) ||
        !eligibleNodeIds.has(edge.targetNodeId) ||
        (edge.sourceNodeId !== nodeId && edge.targetNodeId !== nodeId)
      )
        continue;
      const edgeBytes = Buffer.byteLength(JSON.stringify(edge));
      if (bytesVisited + edgeBytes > maxBytes) {
        truncated = true;
        break traversal;
      }
      bytesVisited += edgeBytes;
      edgesVisited += 1;
      const next =
        edge.sourceNodeId === nodeId ? edge.targetNodeId : edge.sourceNodeId;
      if (!distances.has(next)) {
        if (distances.size >= maxNodes) {
          truncated = true;
          break traversal;
        }
        distances.set(next, depth + 1);
        queue.push(next);
      }
    }
  }
  return { bytesVisited, distances, edgesVisited, truncated };
}

function weight(
  intent: ResolvedRetrievalRequest["intent"],
  signal: RetrievalSignal,
): number {
  if (intent === "implementation")
    return {
      "exact-symbol": 2,
      "graph-proximity": 1.2,
      lexical: 1.3,
      semantic: 0.7,
    }[signal];
  if (intent === "documentation")
    return {
      "exact-symbol": 0.8,
      "graph-proximity": 0.6,
      lexical: 1.2,
      semantic: 1.8,
    }[signal];
  return {
    "exact-symbol": 1,
    "graph-proximity": 0.8,
    lexical: 1.2,
    semantic: 1.6,
  }[signal];
}

function signalExplanation(
  signal: RetrievalSignal,
  exactFallback = false,
): string {
  if (signal === "exact-symbol") return "Exact symbol evidence";
  if (signal === "lexical") return "LanceDB FTS/BM25 text evidence";
  if (signal === "semantic")
    return exactFallback
      ? "Exact eligible-vector cosine evidence"
      : "LanceDB dense-vector evidence";
  return "Bounded graph-neighborhood evidence";
}

export interface RetrieveOptions {
  clock?: Clock;
  graph: GraphSnapshot;
  model?: EmbeddingModelConfig;
  queryVector?: readonly number[];
  textSearch?: "auto" | "local";
  vectorSearch?: "auto" | "exact";
  workspace?: WorkspaceHandle;
}

function rangesOverlap(
  left: DecodedChunk["range"],
  right: GraphSnapshot["occurrences"][number]["range"],
): boolean {
  if (left.startByte === left.endByte && right.startByte === right.endByte)
    return left.startByte === right.startByte;
  if (left.startByte === left.endByte)
    return right.startByte <= left.startByte && left.startByte < right.endByte;
  if (right.startByte === right.endByte)
    return left.startByte <= right.startByte && right.startByte < left.endByte;
  return left.startByte < right.endByte && right.startByte < left.endByte;
}

function selectRankableChunks(
  chunks: readonly DecodedChunk[],
  prioritizedArtifactIds: ReadonlySet<string>,
  maxCandidates: number,
  maxBytes: number,
  deadline: number,
  clock: Clock = Date.now,
): {
  bytesTruncated: boolean;
  candidatesTruncated: boolean;
  chunks: DecodedChunk[];
  timeTruncated: boolean;
} {
  const ordered: DecodedChunk[] = [];
  let timeTruncated = false;
  for (const chunk of chunks) {
    if (clock() >= deadline) {
      timeTruncated = true;
      break;
    }
    let index = 0;
    while (index < ordered.length) {
      const current = ordered[index];
      if (!current) break;
      const currentPriority = prioritizedArtifactIds.has(current.artifactId);
      const chunkPriority = prioritizedArtifactIds.has(chunk.artifactId);
      if (
        (chunkPriority && !currentPriority) ||
        (chunkPriority === currentPriority &&
          current.artifactId.localeCompare(chunk.artifactId) >= 0)
      )
        break;
      if (clock() >= deadline) {
        timeTruncated = true;
        break;
      }
      index += 1;
    }
    if (timeTruncated) break;
    ordered.splice(index, 0, chunk);
  }
  const selected: DecodedChunk[] = [];
  let bytes = 0;
  let bytesTruncated = false;
  let candidatesTruncated = false;
  for (const chunk of ordered) {
    if (clock() >= deadline) {
      timeTruncated = true;
      break;
    }
    if (selected.length >= maxCandidates) {
      candidatesTruncated = true;
      break;
    }
    const chunkBytes = Buffer.byteLength(chunk.text);
    if (bytes + chunkBytes > maxBytes) {
      bytesTruncated = true;
      continue;
    }
    selected.push(chunk);
    bytes += chunkBytes;
  }
  return {
    bytesTruncated,
    candidatesTruncated,
    chunks: selected,
    timeTruncated,
  };
}

export async function retrieve(
  store: LanceIntelligenceStore,
  reader: PinnedGenerationReader,
  requestInput: RetrievalRequest,
  options: RetrieveOptions,
): Promise<RetrievalResponse> {
  const clock = options.clock ?? Date.now;
  const started = clock();
  const request = RetrievalRequestSchema.parse(requestInput);
  const deadline = started + request.budget.timeoutMs;
  const graph = GraphSnapshotSchema.parse(options.graph);
  const workspace = options.workspace ?? currentWorkspace();
  if (!workspace) throw new Error("workspace_context_required");
  if (
    workspace.workspaceId !== request.scope.workspaceId ||
    workspace.repositoryId !== request.scope.repositoryId ||
    workspace.selectedRevision.revisionId !== request.scope.revisionId ||
    reader.pin.workspaceId !== request.scope.workspaceId ||
    reader.pin.revisionId !== request.scope.revisionId ||
    reader.pin.generationId !== request.scope.generationId ||
    graph.scope.workspaceId !== request.scope.workspaceId ||
    graph.scope.repositoryId !== request.scope.repositoryId ||
    graph.scope.revisionId !== request.scope.revisionId ||
    graph.scope.generationId !== request.scope.generationId
  )
    throw new Error("retrieval_scope_unauthorized");

  let timeTruncated = clock() >= deadline;
  let corruptChunks = 0;
  let scannedChunkRows = 0;
  let totalChunks = 0;
  const chunks: DecodedChunk[] = [];
  const chunkRead = await boundedRows(
    (timeoutMs) => reader.rows("chunks", undefined, { timeoutMs }),
    deadline,
    clock,
  );
  timeTruncated ||= chunkRead.timedOut;
  const rows = chunkRead.rows;
  for (const row of rows) {
    if (clock() >= deadline) {
      timeTruncated = true;
      break;
    }
    scannedChunkRows += 1;
    if (
      reader.pin.publicationProtocol !== "reservation-v2" &&
      row.publication_generation_id !== reader.pin.generationId
    )
      continue;
    totalChunks += 1;
    try {
      chunks.push(decodeChunk(row, deadline, clock));
    } catch (error) {
      if (error instanceof Error && error.message === "retrieval_deadline") {
        timeTruncated = true;
        break;
      }
      corruptChunks += 1;
    }
  }

  const exactSymbols = new Set<string>();
  for (const symbol of request.exactSymbols) {
    if (clock() >= deadline) {
      timeTruncated = true;
      break;
    }
    exactSymbols.add(symbol);
  }
  for (const token of tokens(request.query, deadline, clock)) {
    if (clock() >= deadline) {
      timeTruncated = true;
      break;
    }
    if (/^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(token)) exactSymbols.add(token);
  }
  const exactArtifactIds = new Set<string>();
  for (const chunk of chunks) {
    if (
      chunk.symbols.some((symbol) =>
        [...exactSymbols].some(
          (expected) => symbol.toLowerCase() === expected.toLowerCase(),
        ),
      )
    )
      exactArtifactIds.add(chunk.artifactId);
  }

  const activeOccurrences = new Set<string>();
  let scannedGraphMemberships = 0;
  const graphInputTruncated = false;
  for (const item of graph.memberships) {
    if (clock() >= deadline) {
      timeTruncated = true;
      break;
    }
    scannedGraphMemberships += 1;
    if (
      item.entityKind !== "occurrence" ||
      item.generationId !== request.scope.generationId ||
      item.revisionId !== request.scope.revisionId
    )
      continue;
    activeOccurrences.add(item.entityId);
  }

  const occurrencesBySource = new Map<
    string,
    GraphSnapshot["occurrences"][number][]
  >();
  let scannedGraphOccurrences = 0;
  const occurrenceTruncated = false;
  for (const occurrence of graph.occurrences) {
    if (clock() >= deadline) {
      timeTruncated = true;
      break;
    }
    scannedGraphOccurrences += 1;
    if (
      !activeOccurrences.has(occurrence.occurrenceId) ||
      !isEligiblePath(
        occurrence.path,
        request.includedPaths,
        request.deniedPaths,
      )
    )
      continue;
    const existing = occurrencesBySource.get(occurrence.sourceArtifactId) ?? [];
    existing.push(occurrence);
    occurrencesBySource.set(occurrence.sourceArtifactId, existing);
  }

  const eligibleChunks: DecodedChunk[] = [];
  for (const chunk of chunks) {
    if (clock() >= deadline) {
      timeTruncated = true;
      break;
    }
    let languageEligible = request.languages.length === 0;
    for (const language of request.languages) {
      if (clock() >= deadline) {
        timeTruncated = true;
        break;
      }
      if (language === chunk.language) {
        languageEligible = true;
        break;
      }
    }
    if (timeTruncated) break;
    if (occurrencesBySource.has(chunk.sourceArtifactId) && languageEligible)
      eligibleChunks.push(chunk);
  }
  const selection = selectRankableChunks(
    eligibleChunks,
    exactArtifactIds,
    request.budget.maxCandidates,
    request.budget.maxBytes,
    deadline,
    clock,
  );
  timeTruncated ||= selection.timeTruncated;
  const rankableChunks = selection.chunks;

  const exactChunks: DecodedChunk[] = [];
  for (const chunk of rankableChunks) {
    if (clock() >= deadline) {
      timeTruncated = true;
      break;
    }
    if (!exactArtifactIds.has(chunk.artifactId)) continue;
    let index = 0;
    while (
      index < exactChunks.length &&
      (exactChunks[index]?.artifactId ?? "").localeCompare(chunk.artifactId) < 0
    ) {
      if (clock() >= deadline) {
        timeTruncated = true;
        break;
      }
      index += 1;
    }
    if (timeTruncated) break;
    exactChunks.splice(index, 0, chunk);
    if (exactChunks.length > request.budget.maxCandidates) exactChunks.pop();
  }
  const exact: RankedSignal[] = [];
  for (let rank = 0; rank < exactChunks.length; rank += 1) {
    if (clock() >= deadline) {
      timeTruncated = true;
      break;
    }
    const chunk = exactChunks[rank];
    if (chunk)
      exact.push({
        artifactId: chunk.artifactId,
        rank: rank + 1,
        score: 1,
        signal: "exact-symbol",
      });
  }

  const lexical =
    options.textSearch === "local"
      ? localBm25(
          request.query,
          rankableChunks,
          request.budget.maxCandidates,
          deadline,
          clock,
        )
      : await lexicalRanks(
          store,
          reader,
          request.query,
          rankableChunks,
          request.budget.maxCandidates,
          deadline,
          clock,
        );
  if (clock() >= deadline) timeTruncated = true;

  let semantic: RankedSignal[] = [];
  let semanticState: RetrievalResponse["coverage"]["semanticState"] =
    request.semantic ? "pending" : "disabled";
  let exactVectorFallback = false;
  let corruptEmbeddings = 0;
  let scannedEmbeddingRows = 0;
  let semanticTruncated = false;
  if (request.semantic && options.queryVector && options.model) {
    const model = EmbeddingModelConfigSchema.parse(options.model);
    const result = await vectorRanks(
      store,
      reader,
      options.queryVector,
      rankableChunks,
      model,
      request.budget.maxVectorCandidates,
      request.budget.maxVectorScan,
      deadline,
      options.vectorSearch === "exact",
      clock,
    );
    semantic = result.ranks;
    exactVectorFallback = result.exactFallback;
    corruptEmbeddings = result.corrupt;
    scannedEmbeddingRows = result.scanned;
    timeTruncated ||= result.timeTruncated;
    semanticTruncated = result.truncated;
    semanticState = "ready";
  } else if (request.semantic && !options.model) semanticState = "unavailable";

  const eligibleNodeIds = new Set<string>();
  for (const occurrences of occurrencesBySource.values()) {
    if (clock() >= deadline) {
      timeTruncated = true;
      break;
    }
    for (const occurrence of occurrences) {
      if (clock() >= deadline) {
        timeTruncated = true;
        break;
      }
      eligibleNodeIds.add(occurrence.nodeId);
    }
  }
  const graphResult = graphDistances(
    graph,
    exactSymbols,
    eligibleNodeIds,
    request.budget.maxDepth,
    request.budget.maxNodes,
    request.budget.maxGraphBytes,
    deadline,
    clock,
  );
  if (clock() >= deadline) timeTruncated = true;

  const signals = new Map<string, RankedSignal[]>();
  for (const group of [exact, lexical, semantic]) {
    if (clock() >= deadline) {
      timeTruncated = true;
      break;
    }
    for (const item of group) {
      if (clock() >= deadline) {
        timeTruncated = true;
        break;
      }
      const list = signals.get(item.artifactId) ?? [];
      list.push(item);
      signals.set(item.artifactId, list);
    }
  }

  const candidates: RetrievalCandidate[] = [];
  let expansionTruncated = false;
  candidateLoop: for (const chunk of rankableChunks) {
    if (clock() >= deadline) {
      timeTruncated = true;
      expansionTruncated = true;
      break;
    }
    const chunkSignals = signals.get(chunk.artifactId) ?? [];
    for (const occurrence of occurrencesBySource.get(chunk.sourceArtifactId) ??
      []) {
      if (!rangesOverlap(chunk.range, occurrence.range)) continue;
      if (
        clock() >= deadline ||
        candidates.length >= request.budget.maxCandidates
      ) {
        timeTruncated ||= clock() >= deadline;
        expansionTruncated = true;
        break candidateLoop;
      }
      const allSignals = [...chunkSignals];
      const depth = graphResult.distances.get(occurrence.nodeId);
      if (depth !== undefined)
        allSignals.push({
          artifactId: chunk.artifactId,
          rank: depth + 1,
          score: 1 / (depth + 1),
          signal: "graph-proximity",
        });
      if (allSignals.length === 0) continue;
      const orderedSignals: RankedSignal[] = [];
      let score = 0;
      for (const signal of allSignals) {
        if (clock() >= deadline) {
          timeTruncated = true;
          break candidateLoop;
        }
        score += weight(request.intent, signal.signal) / (60 + signal.rank);
        let index = 0;
        while (
          index < orderedSignals.length &&
          ((orderedSignals[index]?.signal ?? "").localeCompare(signal.signal) <
            0 ||
            (orderedSignals[index]?.signal === signal.signal &&
              (orderedSignals[index]?.rank ?? 0) < signal.rank))
        )
          index += 1;
        orderedSignals.splice(index, 0, signal);
      }
      const reasons: RetrievalCandidate["reasons"][number][] = [];
      for (const signal of orderedSignals) {
        if (clock() >= deadline) {
          timeTruncated = true;
          break candidateLoop;
        }
        reasons.push({
          explanation: signalExplanation(
            signal.signal,
            signal.signal === "semantic" && exactVectorFallback,
          ),
          rank: signal.rank,
          signal: signal.signal,
        });
      }
      candidates.push({
        artifactId: chunk.artifactId,
        entityId: occurrence.nodeId,
        language: chunk.language,
        path: occurrence.path,
        range: chunk.range,
        reasons,
        score,
        sourceArtifactId: chunk.sourceArtifactId,
        text: chunk.text,
      });
    }
  }

  const deduped = new Map<string, RetrievalCandidate>();
  for (const candidate of candidates) {
    if (clock() >= deadline) {
      timeTruncated = true;
      break;
    }
    const key = digest(
      JSON.stringify([
        candidate.entityId,
        candidate.path,
        candidate.range,
        candidate.text,
      ]),
    );
    const prior = deduped.get(key);
    if (!prior || candidate.score > prior.score) deduped.set(key, candidate);
  }

  const sorted: RetrievalCandidate[] = [];
  for (const candidate of deduped.values()) {
    if (clock() >= deadline) {
      timeTruncated = true;
      break;
    }
    let index = 0;
    while (index < sorted.length) {
      if (clock() >= deadline) {
        timeTruncated = true;
        break;
      }
      const current = sorted[index];
      if (
        !current ||
        candidate.score > current.score ||
        (candidate.score === current.score &&
          (candidate.path.localeCompare(current.path) < 0 ||
            (candidate.path === current.path &&
              (candidate.range.startByte < current.range.startByte ||
                (candidate.range.startByte === current.range.startByte &&
                  candidate.entityId.localeCompare(current.entityId) < 0)))))
      )
        break;
      index += 1;
    }
    if (timeTruncated) break;
    sorted.splice(index, 0, candidate);
  }

  const results: RetrievalCandidate[] = [];
  let consumedBytes = 0;
  let byteTruncated = selection.bytesTruncated;
  let itemTruncated = false;
  for (const candidate of sorted) {
    if (clock() >= deadline) {
      timeTruncated = true;
      break;
    }
    if (results.length >= request.budget.maxItems) {
      itemTruncated = true;
      break;
    }
    const bytes = Buffer.byteLength(candidate.text);
    if (consumedBytes + bytes > request.budget.maxBytes) {
      byteTruncated = true;
      continue;
    }
    results.push(candidate);
    consumedBytes += bytes;
  }

  let pendingJobs = 0;
  let failedJobs = 0;
  let scannedJobRows = 0;
  const jobRead = await boundedRows(
    (timeoutMs) => store.rows("jobs", undefined, { timeoutMs }),
    deadline,
    clock,
  );
  timeTruncated ||= jobRead.timedOut;
  const jobRows = jobRead.rows;
  for (const row of jobRows) {
    if (clock() >= deadline) {
      timeTruncated = true;
      break;
    }
    scannedJobRows += 1;
    if (
      row.workspace_id !== request.scope.workspaceId ||
      row.revision_id !== request.scope.revisionId ||
      row.type !== "embed"
    )
      continue;
    if (row.state === "pending" || row.state === "running") pendingJobs += 1;
    else if (row.state === "failed" || row.state === "cancelled")
      failedJobs += 1;
  }
  if (request.semantic) {
    if (pendingJobs > 0) semanticState = "pending";
    else if (
      semanticState !== "ready" ||
      (rankableChunks.length > 0 && scannedEmbeddingRows === 0)
    )
      semanticState = "unavailable";
  }
  const indexedAt = reader.pin.createdAt;
  const stale = pendingJobs > 0 || failedJobs > 0;
  const reason =
    pendingJobs > 0
      ? "embedding jobs are pending"
      : failedJobs > 0
        ? "embedding jobs failed"
        : null;
  const candidateTruncated =
    selection.candidatesTruncated || occurrenceTruncated || expansionTruncated;
  const graphTruncated = graphInputTruncated || graphResult.truncated;
  const reasonCode = timeTruncated
    ? "time-limit"
    : byteTruncated
      ? "byte-limit"
      : itemTruncated
        ? "item-limit"
        : candidateTruncated
          ? "candidate-limit"
          : "none";
  return {
    coverage: {
      corruptChunks,
      corruptEmbeddings,
      degraded:
        corruptChunks > 0 ||
        corruptEmbeddings > 0 ||
        failedJobs > 0 ||
        (request.semantic && semanticState === "unavailable"),
      eligibleChunks: eligibleChunks.length,
      evaluatedCandidates: rankableChunks.length,
      graphBytesVisited: graphResult.bytesVisited,
      graphEdgesVisited: graphResult.edgesVisited,
      graphNodesVisited: graphResult.distances.size,
      scannedChunkRows,
      scannedEmbeddingRows,
      scannedGraphMemberships,
      scannedGraphOccurrences,
      scannedJobRows,
      semanticState,
      totalChunks,
    },
    freshness: {
      indexedAt,
      pendingJobCount: pendingJobs,
      reason,
      sourceObservedAt: indexedAt,
      stale,
    },
    results,
    scope: request.scope,
    truncated: {
      bytes: byteTruncated,
      candidates: candidateTruncated,
      graph: graphTruncated,
      items: itemTruncated,
      reason: reasonCode,
      time: timeTruncated,
      vector: semanticTruncated,
    },
  };
}
