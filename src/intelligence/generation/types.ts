import { z } from "zod";
import { EvidenceRangeSchema } from "../contracts/common.ts";
import { RetrievalScopeSchema } from "../retrieval/types.ts";

export const GenerationBudgetSchema = z
  .object({
    maxEvidenceBytes: z
      .number()
      .int()
      .positive()
      .max(10_000_000)
      .default(128_000),
    maxEvidenceItems: z.number().int().positive().max(1_000).default(50),
    maxOutputBytes: z.number().int().positive().max(10_000_000).default(32_000),
    maxOutputTokens: z.number().int().positive().max(100_000).default(2_048),
    timeoutMs: z.number().int().positive().max(120_000).default(10_000),
  })
  .strict();

export const HttpGenerationProviderSchema = z
  .object({
    apiKey: z.string().min(1).nullable().default(null),
    endpoint: z.string().url().max(4_096),
    kind: z.literal("http"),
    model: z.string().min(1).max(512),
  })
  .strict();

export const McpGenerationProviderSchema = z
  .object({
    kind: z.literal("mcp"),
    model: z.string().min(1).max(512),
    serverId: z.string().min(1).max(512),
  })
  .strict();

export const GenerationProviderConfigSchema = z.discriminatedUnion("kind", [
  HttpGenerationProviderSchema,
  McpGenerationProviderSchema,
]);

export const GenerationEvidenceSchema = z
  .object({
    artifactId: z.string().min(1).max(1_024),
    entityId: z.string().min(1).max(1_024),
    path: z.string().min(1).max(4_096),
    range: EvidenceRangeSchema,
    scope: RetrievalScopeSchema,
    text: z.string().max(10_000_000),
  })
  .strict();

export const GenerationRequestSchema = z
  .object({
    allowedCorpusArtifactIds: z.array(z.string().min(1).max(1_024)),
    budget: GenerationBudgetSchema.default({
      maxEvidenceBytes: 128_000,
      maxEvidenceItems: 50,
      maxOutputBytes: 32_000,
      maxOutputTokens: 2_048,
      timeoutMs: 10_000,
    }),
    enabled: z.boolean().default(false),
    evidence: z.array(GenerationEvidenceSchema),
    prompt: z.string().min(1).max(1_000_000),
    provider: GenerationProviderConfigSchema.nullable().default(null),
    scope: RetrievalScopeSchema,
    signal: z.instanceof(AbortSignal).optional(),
  })
  .strict();

export const GenerationCitationSchema = z
  .object({
    end: z.number().int().positive(),
    evidenceId: z.string().min(1).max(1_024),
    start: z.number().int().nonnegative(),
  })
  .strict();

export const GeneratedAnswerSchema = z
  .object({
    answer: z.string().min(1).max(10_000_000),
    citations: z.array(GenerationCitationSchema).min(1),
  })
  .strict();

export const GENERATION_RESPONSE_JSON_SCHEMA = Object.freeze({
  additionalProperties: false,
  properties: {
    answer: { maxLength: 10_000_000, minLength: 1, type: "string" },
    citations: {
      items: {
        additionalProperties: false,
        properties: {
          end: { minimum: 1, type: "integer" },
          evidenceId: {
            maxLength: 1_024,
            minLength: 1,
            type: "string",
          },
          start: { minimum: 0, type: "integer" },
        },
        required: ["evidenceId", "start", "end"],
        type: "object",
      },
      type: "array",
    },
  },
  required: ["answer", "citations"],
  type: "object",
} as const);

export type GenerationProviderConfig = z.infer<
  typeof GenerationProviderConfigSchema
>;
export type GenerationRequest = z.input<typeof GenerationRequestSchema>;
export type ResolvedGenerationRequest = z.output<
  typeof GenerationRequestSchema
>;
export type GenerationEvidence = z.infer<typeof GenerationEvidenceSchema>;
export type GeneratedAnswer = z.infer<typeof GeneratedAnswerSchema>;

export type GenerationStatus =
  | "cancelled"
  | "disabled"
  | "failed"
  | "rejected"
  | "succeeded"
  | "timeout"
  | "unavailable";

export interface GenerationResult<T> {
  base: T;
  generated: GeneratedAnswer | null;
  modelIdentity: string | null;
  provider: "http" | "mcp" | null;
  reason: string | null;
  status: GenerationStatus;
}
