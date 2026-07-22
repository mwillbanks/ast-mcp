import { rm } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const outdir = path.join(root, "dist");

await rm(outdir, { force: true, recursive: true });

const result = await Bun.build({
  entrypoints: [path.join(root, "bin/ast-mcp.ts")],
  format: "esm",
  minify: true,
  outdir,
  sourcemap: "external",
  target: "bun",
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}
