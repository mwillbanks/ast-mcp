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
