import { randomUUID } from "node:crypto";
import { chmod, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export async function replaceFileAtomically(
  filePath: string,
  content: string,
  mode: number,
): Promise<void> {
  const extension = path.extname(filePath);
  const temporary = path.join(
    path.dirname(filePath),
    `${path.basename(filePath, extension)}.ast-mcp-restore-${randomUUID()}${extension}`,
  );
  try {
    await writeFile(temporary, content, {
      encoding: "utf8",
      flag: "wx",
      mode,
    });
    await chmod(temporary, mode);
    await rename(temporary, filePath);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}
