import { createHash } from "node:crypto";
import * as lancedb from "@lancedb/lancedb";
import { embeddingArtifactIdentity } from "../contracts/artifacts.ts";
import { createIdentity } from "../contracts/common.ts";
import {
  createJobIdempotencyKey,
  type IntelligenceJob,
  type PublicationReservation,
} from "../contracts/storage.ts";
import { StorageError } from "../storage/errors.ts";
import type { LanceIntelligenceStore } from "../storage/store.ts";
import {
  assertWorkspaceWritable,
  currentWorkspace,
  type WorkspaceHandle,
} from "../workspace/context.ts";
import {
  artifactManifestFingerprint,
  EmbeddingCancelledError,
  type EmbeddingWorkerPool,
  modelSpaceId,
  normalizeEmbedding,
} from "./embedding.ts";
import {
  type EmbeddingModelConfig,
  EmbeddingModelConfigSchema,
  type RetrievalChunk,
  RetrievalChunkSchema,
  type RetrievalScope,
} from "./types.ts";

const ARTIFACT_DTYPES = {
  fp16: "float16",
  fp32: "float32",
  q4: "uint8",
  q8: "int8",
} as const;

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function retrievalChunkStorageRow(
  chunkInput: RetrievalChunk,
  createdAt: string,
): Record<string, unknown> {
  const chunk = RetrievalChunkSchema.parse(chunkInput);
  const symbols = [...chunk.symbols].sort();
  return {
    artifact_id: chunk.artifactId,
    byte_length: Buffer.byteLength(chunk.text),
    created_at: createdAt,
    document_kind: chunk.documentKind,
    extracted_content_digest: digest(chunk.text),
    payload_json: JSON.stringify({
      language: chunk.language,
      range: chunk.range,
      symbols,
      version: "retrieval-chunk-v1",
    }),
    semantic_context_digest: digest(JSON.stringify([chunk.language, symbols])),
    source_artifact_id: chunk.sourceArtifactId,
    syntax_facts_artifact_id: null,
    text: chunk.text,
  };
}

function workspaceForScope(
  scope: RetrievalScope,
  workspaceInput?: WorkspaceHandle,
): WorkspaceHandle {
  const workspace = workspaceInput ?? currentWorkspace();
  if (!workspace) throw new Error("workspace_context_required");
  if (
    workspace.workspaceId !== scope.workspaceId ||
    workspace.repositoryId !== scope.repositoryId ||
    workspace.selectedRevision.revisionId !== scope.revisionId
  )
    throw new Error("retrieval_scope_unauthorized");
  return workspace;
}

function assertReservationScope(
  store: LanceIntelligenceStore,
  scope: RetrievalScope,
  reservation?: PublicationReservation,
): void {
  if (
    reservation &&
    (reservation.storageDomainId !== store.domain.domainId ||
      reservation.workspaceId !== scope.workspaceId ||
      reservation.revisionId !== scope.revisionId ||
      reservation.generationId !== scope.generationId)
  )
    throw new Error("retrieval_reservation_scope_mismatch");
  if (
    reservation &&
    (!reservation.requiredTables.includes("chunks") ||
      !reservation.requiredTables.includes("embeddings"))
  )
    throw new Error("retrieval_reservation_tables_mismatch");
}

export async function publishRetrievalChunks(
  store: LanceIntelligenceStore,
  scope: RetrievalScope,
  chunksInput: readonly RetrievalChunk[],
  workspaceInput?: WorkspaceHandle,
  reservation?: PublicationReservation,
): Promise<void> {
  const workspace = workspaceForScope(scope, workspaceInput);
  assertReservationScope(store, scope, reservation);
  assertWorkspaceWritable();
  if (!workspace.writeEligibility.eligible)
    throw new Error("workspace_read_only");
  const rows = chunksInput.map((chunk) => {
    const row = retrievalChunkStorageRow(chunk, store.currentTimestamp());
    return reservation
      ? row
      : { ...row, publication_generation_id: scope.generationId };
  });
  if (reservation) await store.putReservedRows(reservation, "chunks", rows);
  else await store.putRows("chunks", rows);
  await store.coordinator.exclusive(
    "create chunks FTS index",
    async (lease) => {
      const connection = await lancedb.connect(store.storagePath);
      const table = await connection.openTable("chunks");
      try {
        const indices = await table.listIndices();
        if (!indices.some((index) => index.columns.includes("text"))) {
          await store.coordinator.fence(lease);
          await table.createIndex("text", { config: lancedb.Index.fts() });
        }
      } finally {
        table.close();
        connection.close();
      }
    },
  );
  if (reservation)
    await store.recordReservedTableVersion(reservation, "chunks");
}

function jobFor(
  store: LanceIntelligenceStore,
  scope: RetrievalScope,
  inputFingerprint: string,
  state: IntelligenceJob["state"],
  attempt: number,
  errorCode: string | null,
  createdAt: string,
): IntelligenceJob {
  const idempotencyKey = createJobIdempotencyKey({
    inputFingerprint,
    revisionId: scope.revisionId,
    storageDomainId: store.domain.domainId,
    type: "embed",
    workspaceId: scope.workspaceId,
  });
  return {
    attempt,
    createdAt,
    errorCode,
    idempotencyKey,
    jobId: idempotencyKey,
    revisionId: scope.revisionId,
    state,
    storageDomainId: store.domain.domainId,
    type: "embed",
    updatedAt: new Date().toISOString(),
    workspaceId: scope.workspaceId,
  };
}

