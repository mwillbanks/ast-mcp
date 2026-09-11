import { z } from "zod";
import {
  AbsolutePathSchema,
  ChunkArtifactIdSchema,
  compareRepositoryPaths,
  createIdentity,
  DirtyOverlayArtifactIdSchema,
  NonEmptyStringSchema,
  RepositoryIdSchema,
  RepositoryRelativePathSchema,
  ResolvedRelationshipsArtifactIdSchema,
  RevisionIdSchema,
  Sha256Schema,
  SourceArtifactIdSchema,
  SyntaxFactsArtifactIdSchema,
} from "./common.ts";

export const ArtifactKindSchema = z.enum([
  "source",
  "syntax-facts",
  "chunks",
  "embedding",
  "resolved-relationships",
  "revision-manifest",
  "dirty-overlay",
]);
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;

export const SourceArtifactInputSchema = z
  .object({
    contentDigest: Sha256Schema,
  })
  .strict();

export const SyntaxFactsArtifactInputSchema = z
  .object({
    languageId: NonEmptyStringSchema,
    parserFingerprint: Sha256Schema,
    sourceArtifactId: SourceArtifactIdSchema,
  })
  .strict();

export const ChunkArtifactInputSchema = z.discriminatedUnion("documentKind", [
  z
    .object({
      chunkerFingerprint: Sha256Schema,
      documentKind: z.literal("code"),
      extractedContentDigest: Sha256Schema,
      semanticContextDigest: Sha256Schema,
      syntaxFactsArtifactId: SyntaxFactsArtifactIdSchema,
    })
    .strict(),
  z
    .object({
      chunkerFingerprint: Sha256Schema,
      documentKind: z.enum(["markdown", "text", "rtf", "structured"]),
      extractedContentDigest: Sha256Schema,
      semanticContextDigest: Sha256Schema,
      sourceArtifactId: SourceArtifactIdSchema,
    })
    .strict(),
]);

export const EmbeddingArtifactInputSchema = z
  .object({
    chunkArtifactId: ChunkArtifactIdSchema,
    dimensions: z.number().int().positive(),
    dtype: z.enum(["float32", "float16", "int8", "uint8"]),
    exactInputDigest: Sha256Schema,
    modelId: NonEmptyStringSchema,
    modelRevision: NonEmptyStringSchema,
    normalized: z.boolean(),
    pooling: z.enum(["mean", "cls", "none"]),
    tokenizerId: NonEmptyStringSchema,
    tokenizerRevision: NonEmptyStringSchema,
  })
  .strict();

export const ResolvedRelationshipsArtifactInputSchema = z
  .object({
    environmentFingerprint: Sha256Schema,
    resolverFingerprint: Sha256Schema,
    syntaxFactsArtifactId: SyntaxFactsArtifactIdSchema,
  })
  .strict();

function addDuplicatePathIssue(
  entries: readonly { path: string }[],
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  entries.forEach((entry, index) => {
    if (seen.has(entry.path)) {
      context.addIssue({
        code: "custom",
        message: "Artifact entries must have unique repository paths",
        path: ["entries", index, "path"],
      });
    }
    seen.add(entry.path);
  });
}

export const ManifestEntrySchema = z
  .object({
    path: RepositoryRelativePathSchema,
    resolvedRelationshipsArtifactId:
      ResolvedRelationshipsArtifactIdSchema.nullable(),
    sourceArtifactId: SourceArtifactIdSchema,
    syntaxFactsArtifactId: SyntaxFactsArtifactIdSchema.nullable(),
  })
  .strict();

export const RevisionManifestArtifactInputSchema = z
  .object({
    dirtyOverlayId: DirtyOverlayArtifactIdSchema.nullable(),
    entries: z.array(ManifestEntrySchema),
    repositoryId: RepositoryIdSchema,
    revisionId: RevisionIdSchema,
  })
  .strict()
  .superRefine((manifest, context) => {
    addDuplicatePathIssue(manifest.entries, context);
  });

export const DirtyOverlayEntrySchema = z
  .object({
    contentDigest: Sha256Schema.nullable(),
    path: RepositoryRelativePathSchema,
    status: z.enum(["added", "modified", "deleted"]),
  })
  .strict()
  .superRefine((entry, context) => {
    const mustHaveDigest = entry.status !== "deleted";
    if (mustHaveDigest !== (entry.contentDigest !== null)) {
      context.addIssue({
        code: "custom",
        message:
          entry.status === "deleted"
            ? "Deleted overlay entries cannot have content"
            : "Added and modified overlay entries require content",
        path: ["contentDigest"],
      });
    }
  });

export const DirtyOverlayArtifactInputSchema = z
  .object({
    baseRevisionId: RevisionIdSchema,
    checkoutRoot: AbsolutePathSchema,
    entries: z.array(DirtyOverlayEntrySchema),
    repositoryId: RepositoryIdSchema,
  })
  .strict()
  .superRefine((overlay, context) => {
    addDuplicatePathIssue(overlay.entries, context);
  });

export type SourceArtifactInput = z.infer<typeof SourceArtifactInputSchema>;
export type SyntaxFactsArtifactInput = z.infer<
  typeof SyntaxFactsArtifactInputSchema
>;
export type ChunkArtifactInput = z.infer<typeof ChunkArtifactInputSchema>;
export type EmbeddingArtifactInput = z.infer<
  typeof EmbeddingArtifactInputSchema
>;
export type ResolvedRelationshipsArtifactInput = z.infer<
  typeof ResolvedRelationshipsArtifactInputSchema
>;
export type RevisionManifestArtifactInput = z.infer<
  typeof RevisionManifestArtifactInputSchema
>;
export type DirtyOverlayArtifactInput = z.infer<
  typeof DirtyOverlayArtifactInputSchema
>;

export const sourceArtifactIdentity = (input: SourceArtifactInput): string =>
  createIdentity("source", SourceArtifactInputSchema.parse(input));

export const syntaxFactsArtifactIdentity = (
  input: SyntaxFactsArtifactInput,
): string =>
  createIdentity("syntax-facts", SyntaxFactsArtifactInputSchema.parse(input));

export const chunkArtifactIdentity = (input: ChunkArtifactInput): string =>
  createIdentity("chunks", ChunkArtifactInputSchema.parse(input));

export const embeddingArtifactIdentity = (
  input: EmbeddingArtifactInput,
): string =>
  createIdentity("embedding", EmbeddingArtifactInputSchema.parse(input));

export const resolvedRelationshipsArtifactIdentity = (
  input: ResolvedRelationshipsArtifactInput,
): string =>
  createIdentity(
    "resolved-relationships",
    ResolvedRelationshipsArtifactInputSchema.parse(input),
  );

export function revisionManifestArtifactIdentity(
  input: RevisionManifestArtifactInput,
): string {
  const parsed = RevisionManifestArtifactInputSchema.parse(input);
  return createIdentity("revision-manifest", {
    ...parsed,
    entries: [...parsed.entries].sort((left, right) =>
      compareRepositoryPaths(left.path, right.path),
    ),
  });
}

export function dirtyOverlayArtifactIdentity(
  input: DirtyOverlayArtifactInput,
): string {
  const parsed = DirtyOverlayArtifactInputSchema.parse(input);
  return createIdentity("dirty-overlay", {
    ...parsed,
    entries: [...parsed.entries].sort((left, right) =>
      compareRepositoryPaths(left.path, right.path),
    ),
  });
}
