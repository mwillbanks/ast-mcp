import {
  Binary,
  Bool,
  type DataType,
  Field,
  Float32,
  Float64,
  List,
  Schema,
  Utf8,
} from "apache-arrow";
import {
  COMPLETE_GENERATION_TABLES,
  type LanceTableName,
} from "../contracts/storage.ts";
import { StorageError } from "./errors.ts";

const text = () => new Utf8();
const number = () => new Float64();
const boolean = () => new Bool();
const bytes = () => new Binary();
const vector = () => new List(new Field("item", new Float32(), true));

type Column = readonly [name: string, type: DataType, nullable?: boolean];

function schema(columns: readonly Column[]): Schema {
  return new Schema(
    columns.map(
      ([name, type, nullable = false]) => new Field(name, type, nullable),
    ),
  );
}

function generationSchema(columns: readonly Column[]): Schema {
  return schema([...columns, ["publication_generation_id", text(), true]]);
}

export const TABLE_SCHEMAS = {
  artifacts: generationSchema([
    ["artifact_id", text()],
    ["kind", text()],
    ["content_digest", text(), true],
    ["content_bytes", bytes(), true],
    ["byte_length", number()],
    ["created_at", text()],
    ["payload_json", text()],
  ]),
  chunks: generationSchema([
    ["artifact_id", text()],
    ["source_artifact_id", text(), true],
    ["syntax_facts_artifact_id", text(), true],
    ["document_kind", text()],
    ["extracted_content_digest", text()],
    ["semantic_context_digest", text()],
    ["byte_length", number()],
    ["text", text()],
    ["created_at", text()],
    ["payload_json", text()],
  ]),
  communities: generationSchema([
    ["community_id", text()],
    ["generation_id", text()],
    ["revision_id", text()],
    ["algorithm", text()],
    ["resolution", number()],
    ["member_ids_json", text()],
    ["created_at", text()],
    ["payload_json", text()],
  ]),
  coordinator_recovery: schema([
    ["lease_key", text()],
    ["coordinator_id", text()],
    ["storage_domain_id", text()],
    ["owner_id", text()],
    ["epoch", number()],
    ["state", text()],
    ["acquired_at", text()],
    ["heartbeat_at", text()],
    ["lease_expires_at", text()],
    ["in_flight_job_ids_json", text()],
    ["last_published_generation_id", text(), true],
    ["recovered_at", text(), true],
    ["payload_json", text()],
  ]),
  dirty_overlays: generationSchema([
    ["artifact_id", text()],
    ["repository_id", text()],
    ["base_revision_id", text()],
    ["checkout_root", text()],
    ["entry_count", number()],
    ["logical_bytes", number()],
    ["created_at", text()],
    ["payload_json", text()],
  ]),
  embeddings: generationSchema([
    ["artifact_id", text()],
    ["chunk_artifact_id", text()],
    ["model_id", text()],
    ["model_revision", text()],
    ["dimensions", number()],
    ["dtype", text()],
    ["normalized", boolean()],
    ["pooling", text()],
    ["exact_input_digest", text()],
    ["vector", vector()],
    ["byte_length", number()],
    ["created_at", text()],
    ["payload_json", text()],
  ]),
  graph_edges: generationSchema([
    ["edge_id", text()],
    ["source_node_id", text()],
    ["target_node_id", text()],
    ["kind", text()],
    ["discriminator", text()],
    ["resolution_status", text()],
    ["environment_fingerprint", text(), true],
    ["content_fingerprint", text()],
    ["properties_json", text()],
    ["created_at", text()],
  ]),
  graph_evidence: generationSchema([
    ["evidence_id", text()],
    ["edge_id", text()],
    ["occurrence_id", text()],
    ["source_artifact_id", text()],
    ["path", text()],
    ["range_json", text()],
    ["extraction_method", text()],
    ["extraction_version", text()],
    ["extractor_fingerprint", text()],
    ["confidence", number()],
    ["created_at", text()],
  ]),
  graph_nodes: generationSchema([
    ["node_id", text()],
    ["canonical_name", text()],
    ["kind", text()],
    ["content_fingerprint", text()],
    ["properties_json", text()],
    ["created_at", text()],
  ]),
  graph_occurrences: generationSchema([
    ["occurrence_id", text()],
    ["node_id", text()],
    ["source_artifact_id", text()],
    ["path", text()],
    ["role", text()],
    ["range_json", text()],
    ["created_at", text()],
  ]),
  jobs: schema([
    ["job_id", text()],
    ["idempotency_key", text()],
    ["type", text()],
    ["state", text()],
    ["attempt", number()],
    ["workspace_id", text()],
    ["revision_id", text()],
    ["storage_domain_id", text()],
    ["error_code", text(), true],
    ["created_at", text()],
    ["updated_at", text()],
    ["payload_json", text()],
  ]),
  migrations: schema([
    ["migration_id", text()],
    ["from_schema_version", text()],
    ["to_schema_version", text()],
    ["state", text()],
    ["started_at", text()],
    ["completed_at", text(), true],
    ["payload_json", text()],
  ]),
  publications: schema([
    ["generation_id", text()],
    ["workspace_id", text()],
    ["revision_id", text()],
    ["storage_domain_id", text()],
    ["manifest_artifact_id", text()],
    ["table_versions_json", text()],
    ["published_at", text()],
    ["schema_version", text()],
    ["state", text()],
    ["immutable", boolean()],
    ["payload_json", text()],
  ]),
  reader_pins: schema([
    ["pin_id", text()],
    ["reader_id", text()],
    ["generation_id", text()],
    ["workspace_id", text()],
    ["revision_id", text()],
    ["storage_domain_id", text()],
    ["manifest_artifact_id", text()],
    ["table_versions_json", text()],
    ["created_at", text()],
    ["expires_at", text()],
    ["payload_json", text()],
  ]),
  relationships: generationSchema([
    ["artifact_id", text()],
    ["syntax_facts_artifact_id", text()],
    ["environment_fingerprint", text()],
    ["resolver_fingerprint", text()],
    ["byte_length", number()],
    ["created_at", text()],
    ["payload_json", text()],
  ]),
  retention: schema([
    ["policy_id", text()],
    ["keep_failed_jobs_for_days", number()],
    ["keep_published_generations", number()],
    ["pin_grace_seconds", number()],
    ["unreachable_artifact_days", number()],
    ["preserve_reader_pins", boolean()],
    ["updated_at", text()],
    ["payload_json", text()],
  ]),
  revision_manifests: generationSchema([
    ["artifact_id", text()],
    ["repository_id", text()],
    ["revision_id", text()],
    ["dirty_overlay_id", text(), true],
    ["entry_count", number()],
    ["logical_bytes", number()],
    ["created_at", text()],
    ["payload_json", text()],
  ]),
  revision_membership: generationSchema([
    ["membership_id", text()],
    ["entity_id", text()],
    ["entity_kind", text()],
    ["generation_id", text()],
    ["revision_id", text()],
    ["created_at", text()],
  ]),
  summaries: generationSchema([
    ["summary_id", text()],
    ["generation_id", text()],
    ["revision_id", text()],
    ["subject_id", text()],
    ["summary_kind", text()],
    ["model_id", text(), true],
    ["content", text()],
    ["content_digest", text()],
    ["created_at", text()],
    ["payload_json", text()],
  ]),
  syntax_facts: generationSchema([
    ["artifact_id", text()],
    ["source_artifact_id", text()],
    ["language_id", text()],
    ["parser_fingerprint", text()],
    ["byte_length", number()],
    ["created_at", text()],
    ["payload_json", text()],
  ]),
  workspaces: generationSchema([
    ["workspace_id", text()],
    ["repository_id", text()],
    ["revision_id", text()],
    ["storage_domain_id", text()],
    ["manifest_artifact_id", text(), true],
    ["logical_bytes", number()],
    ["active", boolean()],
    ["updated_at", text()],
    ["payload_json", text()],
  ]),
} as const satisfies Record<LanceTableName, Schema>;