export interface EmbeddingPublicationResult {
  artifactIds: readonly string[];
  failed: number;
  modelSpaceId: string;
  published: number;
}

export async function publishChunkEmbeddings(
  store: LanceIntelligenceStore,
  scope: RetrievalScope,
  chunksInput: readonly RetrievalChunk[],
  configInput: EmbeddingModelConfig,
  pool: EmbeddingWorkerPool,
  options: {
    allowReadOnlySource?: boolean;
    reservation?: PublicationReservation;
    signal?: AbortSignal;
    throwOnFailure?: boolean;
    workspace?: WorkspaceHandle;
  } = {},
): Promise<EmbeddingPublicationResult> {
  const workspace = workspaceForScope(scope, options.workspace);
  assertReservationScope(store, scope, options.reservation);
  if (!options.allowReadOnlySource) assertWorkspaceWritable();
  if (!workspace.writeEligibility.eligible && !options.allowReadOnlySource)
    throw new Error("workspace_read_only");
  const config = EmbeddingModelConfigSchema.parse(configInput);
  const chunks = chunksInput.map((chunk) => RetrievalChunkSchema.parse(chunk));
  const manifestFingerprint = artifactManifestFingerprint(config);
  const space = modelSpaceId(config);
  const dtype = ARTIFACT_DTYPES[config.dtype];
  const artifactIds: string[] = [];
  let failed = 0;
  const throwIfCancelled = () => {
    if (options.signal?.aborted) throw new EmbeddingCancelledError();
  };
  const publishChunk = async (chunk: RetrievalChunk): Promise<void> => {
    throwIfCancelled();
    const exactInputDigest = digest(chunk.text);
    const fingerprint = digest(
      JSON.stringify([chunk.artifactId, space, exactInputDigest]),
    );
    const createdAt = new Date().toISOString();
    throwIfCancelled();
    await store.putJob(
      jobFor(store, scope, fingerprint, "pending", 0, null, createdAt),
    );
    try {
      throwIfCancelled();
      const vector = normalizeEmbedding(
        await pool.embed(chunk.text, { signal: options.signal }),
        config.dimensions,
      );
      throwIfCancelled();
      const coordinateArtifactId = embeddingArtifactIdentity({
        chunkArtifactId: chunk.artifactId,
        dimensions: config.dimensions,
        dtype,
        exactInputDigest,
        modelId: config.modelId,
        modelRevision: config.revision,
        normalized: true,
        pooling: config.pooling,
        tokenizerId: config.modelId,
        tokenizerRevision: config.revision,
      });
      const artifactId = createIdentity("embedding-model-space", {
        artifactManifestFingerprint: manifestFingerprint,
        coordinateArtifactId,
        modelSpaceId: space,
      });
      const row = {
        artifact_id: artifactId,
        byte_length: vector.length * 4,
        chunk_artifact_id: chunk.artifactId,
        created_at: store.currentTimestamp(),
        dimensions: config.dimensions,
        dtype,
        exact_input_digest: exactInputDigest,
        model_id: config.modelId,
        model_revision: config.revision,
        normalized: true,
        payload_json: JSON.stringify({
          artifactManifestFingerprint: manifestFingerprint,
          inferenceDtype: config.dtype,
          modelSpaceId: space,
          tokenizerId: config.modelId,
          tokenizerRevision: config.revision,
          version: "retrieval-embedding-v1",
        }),
        pooling: config.pooling,
        publication_generation_id: scope.generationId,
        vector,
      };
      throwIfCancelled();
      if (options.reservation)
        await store.putReservedRows(options.reservation, "embeddings", [row], {
          immutable: false,
        });
      else await store.putRows("embeddings", [row]);
      throwIfCancelled();
      await store.putJob(
        jobFor(store, scope, fingerprint, "succeeded", 1, null, createdAt),
      );
      artifactIds.push(artifactId);
    } catch (error) {
      if (error instanceof StorageError) throw error;
      failed += 1;
      const cancelled =
        options.signal?.aborted || error instanceof EmbeddingCancelledError;
      if (cancelled)
        throw error instanceof EmbeddingCancelledError
          ? error
          : new EmbeddingCancelledError();
      throwIfCancelled();
      await store.putJob(
        jobFor(
          store,
          scope,
          fingerprint,
          "failed",
          1,
          "embedding_failed",
          createdAt,
        ),
      );
      if (options.throwOnFailure) throw error;
    }
  };
  const concurrency = Math.max(1, config.workers + config.maxQueue);
  for (let offset = 0; offset < chunks.length; offset += concurrency) {
    throwIfCancelled();
    await Promise.all(
      chunks.slice(offset, offset + concurrency).map(publishChunk),
    );
    throwIfCancelled();
  }
  return {
    artifactIds: artifactIds.sort(),
    failed,
    modelSpaceId: space,
    published: artifactIds.length,
  };
}

export function syntheticChunkArtifactId(
  chunk: Omit<RetrievalChunk, "artifactId">,
): string {
  return createIdentity("chunks", {
    documentKind: chunk.documentKind,
    language: chunk.language,
    path: chunk.path,
    range: chunk.range,
    sourceArtifactId: chunk.sourceArtifactId,
    storageContract: "retrieval-chunk-v2",
    symbols: [...chunk.symbols].sort(),
    textDigest: digest(chunk.text),
  });
}
