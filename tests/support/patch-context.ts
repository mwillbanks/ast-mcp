import type { PatchStrategyContext } from "../../src/patch/strategy";

export function patchContext(): PatchStrategyContext {
  return {
    aiderBlocks: [{ search: "const value = 1;", replace: "const value = 2;" }],
    astRules: [],
    original: "const value = 1;",
    filePath: "/fixture.ts",
    mode: 0o644,
    language: "typescript",
    capabilities: {
      effective: {
        aiderMatchers: ["exact"],
        patch: ["ast", "aider_block"],
        read: ["text", "ast"],
      },
      intrinsic: {
        patch: ["ast", "aider_block"],
        read: ["text", "ast"],
        search: ["ast"],
      },
      generation: 1,
      filePath: "/fixture.ts",
      kind: "source",
      language: "typescript",
      parseErrorCount: 0,
      parseStatus: "parseable",
      size: 16,
    },
  };
}
