import { expect, test } from "bun:test";

async function bun(args: string[]) {
  const child = Bun.spawn([process.execPath, ...args], {
    env: {
      ...process.env,
      AST_MCP_EXPERIMENT_NATIVE_ONLY: "1",
      AST_MCP_EXPERIMENT_LANGUAGE_PROFILE: "core",
      AST_MCP_EXPERIMENT_NATIVE_PACKS: "",
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    child.stdout.text(),
    child.stderr.text(),
  ]);
  return { exitCode, stdout, stderr };
}

test("the runtime ignores the obsolete core profile and the replay detects WASM activation", async () => {
  const dispatcher = new URL(
    "../../src/intelligence/lifecycle/dispatcher.ts",
    import.meta.url,
  ).href;
  const parser = new URL(
    "../../src/intelligence/parser/parser.ts",
    import.meta.url,
  ).href;
  const result = await bun([
    "--eval",
    `
      import { strict as assert } from "node:assert";
      import { IntelligenceSourceDispatcher } from ${JSON.stringify(dispatcher)};
      import { parseSource } from ${JSON.stringify(parser)};

      const dispatcher = new IntelligenceSourceDispatcher({
        parse: async (request) => parseSource(request),
      });
      try {
        const python = parseSource({ languageId: "python", source: "print(1)" });
        assert.equal(python.diagnostics.length, 0);
        for (const [filePath, source, languageId] of [
          ["main.go", "package main\\nfunc main() {}\\n", "go"],
          ["main.rs", "fn main() {}\\n", "rust"],
        ]) {
          const result = await dispatcher.analyze({ filePath, source });
          assert.equal(result.group, "parser");
          assert.equal(result.facts.languageId, languageId);
          assert.equal(result.facts.diagnostics.length, 0);
        }
        await assert.rejects(
          dispatcher.analyze({ filePath: "main.zig", source: "const x = 1;" }),
          /WASM parser activation is disabled in native-only experiments/u,
        );
      } finally {
        await dispatcher.close();
      }
    `,
  ]);
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toContain(
    "WASM parser activation is disabled in native-only experiments",
  );
});
