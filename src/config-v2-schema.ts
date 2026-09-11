import { z } from "zod";
import {
  createFormatterSchema,
  createHookSchema,
  dependenciesSchema,
  httpSchema,
  workspaceSchema,
} from "./config-schema-common";

const schemaVersion = 2 as const;
const pathPolicy = z.enum(["allow", "request", "deny"]);

const storagePlacementSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("global") }).strict(),
  z.object({ kind: z.literal("local") }).strict(),
  z
    .object({
      kind: z.literal("parent"),
      levels: z.number().int().min(1).max(32),
    })
    .strict(),
  z
    .object({
      kind: z.literal("explicit"),
      path: z.string().min(1).max(4096),
    })
    .strict(),
]);

const embeddingSchema = z
  .object({
    batch_size: z.number().int().positive().max(256).optional(),
    device: z.enum(["auto", "cpu", "gpu", "wasm", "webgpu"]).optional(),
    dimensions: z.number().int().positive().max(65_536).optional(),
    dtype: z.enum(["fp32", "fp16", "q8", "q4"]).optional(),
    local_path: z.string().min(1).nullable().optional(),
    max_queue: z.number().int().positive().max(100_000).optional(),
    model_id: z.string().min(1).max(512).optional(),
    pooling: z.enum(["mean", "cls"]).optional(),
    revision: z.string().min(1).max(512).optional(),
    workers: z.number().int().positive().max(32).optional(),
  })
  .strict();

const generationProviderSchema = z.discriminatedUnion("kind", [
  z
    .object({
      api_key_env: z.string().min(1).max(256).optional(),
      endpoint: z.string().url().max(4096),
      kind: z.literal("http"),
      model: z.string().min(1).max(512),
    })
    .strict(),
  z
    .object({
      kind: z.literal("mcp"),
      model: z.string().min(1).max(512),
      server_id: z.string().min(1).max(512).default("host"),
    })
    .strict(),
]);

const intelligenceSchema = z
  .object({
    federation: z
      .object({ enabled: z.boolean().optional() })
      .strict()
      .optional(),
    generation: z
      .object({
        enabled: z.boolean().optional(),
        provider: generationProviderSchema.nullable().optional(),
      })
      .strict()
      .optional(),
    retrieval: z
      .object({
        embedding: embeddingSchema.optional(),
        semantic: z.boolean().optional(),
      })
      .strict()
      .optional(),
    storage: z
      .object({ placement: storagePlacementSchema.optional() })
      .strict()
      .optional(),
  })
  .strict();

const formatterV2Schema = createFormatterSchema({
  enabled: z.boolean().optional(),
  id: z.string().min(1).max(128),
  mode: z.enum(["stdout", "in_place"]).default("stdout"),
});

const pathRuleV2Schema = z
  .object({
    excludes: z.array(z.string().min(1).max(4096)).max(256).optional(),
    follow_symlinks: z.boolean().optional(),
    id: z.string().min(1).max(128),
    includes: z.array(z.string().min(1).max(4096)).max(256).optional(),
    path: z.string().min(1).max(4096),
    policies: z
      .object({
        delete: pathPolicy.optional(),
        read: pathPolicy,
        write: pathPolicy,
      })
      .strict(),
  })
  .strict();

export const fileV2Schema = z
  .object({
    dependencies: dependenciesSchema.optional(),
    files: z
      .object({
        patch: z
          .object({
            aider_matchers: z
              .array(
                z.enum([
                  "exact",
                  "whitespace",
                  "relative-indentation",
                  "diff-match-patch",
                ]),
              )
              .max(4)
              .optional(),
            strategies: z
              .array(z.enum(["ast", "aider_block"]))
              .max(2)
              .optional(),
          })
          .strict()
          .optional(),
        read: z
          .object({
            modes: z
              .array(z.enum(["ast", "text"]))
              .max(2)
              .optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    formatting: z
      .object({
        dprint_config: z.string().min(1).optional(),
        enabled: z.boolean().optional(),
        fallback: z.enum(["preserve", "dprint", "reject"]).optional(),
        formatters: z.array(formatterV2Schema).max(64).optional(),
      })
      .strict()
      .optional(),
    http: httpSchema.optional(),
    intelligence: intelligenceSchema.optional(),
    mcp: z
      .object({
        configuration: z
          .object({
            enabled: z.boolean().optional(),
            require_approval: z.boolean().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    paths: z.array(pathRuleV2Schema).max(256).optional(),
    safety: z
      .object({
        hook: createHookSchema(128).optional(),
        require_hash: z.boolean().optional(),
      })
      .strict()
      .optional(),
    version: z.literal(schemaVersion),
    workspace: workspaceSchema.optional(),
  })
  .strict();

export type PathPolicy = z.infer<typeof pathPolicy>;
export type PathRuleV2 = z.infer<typeof pathRuleV2Schema>;
