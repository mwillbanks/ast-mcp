import { describe, expect, test } from "bun:test";
import { once } from "node:events";
import { Worker } from "node:worker_threads";

import {
  aiderBlockStrategy,
  inlineAiderBlockStrategy,
} from "../../src/patch/strategy/aiderBlock";
import { astStrategy, inlineAstStrategy } from "../../src/patch/strategy/ast";
import { PatchPreparationPool } from "../../src/patch/strategy/worker-client";
import { patchContext } from "../support/patch-context";

const fixture = (body: string) =>
  new URL(
    "data:text/javascript," +
      encodeURIComponent(
        'import { parentPort } from "node:worker_threads"; parentPort.on("message", request => {' +
          body +
          "});",
      ),
  );

describe("native patch worker integration", () => {
  test("preserves native and textual preparation results across the worker boundary", async () => {
    expect(await aiderBlockStrategy.prepare(patchContext())).toEqual(
      await inlineAiderBlockStrategy.prepare(patchContext()),
    );
    const ast = {
      ...patchContext(),
      aiderBlocks: [],
      astRules: [{ pattern: "const value = 1", fix: "const value = 3" }],
    };
    expect(await astStrategy.prepare(ast)).toEqual(
      await inlineAstStrategy.prepare(ast),
    );
    expect((await astStrategy.prepare(ast)).candidate).toBe("const value = 3");
  });
  test("preserves validation and matching errors from both isolated adapters", async () => {
    for (const adapter of [astStrategy, inlineAstStrategy]) {
      await expect(
        adapter.prepare({ ...patchContext(), aiderBlocks: [], astRules: [] }),
      ).rejects.toMatchObject({ code: "patch_strategy_arguments" });
      await expect(
        adapter.prepare({ ...patchContext(), language: undefined }),
      ).rejects.toMatchObject({ code: "patch_strategy_unavailable" });
      await expect(
        adapter.prepare({
          ...patchContext(),
          aiderBlocks: [],
          astRules: [
            {
              expectedMatches: 2,
              pattern: "const value = 1",
              fix: "const value = 2",
            },
          ],
        }),
      ).rejects.toMatchObject({
        code: "ast_match_count",
        details: { expected: 2, matches: 1 },
      });
      await expect(
        adapter.prepare({
          ...patchContext(),
          original: "foo(foo(1));",
          aiderBlocks: [],
          astRules: [
            { expectedMatches: 2, pattern: "foo($A)", fix: "bar($A)" },
          ],
        }),
      ).rejects.toMatchObject({ code: "ast_rewrite_overlap" });
      await expect(
        adapter.prepare({
          ...patchContext(),
          language: "unsupported-language",
          aiderBlocks: [],
          astRules: [{ pattern: "value", fix: "next" }],
        }),
      ).rejects.toMatchObject({ code: "ast_preview_error" });
    }
    for (const adapter of [aiderBlockStrategy, inlineAiderBlockStrategy]) {
      const disabled = patchContext();
      disabled.capabilities.effective.patch = [];
      await expect(adapter.prepare(disabled)).rejects.toMatchObject({
        code: "patch_strategy_unavailable",
      });
      await expect(
        adapter.prepare({ ...patchContext(), aiderBlocks: [] }),
      ).rejects.toMatchObject({ code: "patch_strategy_arguments" });
      await expect(
        adapter.prepare({
          ...patchContext(),
          aiderBlocks: [{ search: "absent", replace: "next" }],
        }),
      ).rejects.toMatchObject({ code: "aider_no_match" });
      const denied = patchContext();
      denied.capabilities.effective.aiderMatchers = [];
      await expect(adapter.prepare(denied)).rejects.toMatchObject({
        code: "aider_matcher_disabled",
      });
      expect(
        (
          await adapter.prepare({
            ...patchContext(),
            aiderBlocks: [{ search: "", replace: " appended" }],
          })
        ).candidate,
      ).toContain(" appended");
    }
  });
  test("terminates a stuck native patch worker while the event loop remains responsive", async () => {
    const worker = new Worker(fixture("while (true) {}"));
    const exited = once(worker, "exit");
    try {
      await once(worker, "online");
      const pool = new PatchPreparationPool({
        timeoutMs: 100,
        workerFactory: () => worker,
      });
      const pending = pool.prepare("aider_block", patchContext());
      expect(await Promise.resolve("responsive")).toBe("responsive");
      await expect(pending).rejects.toMatchObject({ code: "patch_timeout" });
      await exited;
    } finally {
      await worker.terminate();
    }
  });
});

test("isolated AST preparation loads a main-thread registered native grammar", async () => {
  const registryUrl = new URL(
    "../../src/intelligence/parser/registry.ts",
    import.meta.url,
  ).href;
  const strategyUrl = new URL(
    "../../src/patch/strategy/ast.ts",
    import.meta.url,
  ).href;
  const source = `
    import toml from "@ast-grep/lang-toml";
    const {defaultLanguageRegistry} = await import(${JSON.stringify(registryUrl)});
    const {astStrategy} = await import(${JSON.stringify(strategyUrl)});
    const libraryPath = toml.libraryPath;
    const sha256 = new Bun.CryptoHasher("sha256").update(await Bun.file(libraryPath).arrayBuffer()).digest("hex");
    await defaultLanguageRegistry.addDynamic({
      astGrepLanguage:"RegisteredToml",
      dynamicAsset:{libraryPath, sha256, languageSymbol:toml.languageSymbol, expandoChar:toml.expandoChar},
      extensions:[".registeredtoml"],grammarVersion:"fixture-v1",languageId:"registered-toml",
    },{
      callResolution:false,embeddedLanguages:false,exportResolution:false,importResolution:false,
      inheritanceResolution:false,match:true,parse:true,rewrite:true,structuralRead:true,symbolExtraction:false,
    });
    const input = ${JSON.stringify(patchContext())};
    input.language = "registered-toml";
    input.original = "answer = 1";
    input.aiderBlocks = [];
    input.astRules = [{pattern:"answer = 1",fix:"answer = 2",expectedMatches:1}];
    defaultLanguageRegistry.registerDynamicGrammars();
    const {parse} = await import("@ast-grep/napi");
    if (parse("RegisteredToml", "answer = 1").root().text() !== "answer = 1") throw new Error("custom native grammar unavailable");
    if (parse("typescript", "const value = 1;").root().text() !== "const value = 1;") throw new Error("pinned native grammar unavailable");
    const result = await astStrategy.prepare(input);
    const pinned = await astStrategy.prepare({
      ...input,language:"typescript",original:"const value = 1;",
      astRules:[{pattern:"const value = 1",fix:"const value = 2",expectedMatches:1}],
    });
    if (pinned.candidate !== "const value = 2") throw new Error("pinned worker grammar unavailable");
    console.log(JSON.stringify(result));
  `;
  const child = Bun.spawn([process.execPath, "--eval", source], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  expect(JSON.parse(stdout)).toMatchObject({
    candidate: "answer = 2",
    metadata: { strategy: "ast", operations: 1, matches: 1 },
  });
});
