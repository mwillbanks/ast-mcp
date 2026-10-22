import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  checkRuntimeImports,
  checkRuntimeSource,
  runRuntimeImportCheck,
} from "../../scripts/validation/check-runtime-imports";

test("source inspection preserves development exemptions and ignores text", () => {
  expect(
    checkRuntimeSource("/repo/scripts/tool.ts", 'import "fallow";', "/repo"),
  ).toEqual([]);
  expect(
    checkRuntimeSource(
      "/repo/src/tool.ts",
      '// import "fallow";\nconst value = "oxfmt";',
      "/repo",
    ),
  ).toEqual([]);
  expect(
    checkRuntimeSource(
      "/repo/src/tool.ts",
      '\nimport "fall\\u006fw";',
      "/repo",
    ),
  ).toEqual([
    {
      file: "src/tool.ts",
      line: 2,
      specifier: "fallow",
      message:
        "Keep development tooling out of runtime modules; invoke repository scripts instead.",
    },
  ]);
});

test("runtime scanning tolerates absent roots and propagates filesystem errors", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "ast-mcp-import-errors-"),
  );
  try {
    expect(await checkRuntimeImports(directory)).toEqual([]);
    await writeFile(path.join(directory, "src"), "not a directory");
    await expect(checkRuntimeImports(directory)).rejects.toMatchObject({
      code: "ENOTDIR",
    });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("runtime scanning skips dependencies, hidden directories and non-source files", async () => {
  const result = await lintFixture({
    "src/node_modules/development/index.ts": 'import "fallow";\n',
    "src/.cache/index.ts": 'import "oxfmt";\n',
    "src/readme.txt": 'import "oxlint";\n',
    "src/nested/types.ts":
      'import type { Options } from "oxfmt";\nexport { type Options } from "oxfmt";\n',
    "src/nested/local.ts":
      'const value = "fallow";\nimport(value);\nrequire();\nexport {value};\n',
  });
  expect(result.exitCode, result.output).toBe(0);
});

const root = path.resolve(import.meta.dir, "../..");
const executable = path.join(
  root,
  "scripts/validation/check-runtime-imports.ts",
);

async function lintFixture(files: Record<string, string>) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "ast-mcp-runtime-imports-"),
  );
  try {
    for (const [relative, source] of Object.entries(files)) {
      const file = path.join(directory, relative);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, source);
    }
    const diagnostics: string[] = [];
    const expectedStatus = await runRuntimeImportCheck(directory, (message) =>
      diagnostics.push(message),
    );
    const child = Bun.spawn([process.execPath, executable, directory], {
      cwd: directory,
      env: { ...process.env },
      stderr: "pipe",
      stdout: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode).toBe(expectedStatus);
    expect(stdout).toBe("");
    expect(stderr.trim()).toBe(diagnostics.join("\n"));
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
    "src/template.ts": "const tooling = import(`oxlint/config`);\n",
    "src/require.ts": 'const tooling = require("fallow");\n',
    "src/equals.ts": 'import tooling = require("oxlint");\n',
    "src/mixed.ts": 'import {type Options, format} from "oxfmt";\n',
    "src/empty.ts": 'import {} from "oxlint";\n',
    "src/mixed-export.ts": 'export {type Options, format} from "oxfmt";\n',
    "src/normalized.ts": 'import "../src/../scripts/build/build";\n',
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
    "src/inline-types.ts":
      'import {type Options} from "oxfmt";\nexport {type Options} from "oxfmt";\nimport type Tool = require("fallow");\ntype Tooling = import("oxlint").Options;\n',
    "src/safe.ts": 'import "oxfmt-extra";\nimport "./tooling/local";\n',
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
