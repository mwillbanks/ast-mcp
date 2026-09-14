import { createHash } from "node:crypto";
import { z } from "zod";

export const INTELLIGENCE_SCHEMA_VERSION = "ast-mcp.intelligence.v1" as const;

export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const IdentitySchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]*:v1:[a-f0-9]{64}$/);
export type Identity = z.infer<typeof IdentitySchema>;

export function namespacedIdentitySchema(namespace: string) {
  if (!/^[a-z][a-z0-9-]*$/.test(namespace)) {
    throw new TypeError("Identity namespace must be lowercase kebab-case");
  }
  return z
    .string()
    .regex(
      new RegExp(`^${namespace}:v1:[a-f0-9]{64}$`),
      `Identity must use the ${namespace} namespace`,
    );
}

export const SourceArtifactIdSchema = namespacedIdentitySchema("source");
export const SyntaxFactsArtifactIdSchema =
  namespacedIdentitySchema("syntax-facts");
export const ChunkArtifactIdSchema = namespacedIdentitySchema("chunks");
export const ResolvedRelationshipsArtifactIdSchema = namespacedIdentitySchema(
  "resolved-relationships",
);
export const RevisionManifestArtifactIdSchema =
  namespacedIdentitySchema("revision-manifest");
export const DirtyOverlayArtifactIdSchema =
  namespacedIdentitySchema("dirty-overlay");
export const RepositoryIdSchema = namespacedIdentitySchema("repository");
export const RevisionIdSchema = namespacedIdentitySchema("revision");
export const WorkspaceIdSchema = namespacedIdentitySchema("workspace");
export const StorageDomainIdSchema = namespacedIdentitySchema("storage-domain");
export const GenerationIdSchema = namespacedIdentitySchema("generation");
export const JobIdSchema = namespacedIdentitySchema("job");
export const ReaderPinIdSchema = namespacedIdentitySchema("reader-pin");
export const SearchHitIdSchema = namespacedIdentitySchema("search-hit");

export const NonEmptyStringSchema = z.string().trim().min(1);
export const AbsolutePathSchema = z
  .string()
  .refine(
    (value) => value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value),
    "Path must be absolute",
  );
export const RepositoryRelativePathSchema = z
  .string()
  .min(1)
  .refine(
    (value) => {
      const drivePrefix =
        value.length >= 3 &&
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz".includes(
          value[0] ?? "",
        ) &&
        value[1] === ":" &&
        (value[2] === "/" || value.charCodeAt(2) === 92);
      return !value.startsWith("/") && !drivePrefix;
    },
    { message: "Repository path must be relative" },
  )
  .refine(
    (value) =>
      !value.includes(String.fromCharCode(92)) &&
      !value.includes(String.fromCharCode(0)) &&
      !value.split("/").includes("..") &&
      !value.split("/").includes("."),
    {
      message: "Repository path must use normalized forward-slash segments",
    },
  )
  .refine(
    (value) =>
      value !== "." &&
      !value.startsWith("./") &&
      !value.includes("//") &&
      !value.endsWith("/"),
    { message: "Repository path must be normalized" },
  );

export function compareRepositoryPaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export const TimestampSchema = z.iso.datetime({ offset: true });

export const SourcePositionSchema = z.object({
  column: z.number().int().nonnegative(),
  line: z.number().int().nonnegative(),
});

export const EvidenceRangeSchema = z
  .object({
    end: SourcePositionSchema,
    endByte: z.number().int().nonnegative(),
    start: SourcePositionSchema,
    startByte: z.number().int().nonnegative(),
  })
  .superRefine((range, context) => {
    if (range.endByte < range.startByte) {
      context.addIssue({
        code: "custom",
        message: "endByte must be greater than or equal to startByte",
        path: ["endByte"],
      });
    }
    if (
      range.end.line < range.start.line ||
      (range.end.line === range.start.line &&
        range.end.column < range.start.column)
    ) {
      context.addIssue({
        code: "custom",
        message: "end position must not precede start position",
        path: ["end"],
      });
    }
  });
export type EvidenceRange = z.infer<typeof EvidenceRangeSchema>;

export type IdentityValue =
  | null
  | boolean
  | number
  | string
  | readonly IdentityValue[]
  | { readonly [key: string]: IdentityValue };

export const IdentityValueSchema: z.ZodType<IdentityValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.custom<number>(
      (value) => typeof value === "number" && Number.isFinite(value),
      "Identity numbers must be finite",
    ),
    z.string(),
    z.array(IdentityValueSchema),
    z.record(z.string(), IdentityValueSchema),
  ]),
);

export const IdentityNamespaceSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9-]*$/,
    "Identity namespace must be lowercase kebab-case",
  );

export const CreateIdentityInputSchema = z
  .object({
    namespace: IdentityNamespaceSchema,
    value: IdentityValueSchema,
  })
  .strict();

function canonicalValue(value: IdentityValue): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Identity numbers must be finite");
    }
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalValue(item)).join(",")}]`;
  }
  const record = value as { readonly [key: string]: IdentityValue };
  return `{${Object.keys(record)
    .sort()
    .map(
      (key) => `${JSON.stringify(key)}:${canonicalValue(record[key] ?? null)}`,
    )
    .join(",")}}`;
}

export function canonicalIdentityPayload(value: IdentityValue): string {
  return canonicalValue(IdentityValueSchema.parse(value));
}

export function createIdentity(
  namespace: string,
  value: IdentityValue,
): Identity {
  const parsed = CreateIdentityInputSchema.parse({ namespace, value });
  const digest = createHash("sha256")
    .update(canonicalValue(parsed.value))
    .digest("hex");
  return IdentitySchema.parse(`${parsed.namespace}:v1:${digest}`);
}
