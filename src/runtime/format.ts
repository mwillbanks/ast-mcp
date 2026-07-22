import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { runCommandInput } from "./process-input";

const packageRoot = path.resolve(
  import.meta.dir,
  path.basename(import.meta.dir) === "dist" ? ".." : "../..",
);
const dprint = (await import("./native-binaries")).DPRINT_BINARY;
const dprintConfig =
  process.env.AST_MCP_DPRINT_CONFIG ?? path.join(packageRoot, "dprint.json");

export async function formatContent(
  filePath: string,
  content: string,
): Promise<string> {
  const result = await runCommandInput(
    dprint,
    ["fmt", "--config", dprintConfig, "--stdin", path.basename(filePath)],
    content,
  );
  return result.stdout;
}

export async function assertFormattable(filePath: string): Promise<void> {
  await formatContent(filePath, await readFile(filePath, "utf8"));
}

export async function formatFileAtomically(filePath: string): Promise<void> {
  const metadata = await lstat(filePath);
  const formatted = await formatContent(
    filePath,
    await readFile(filePath, "utf8"),
  );
  const extension = path.extname(filePath);
  const temporary = path.join(
    path.dirname(filePath),
    `${path.basename(filePath, extension)}.ast-mcp-format-${randomUUID()}${extension}`,
  );
  try {
    await writeFile(temporary, formatted, {
      encoding: "utf8",
      flag: "wx",
      mode: metadata.mode,
    });
    await chmod(temporary, metadata.mode);
    await rename(temporary, filePath);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}
