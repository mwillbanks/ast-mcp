import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Lang, parse } from "@ast-grep/napi";
import { pipeline } from "@huggingface/transformers";
import * as lancedb from "@lancedb/lancedb";
import {
  Field,
  FixedSizeList,
  Float32,
  Int32,
  Schema,
  Utf8,
} from "apache-arrow";

const VECTOR_SIZE = 3;
const DEFAULT_MODEL = "onnx-community/granite-embedding-30m-english-ONNX";

export interface QualificationResult {
  ast: {
    language: string;
    matches: number;
    rootKind: string;
  };
  embedding: {
    dimensions?: number;
    model: string;
    normalized?: boolean;
    reason?: string;
    status: "qualified" | "skipped";
  };
  runtime: {
    bun: string;
    platform: string;
  };
  storage: {
    baselineCount: number;
    currentCount: number;
    deletedRemaining: number;
    ftsMatches: number;
    historicalCount: number;
    latestVersion: number;
    updatedText: string;
    vectorNearestId: string;
  };
}

export function normalizeEmbedding(values: ArrayLike<number>): number[] {
  const vector = Array.from(values, Number);
  const magnitude = Math.sqrt(
    vector.reduce((sum, value) => sum + value * value, 0),
  );
  if (!Number.isFinite(magnitude) || magnitude === 0)
    throw new Error("Embedding must have a finite, non-zero magnitude");
  return vector.map((value) => value / magnitude);
}

export function qualifyAst() {
  const source = [
    "export function publish(value: string) {",
    "  console.log(value);",
    "  return value;",
    "}",
  ].join("\n");
  const root = parse(Lang.TypeScript, source);
  const matches = root.root().findAll({
    rule: { pattern: "console.log($VALUE)" },
  });
  return {
    language: Lang.TypeScript,
    matches: matches.length,
    rootKind: String(root.root().kind()),
  };
}

function qualificationSchema() {
  return new Schema([
    new Field("id", new Utf8(), false),
    new Field("text", new Utf8(), false),
    new Field(
      "vector",
      new FixedSizeList(VECTOR_SIZE, new Field("item", new Float32(), false)),
      false,
    ),
    new Field("generation", new Int32(), false),
  ]);
}

export async function qualifyStorage(databasePath: string) {
  const database = await lancedb.connect(databasePath);
  const table = await database.createTable(
    "qualification",
    [
      {
        generation: 1,
        id: "baseline",
        text: "publish stable generation",
        vector: [1, 0, 0],
      },
    ],
    { mode: "overwrite", schema: qualificationSchema() },
  );
  const baselineVersion = await table.version();
  const tags = await table.tags();
  await tags.create("baseline", baselineVersion);
  await table.add([
    {
      generation: 2,
      id: "current",
      text: "search current revision",
      vector: [0, 1, 0],
    },
    {
      generation: 2,
      id: "disposable",
      text: "remove obsolete revision",
      vector: [0, 0, 1],
    },
  ]);
  await table.update({
    values: {
      generation: 3,
      text: "search updated revision",
    },
    where: "id = 'current'",
  });
  await table.delete("id = 'disposable'");
  const latestVersion = await table.version();

  await table.createIndex("text", {
    config: lancedb.Index.fts(),
    replace: true,
  });
  const ftsMatches = await table.search("updated").limit(10).toArray();
  const vectorMatches = await table.search([0.95, 0.05, 0]).limit(1).toArray();
  const currentCount = await table.countRows();
  const deletedRemaining = await table.countRows("id = 'disposable'");
  const updatedRows = await table
    .query()
    .where("id = 'current'")
    .select(["text"])
    .limit(1)
    .toArray();

  await table.checkout("baseline");
  const historicalCount = await table.countRows();
  await table.checkoutLatest();

  return {
    baselineCount: 1,
    currentCount,
    deletedRemaining,
    ftsMatches: ftsMatches.length,
    historicalCount,
    latestVersion,
    updatedText: String(updatedRows[0]?.text),
    vectorNearestId: String(vectorMatches[0]?.id),
  };
}

async function qualifyEmbedding(
  env: NodeJS.ProcessEnv,
): Promise<QualificationResult["embedding"]> {
  const model = env.AST_MCP_EMBEDDING_MODEL ?? DEFAULT_MODEL;
  if (env.AST_MCP_QUALIFY_EMBEDDINGS !== "1") {
    return {
      model,
      reason:
        "Set AST_MCP_QUALIFY_EMBEDDINGS=1 to run the model qualification; ordinary tests never download models.",
      status: "skipped",
    };
  }
  const extractor = await pipeline("feature-extraction", model, {
    device: "cpu",
  });
  const output = await extractor("request scoped workspace identity", {
    normalize: true,
    pooling: "mean",
  });
  const vector = normalizeEmbedding(Array.from(output.data, Number));
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return {
    dimensions: vector.length,
    model,
    normalized: Math.abs(norm - 1) < 1e-5,
    status: "qualified",
  };
}

export async function qualifyIntelligenceDependencies(
  options: { databasePath?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<QualificationResult> {
  const ownedDatabasePath =
    options.databasePath ??
    (await mkdtemp(path.join(os.tmpdir(), "ast-mcp-lancedb-qualification-")));
  try {
    return {
      ast: qualifyAst(),
      embedding: await qualifyEmbedding(options.env ?? process.env),
      runtime: {
        bun: Bun.version,
        platform: `${process.platform}-${process.arch}`,
      },
      storage: await qualifyStorage(ownedDatabasePath),
    };
  } finally {
    if (!options.databasePath)
      await rm(ownedDatabasePath, { force: true, recursive: true });
  }
}

if (import.meta.main) {
  const result = await qualifyIntelligenceDependencies();
  console.log(JSON.stringify(result, null, 2));
}
