import { z } from "zod";
import {
  INTELLIGENCE_SCHEMA_VERSION,
  NonEmptyStringSchema,
  Sha256Schema,
} from "./common.ts";

export const CapabilityStatusSchema = z.enum([
  "supported",
  "partial",
  "unsupported",
]);
export const CapabilityProviderSchema = z.enum([
  "tree-sitter",
  "ast-grep",
  "structured-parser",
  "text",
  "custom",
  "none",
]);

export const CapabilityClaimSchema = z
  .object({
    implementationFingerprint: Sha256Schema.nullable(),
    limitations: z.array(NonEmptyStringSchema),
    provider: CapabilityProviderSchema,
    status: CapabilityStatusSchema,
  })
  .strict()
  .superRefine((claim, context) => {
    if (claim.status === "unsupported") {
      if (
        claim.provider !== "none" ||
        claim.implementationFingerprint !== null
      ) {
        context.addIssue({
          code: "custom",
          message: "Unsupported capabilities cannot claim an implementation",
        });
      }
      if (claim.limitations.length === 0) {
        context.addIssue({
          code: "custom",
          message: "Unsupported capabilities must explain their limitation",
          path: ["limitations"],
        });
      }
      return;
    }
    if (claim.provider === "none" || claim.implementationFingerprint === null) {
      context.addIssue({
        code: "custom",
        message: "Supported capabilities require an implementation",
      });
    }
    if (claim.status === "partial" && claim.limitations.length === 0) {
      context.addIssue({
        code: "custom",
        message: "Partial capabilities must state their limitations",
        path: ["limitations"],
      });
    }
    if (claim.status === "supported" && claim.limitations.length > 0) {
      context.addIssue({
        code: "custom",
        message: "Capabilities with limitations must be marked partial",
        path: ["status"],
      });
    }
  });
export type CapabilityClaim = z.infer<typeof CapabilityClaimSchema>;

export const StructuredParserBehaviorSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("none") }).strict(),
  z
    .object({
      formats: z
        .array(z.enum(["json", "jsonc", "yaml", "toml", "markdown", "rtf"]))
        .min(1),
      mode: z.literal("native"),
      preservesComments: z.boolean(),
    })
    .strict(),
  z
    .object({
      formats: z
        .array(z.enum(["json", "jsonc", "yaml", "toml", "markdown", "rtf"]))
        .min(1),
      limitation: NonEmptyStringSchema,
      mode: z.literal("text-fallback"),
    })
    .strict(),
]);

export const LanguageCapabilitySchema = z
  .object({
    callResolution: CapabilityClaimSchema,
    embeddedLanguageIds: z.array(NonEmptyStringSchema),
    embeddedLanguages: CapabilityClaimSchema,
    exportResolution: CapabilityClaimSchema,
    extensions: z.array(NonEmptyStringSchema),
    importResolution: CapabilityClaimSchema,
    inheritanceResolution: CapabilityClaimSchema,
    languageId: NonEmptyStringSchema,
    match: CapabilityClaimSchema,
    parse: CapabilityClaimSchema,
    rewrite: CapabilityClaimSchema,
    schemaVersion: z.literal(INTELLIGENCE_SCHEMA_VERSION),
    structuralRead: CapabilityClaimSchema,
    structuredParser: StructuredParserBehaviorSchema,
    symbolExtraction: CapabilityClaimSchema,
  })
  .strict()
  .superRefine((capability, context) => {
    if (
      capability.embeddedLanguages.status === "unsupported" &&
      capability.embeddedLanguageIds.length > 0
    ) {
      context.addIssue({
        code: "custom",
        message: "Unsupported embedded languages cannot list language IDs",
        path: ["embeddedLanguageIds"],
      });
    }
    if (
      capability.rewrite.status !== "unsupported" &&
      (capability.parse.status === "unsupported" ||
        capability.match.status === "unsupported")
    ) {
      context.addIssue({
        code: "custom",
        message: "Rewrite support requires parse and match support",
        path: ["rewrite"],
      });
    }
    if (
      capability.structuredParser.mode !== "none" &&
      capability.structuralRead.status === "unsupported"
    ) {
      context.addIssue({
        code: "custom",
        message: "Structured parser behavior requires structural reads",
        path: ["structuredParser"],
      });
    }
  });
export type LanguageCapability = z.infer<typeof LanguageCapabilitySchema>;
