import { z } from "zod";

const toolNameSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(
    /^[a-zA-Z0-9_.:-]+$/,
    "tool names may contain letters, digits, _, ., :, and - only",
  );

export function createHookSchema(maxTools: number) {
  return z
    .object({
      allow_tools: z.array(toolNameSchema).max(maxTools).optional(),
      block_tools: z.array(toolNameSchema).max(maxTools).optional(),
      enabled: z.boolean().optional(),
    })
    .strict()
    .superRefine((value, context) => {
      const allowed = new Set(
        (value.allow_tools ?? []).map((tool) => tool.toLowerCase()),
      );
      for (const tool of value.block_tools ?? [])
        if (allowed.has(tool.toLowerCase()))
          context.addIssue({
            code: "custom",
            message: `hook tool "${tool}" cannot be both allowed and blocked`,
            path: ["block_tools"],
          });
    });
}

const positiveInteger = z.number().int().positive();

const formatterFields = {
  args: z.array(z.string().max(4096)).max(64).optional(),
  command: z.string().min(1).max(4096),
  extensions: z
    .array(z.string().regex(/^\.[^./\\]+$/, "extensions must begin with a dot"))
    .max(64)
    .optional(),
  globs: z.array(z.string().min(1).max(4096)).max(64).optional(),
  timeout_ms: positiveInteger.max(120_000).optional(),
};

export function createFormatterSchema<T extends z.ZodRawShape>(extra: T) {
  return z
    .object({ ...formatterFields, ...extra })
    .strict()
    .refine((value) => {
      const candidate = value as {
        extensions?: string[];
        globs?: string[];
      };
      return (
        Boolean(candidate.extensions?.length) ||
        Boolean(candidate.globs?.length)
      );
    }, "formatter requires at least one extension or glob");
}

export const dependenciesSchema = z
  .object({
    ast_bro_binary: z.string().min(1).optional(),
    dprint_binary: z.string().min(1).optional(),
  })
  .strict();

export const httpSchema = z
  .object({
    host: z.string().min(1).optional(),
    port: z.number().int().min(1).max(65_535).optional(),
    session_sweep_interval_ms: positiveInteger.optional(),
    session_timeout_ms: positiveInteger.optional(),
  })
  .strict();

export const workspaceSchema = z
  .object({ roots: z.array(z.string().min(1)).min(1).optional() })
  .strict();
