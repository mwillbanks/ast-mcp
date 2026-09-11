import { z } from "zod";
import {
  AbsolutePathSchema,
  createIdentity,
  DirtyOverlayArtifactIdSchema,
  INTELLIGENCE_SCHEMA_VERSION,
  NonEmptyStringSchema,
  RepositoryIdSchema,
  RevisionIdSchema,
  Sha256Schema,
  StorageDomainIdSchema,
  WorkspaceIdSchema,
} from "./common.ts";
import { StorageDomainSchema } from "./storage.ts";

export const RevisionSelectorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("working") }).strict(),
  z.object({ kind: z.literal("index") }).strict(),
  z
    .object({
      kind: z.literal("commit"),
      oid: Sha256Schema.or(z.string().regex(/^[a-f0-9]{40}$/)),
    })
    .strict(),
  z.object({ kind: z.literal("branch"), name: NonEmptyStringSchema }).strict(),
  z.object({ kind: z.literal("tag"), name: NonEmptyStringSchema }).strict(),
]);
export type RevisionSelector = z.infer<typeof RevisionSelectorSchema>;

export const ResolvedRevisionSchema = z
  .object({
    readOnly: z.boolean(),
    resolvedCommitOid: z
      .string()
      .regex(/^[a-f0-9]{40}$|^[a-f0-9]{64}$/)
      .nullable(),
    revisionId: RevisionIdSchema,
    selector: RevisionSelectorSchema,
  })
  .strict()
  .superRefine((revision, context) => {
    const historical = revision.selector.kind !== "working";
    if (historical !== revision.readOnly) {
      context.addIssue({
        code: "custom",
        message: historical
          ? "Historical revisions must be read-only"
          : "The working revision must remain writable",
        path: ["readOnly"],
      });
    }
    if (
      ["commit", "branch", "tag"].includes(revision.selector.kind) &&
      revision.resolvedCommitOid === null
    ) {
      context.addIssue({
        code: "custom",
        message: "Historical Git selectors must resolve to a commit",
        path: ["resolvedCommitOid"],
      });
    }
  });
export type ResolvedRevision = z.infer<typeof ResolvedRevisionSchema>;

export const WriteEligibilitySchema = z.discriminatedUnion("eligible", [
  z.object({ eligible: z.literal(true) }).strict(),
  z
    .object({
      eligible: z.literal(false),
      reason: z.enum([
        "historical-revision",
        "outside-checkout",
        "policy-denied",
        "workspace-read-only",
      ]),
    })
    .strict(),
]);

export const WorkspaceContextSchema = z
  .object({
    canonicalRootAnchor: AbsolutePathSchema,
    checkoutRoot: AbsolutePathSchema,
    configurationGeneration: z.number().int().nonnegative(),
    dirtyOverlayId: DirtyOverlayArtifactIdSchema.nullable(),
    repositoryId: RepositoryIdSchema,
    repositoryRoot: AbsolutePathSchema,
    schemaVersion: z.literal(INTELLIGENCE_SCHEMA_VERSION),
    selectedRevision: ResolvedRevisionSchema,
    storageDomain: StorageDomainSchema,
    workspaceId: WorkspaceIdSchema,
    writeEligibility: WriteEligibilitySchema,
  })
  .strict()
  .superRefine((workspace, context) => {
    if (
      workspace.selectedRevision.readOnly &&
      workspace.writeEligibility.eligible
    ) {
      context.addIssue({
        code: "custom",
        message: "A historical revision cannot be write eligible",
        path: ["writeEligibility"],
      });
    }
    if (
      workspace.selectedRevision.selector.kind !== "working" &&
      workspace.dirtyOverlayId !== null
    ) {
      context.addIssue({
        code: "custom",
        message: "Dirty overlays only belong to the working revision",
        path: ["dirtyOverlayId"],
      });
    }
    const expectedRevisionId = createRevisionId({
      repositoryId: workspace.repositoryId,
      resolvedCommitOid: workspace.selectedRevision.resolvedCommitOid,
      selector: workspace.selectedRevision.selector,
    });
    if (workspace.selectedRevision.revisionId !== expectedRevisionId) {
      context.addIssue({
        code: "custom",
        message:
          "Selected revision identity does not match its repository and selector",
        path: ["selectedRevision", "revisionId"],
      });
    }
    const expectedWorkspaceId = createWorkspaceId({
      canonicalCheckoutRoot: workspace.checkoutRoot,
      configurationGeneration: workspace.configurationGeneration,
      dirtyOverlayId: workspace.dirtyOverlayId,
      repositoryId: workspace.repositoryId,
      revisionId: workspace.selectedRevision.revisionId,
      storageDomainId: workspace.storageDomain.domainId,
    });
    if (workspace.workspaceId !== expectedWorkspaceId) {
      context.addIssue({
        code: "custom",
        message: "Workspace identity does not match its request coordinates",
        path: ["workspaceId"],
      });
    }
  });
export type WorkspaceContext = z.infer<typeof WorkspaceContextSchema>;

export const RepositoryIdentityInputSchema = z
  .object({ canonicalGitCommonDirectory: AbsolutePathSchema })
  .strict();

export const RevisionIdentityInputSchema = z
  .object({
    repositoryId: RepositoryIdSchema,
    resolvedCommitOid: z
      .string()
      .regex(/^[a-f0-9]{40}$|^[a-f0-9]{64}$/)
      .nullable(),
    selector: RevisionSelectorSchema,
  })
  .strict()
  .superRefine((input, context) => {
    if (
      ["commit", "branch", "tag"].includes(input.selector.kind) &&
      input.resolvedCommitOid === null
    ) {
      context.addIssue({
        code: "custom",
        message: "Historical revision identities require a resolved commit",
        path: ["resolvedCommitOid"],
      });
    }
  });

export const WorkspaceIdentityInputSchema = z
  .object({
    canonicalCheckoutRoot: AbsolutePathSchema,
    configurationGeneration: z.number().int().nonnegative(),
    dirtyOverlayId: DirtyOverlayArtifactIdSchema.nullable(),
    repositoryId: RepositoryIdSchema,
    revisionId: RevisionIdSchema,
    storageDomainId: StorageDomainIdSchema,
  })
  .strict();

export function createRepositoryId(
  input: z.input<typeof RepositoryIdentityInputSchema>,
): string {
  return createIdentity(
    "repository",
    RepositoryIdentityInputSchema.parse(input),
  );
}

export function createRevisionId(
  input: z.input<typeof RevisionIdentityInputSchema>,
): string {
  return createIdentity("revision", RevisionIdentityInputSchema.parse(input));
}

export function createWorkspaceId(
  input: z.input<typeof WorkspaceIdentityInputSchema>,
): string {
  return createIdentity("workspace", WorkspaceIdentityInputSchema.parse(input));
}
