import { readdir } from "node:fs/promises";

/** Missing optional source roots are empty; other filesystem failures remain fatal. */
export async function sourceDirectory(directory: string) {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
