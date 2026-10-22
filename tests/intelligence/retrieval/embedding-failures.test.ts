import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createPotionStaticSession,
  EmbeddingModelConfigSchema,
  EmbeddingWorkerPool,
  TransformersEmbeddingProvider,
  verifyLocalModelArtifacts,
} from "../../../src/intelligence/retrieval/index.ts";

const tensor = (header: unknown, dataBytes = 8): Uint8Array => {
  const json = Buffer.from(JSON.stringify(header));
  const bytes = Buffer.alloc(8 + json.length + dataBytes);
  bytes.writeBigUInt64LE(BigInt(json.length));
  json.copy(bytes, 8);
  bytes.writeFloatLE(1, 8 + json.length);
  return bytes;
};

describe("embedding malformed input and cancellation contracts", () => {
  test("verifies Git blob checksums and rejects unsupported checksum encodings", async () => {
    const root = await mkdtemp(join(tmpdir(), "ast-model-checksum-"));
    try {
      const bytes = Buffer.from("model fixture");
      await writeFile(join(root, "model.bin"), bytes);
      const hash = createHash("sha1")
        .update(Buffer.from("blob " + bytes.length + "\0"))
        .update(bytes)
        .digest("hex");
      const base = { localPath: root, dimensions: 2 };
      await expect(
        verifyLocalModelArtifacts(
          EmbeddingModelConfigSchema.parse({
            ...base,
            artifacts: { "model.bin": "git-sha1:" + hash },
          }),
        ),
      ).resolves.toBeUndefined();
      await expect(
        verifyLocalModelArtifacts(
          EmbeddingModelConfigSchema.parse({
            ...base,
            artifacts: { "model.bin": "md5:invalid" },
          }),
        ),
      ).rejects.toThrow("unsupported_checksum:md5");
      await expect(
        verifyLocalModelArtifacts(
          EmbeddingModelConfigSchema.parse({
            ...base,
            artifacts: { "model.bin": "invalid" },
          }),
        ),
      ).rejects.toThrow("invalid_checksum");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects transformer batch dimensions and avoids loading empty batches", async () => {
    let loads = 0;
    const provider = new TransformersEmbeddingProvider(
      { artifacts: {}, dimensions: 2 },
      true,
      async () => {
        loads++;
        return async () => ({ data: [1] });
      },
    );
    expect(await provider.embed([])).toEqual([]);
    expect(loads).toBe(0);
    await expect(provider.embed(["query"])).rejects.toThrow(
      "embedding_batch_dimension_mismatch:1:2",
    );
    expect(loads).toBe(1);
    await provider.close();
  });

  test("rejects malformed static tensor headers, shapes, and byte ranges", async () => {
    const config = EmbeddingModelConfigSchema.parse({
      artifacts: {},
      dimensions: 2,
      localPath: "/fixture",
    });
    const options = {
      verifyArtifacts: async () => {},
      tokenizerFactory: async () => () => ({
        input_ids: { data: [0], dims: [1, 1] },
      }),
    };
    await expect(
      createPotionStaticSession({ ...config, localPath: null }, options),
    ).rejects.toThrow("embedding_model_not_configured");
    const badHeader = Buffer.alloc(10);
    badHeader.writeBigUInt64LE(100n);
    for (const bytes of [
      Buffer.alloc(4),
      badHeader,
      tensor({ only: { dtype: "I32", shape: [1, 2], data_offsets: [0, 8] } }),
      tensor({
        embeddings: { dtype: "F32", shape: [0, 2], data_offsets: [0, 8] },
      }),
      tensor({
        embeddings: { dtype: "F32", shape: [1, 2], data_offsets: [-1, 7] },
      }),
      tensor({
        embeddings: { dtype: "F32", shape: [1, 2], data_offsets: [0, 1000] },
      }),
    ])
      await expect(
        createPotionStaticSession(config, {
          ...options,
          readModel: async () => bytes,
        }),
      ).rejects.toThrow(/potion_static_tensor_(invalid|missing)/);
  });

  test("rejects tokenizer shapes, invalid IDs, and fully masked token rows", async () => {
    const config = EmbeddingModelConfigSchema.parse({
      artifacts: {},
      dimensions: 2,
      localPath: "/fixture",
    });
    const bytes = tensor({
      embeddings: { dtype: "F32", shape: [1, 2], data_offsets: [0, 8] },
    });
    for (const [encoded, error] of [
      [
        { input_ids: { data: [], dims: [1, 0] } },
        "potion_tokenizer_shape_invalid",
      ],
      [
        { input_ids: { data: [], dims: [1, 1] } },
        "potion_tokenizer_shape_invalid",
      ],
      [{ input_ids: { data: [2], dims: [1, 1] } }, "potion_token_id_invalid"],
      [{ input_ids: { data: [-1], dims: [1, 1] } }, "potion_token_id_invalid"],
      [
        {
          input_ids: { data: [0], dims: [1, 1] },
          attention_mask: { data: [0] },
        },
        "potion_tokenization_empty",
      ],
    ] as const) {
      const session = await createPotionStaticSession(config, {
        verifyArtifacts: async () => {},
        readModel: async () => bytes,
        tokenizerFactory: async () => () => encoded,
      });
      await expect(session.embed(["query"])).rejects.toThrow(error);
    }
  });

  test("rejects queued and in-flight cancelled requests and exhausts retries", async () => {
    const config = EmbeddingModelConfigSchema.parse({
      artifacts: {},
      dimensions: 2,
      batchSize: 1,
      workers: 1,
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const provider = {
      config,
      close: async () => {},
      embed: async () => {
        await gate;
        return [[1, 0]];
      },
    };
    const pool = new EmbeddingWorkerPool(config, () => provider);
    const activeAbort = new AbortController();
    const queuedAbort = new AbortController();
    const active = pool
      .embed("active", { signal: activeAbort.signal })
      .catch((error: unknown) => error);
    const queued = pool
      .embed("queued", { signal: queuedAbort.signal })
      .catch((error: unknown) => error);
    const successful = pool.embed("healthy");
    activeAbort.abort();
    queuedAbort.abort();
    release();
    expect(await active).toMatchObject({ name: "EmbeddingCancelledError" });
    expect(await queued).toMatchObject({ name: "EmbeddingCancelledError" });
    expect(await successful).toEqual([1, 0]);
    await pool.close();
    let attempts = 0;
    const failing = new EmbeddingWorkerPool(config, () => ({
      config,
      close: async () => {},
      embed: async () => {
        attempts++;
        throw new Error("persistent inference failure");
      },
    }));
    await expect(failing.embed("query", { retries: 1 })).rejects.toThrow(
      "persistent inference failure",
    );
    expect(attempts).toBe(2);
    expect(failing.pending).toBe(0);
    await failing.close();
  });
});
