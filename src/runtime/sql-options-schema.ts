import { z } from "zod";

import {
  type SqlAssistanceOptions,
  SQL_NAME_PATTERN,
  SQL_VERSION_PATTERN,
  SQL_SELECTOR_MAX_LENGTH,
} from "./sql-assistance";

const variantSelector = z
  .string()
  .trim()
  .min(1)
  .max(SQL_SELECTOR_MAX_LENGTH)
  .regex(SQL_NAME_PATTERN)
  .toLowerCase();

export const sqlAssistanceOptionsSchema: z.ZodType<SqlAssistanceOptions> = z
  .object({
    dialect: variantSelector.optional(),
    policy: z.enum(["advisory", "required", "skip"]).optional(),
    variant: variantSelector.optional(),
    version: z
      .string()
      .trim()
      .min(1)
      .max(SQL_SELECTOR_MAX_LENGTH)
      .regex(SQL_VERSION_PATTERN)
      .optional(),
  })
  .strict();