export const ALL_TABLES = Object.freeze(
  Object.keys(TABLE_SCHEMAS) as LanceTableName[],
);

if (
  COMPLETE_GENERATION_TABLES.some((table) => !ALL_TABLES.includes(table)) ||
  ALL_TABLES.length !== 21
) {
  throw new Error("LanceDB schema registry is incomplete");
}

export const TABLE_PRIMARY_KEYS = {
  artifacts: "artifact_id",
  chunks: "artifact_id",
  communities: "community_id",
  coordinator_recovery: "lease_key",
  dirty_overlays: "artifact_id",
  embeddings: "artifact_id",
  graph_edges: "edge_id",
  graph_evidence: "evidence_id",
  graph_nodes: "node_id",
  graph_occurrences: "occurrence_id",
  jobs: "job_id",
  migrations: "migration_id",
  publications: "generation_id",
  reader_pins: "pin_id",
  relationships: "artifact_id",
  retention: "policy_id",
  revision_manifests: "artifact_id",
  revision_membership: "membership_id",
  summaries: "summary_id",
  syntax_facts: "artifact_id",
  workspaces: "workspace_id",
} as const satisfies Record<LanceTableName, string>;

export const IMMUTABLE_TABLES = new Set<LanceTableName>([
  "artifacts",
  "syntax_facts",
  "chunks",
  "embeddings",
  "relationships",
  "revision_manifests",
  "dirty_overlays",
  "graph_nodes",
  "graph_occurrences",
  "graph_edges",
  "graph_evidence",
  "revision_membership",
  "communities",
  "summaries",
]);

export function assertCompatibleSchema(
  table: LanceTableName,
  actual: Schema,
): void {
  const expected = TABLE_SCHEMAS[table];
  const actualSignature = actual.fields.map((field) => ({
    name: field.name,
    nullable: field.nullable,
    type: field.type.toString(),
  }));
  const expectedSignature = expected.fields.map((field) => ({
    name: field.name,
    nullable: field.nullable,
    type: field.type.toString(),
  }));
  if (JSON.stringify(actualSignature) !== JSON.stringify(expectedSignature)) {
    throw new StorageError(
      "invalid_schema",
      `LanceDB table ${table} does not match ast-mcp intelligence schema`,
      false,
      { actual: actualSignature, expected: expectedSignature, table },
    );
  }
}

export type StorageRow = Record<string, unknown>;
