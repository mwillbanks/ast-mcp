import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const executable = path.join(
  path.dirname(Bun.resolveSync("oxlint/package.json", root)),
  "bin/oxlint",
);

async function lintFixture(files: Record<string, string>) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "ast-mcp-runtime-imports-"),
  );
  try {
    await copyFile(
      path.join(root, ".oxlintrc.json"),
      path.join(directory, ".oxlintrc.json"),
    );
    for (const [relative, source] of Object.entries(files)) {
      const file = path.join(directory, relative);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, source);
    }
    const child = Bun.spawn(
      [process.execPath, executable, "--deny-warnings", "."],
      {
        cwd: directory,
        env: { ...process.env },
        stderr: "pipe",
        stdout: "pipe",
      },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exitCode, output: `${stdout}\n${stderr}`.replaceAll("\\", "/") };
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

test("runtime modules reject development packages and script imports", async () => {
  const files = {
    "src/static.ts": 'import "oxfmt";\n',
    "src/subpath.ts": 'export * from "oxlint/config";\n',
    "src/dynamic.ts": 'export const tooling = import("fallow");\n',
    "src/inspector.ts": 'import "@modelcontextprotocol/inspector/cli";\n',
    "src/nested/script.ts": 'import "../../scripts/build/build";\n',
    "src/test.ts": 'export * from "../tests/support/example";\n',
    "bin/example.ts": 'import "oxlint";\n',
  };
  const result = await lintFixture(files);
  expect(result.exitCode).toBe(1);
  expect(result.output).toContain("no-restricted-imports");
  for (const file of Object.keys(files)) expect(result.output).toContain(file);
  expect(result.output).toContain(
    "Runtime modules must not import development scripts or tests",
  );
  expect(result.output).toContain(
    "Keep development tooling out of runtime modules",
  );
});

test("runtime type imports and intentional dependencies remain permitted", async () => {
  const result = await lintFixture({
    "src/types.ts":
      'export type { CheckOutput } from "fallow/types";\nimport type { Options } from "oxfmt";\nexport type FormatterOptions = Options;\n',
    "src/tool-types.ts":
      'export type { Fixture } from "../tests/support/example";\n',
    "src/intelligence.ts":
      'export * from "@lancedb/lancedb";\nexport * from "typescript/unstable/ast";\n',
    "scripts/build/build.ts": 'import "oxfmt";\nimport "oxlint";\n',
    "tests/tooling.test.ts": 'import "fallow";\n',
  });
  expect(result.exitCode, result.output).toBe(0);
  expect(result.output).not.toContain("no-restricted-imports");
});
