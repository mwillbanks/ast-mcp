import * as z from "zod/v4";
import { FILE_READ_MAX_BATCH } from "../runtime/file-read";

export const chattrSchema = z.object({
  chmod: z.number().int().min(0).max(0o777).optional(),
  chown: z
    .object({
      gid: z.number().int().nonnegative(),
      uid: z.number().int().nonnegative(),
    })
    .optional(),
});

export function boundedRecord<T extends z.ZodType>(schema: T, label: string) {
  return z.record(z.string().min(1), schema).refine((value) => {
    const size = Object.keys(value).length;
    return size > 0 && size <= FILE_READ_MAX_BATCH;
  }, label);
}

export function boundedFileBatch<T extends z.ZodType>(
  schema: T,
  label: string,
) {
  return z.object({ files: boundedRecord(schema, label) }).strict();
}

export function toolFailure(error: unknown) {
  return {
    content: [
      {
        text: error instanceof Error ? error.message : String(error),
        type: "text" as const,
      },
    ],
    isError: true,
  };
}
