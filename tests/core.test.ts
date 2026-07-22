import { describe, expect, spyOn, test } from "bun:test";
import path from "node:path";
import { applyAiderBlock, parseAiderBlocks } from "../src/patch/aider";
import { detectAstLanguage } from "../src/patch/languages";
import { sha256 } from "../src/runtime/hash";
import {
  primaryRoot,
  resolveWritablePath,
  rootsForDisplay,
} from "../src/runtime/paths";

import { runCommandInput } from "../src/runtime/process-input";

describe("Aider-style fallback", () => {
  test("uses exact matching", () => {
    expect(applyAiderBlock("one\ntwo\nthree", "two", "changed")).toEqual({
      content: "one\nchanged\nthree",
      method: "exact",
    });
  });
  test("normalizes whitespace", () => {
    const result = applyAiderBlock(
      "before\nconst   x = 1\nafter",
      "const x = 1",
      "const x = 2",
    );
    expect(result.method).toBe("whitespace");
    expect(result.content).toContain("const x = 2");
  });
  test("rejects empty and ambiguous blocks", () => {
    expect(applyAiderBlock("x", "", "y")).toEqual({
      content: "x\ny",
      method: "append",
    });
    expect(() => applyAiderBlock("x x", "x", "y")).toThrow("ambiguous");
    expect(() => applyAiderBlock("x", "", "")).toThrow("must not be empty");
    expect(() =>
      parseAiderBlocks("<<<<<<< SEARCH\nx\n>>>>>>> CONTENT"),
    ).toThrow("out of order");
  });
  test("rejects low-confidence fuzzy matches", () => {
    expect(() =>
      applyAiderBlock("alpha\nbeta", "completely different", "x"),
    ).toThrow("failed");
  });
});

test("detects AST languages and hashes deterministically", async () => {
  expect(detectAstLanguage("thing.tsx")).toBe("tsx");
  expect(detectAstLanguage("thing.txt")).toBeUndefined();
  expect(sha256("abc")).toBe(
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  expect(rootsForDisplay()).toContain(process.cwd());
  expect(await primaryRoot()).toBe(process.cwd());
});
test("falls back to the lexical working directory when it cannot be resolved", async () => {
  const cwd = spyOn(process, "cwd").mockReturnValue("/tmp/ast-mcp-missing-cwd");
  try {
    expect(await primaryRoot()).toBe("/tmp/ast-mcp-missing-cwd");
  } finally {
    cwd.mockRestore();
  }
});

test("reports formatter subprocess failures", async () => {
  await expect(runCommandInput("/usr/bin/false", [], "input")).rejects.toThrow(
    "failed",
  );
});
test("tolerates a missing configured root when another root allows the path", async () => {
  const previous = process.env.AST_MCP_ROOTS;
  process.env.AST_MCP_ROOTS = [
    path.join(process.cwd(), "missing-root"),
    process.cwd(),
  ].join(path.delimiter);
  try {
    expect(await resolveWritablePath(path.resolve("README.md"))).toBe(
      path.resolve("README.md"),
    );
  } finally {
    if (previous === undefined) delete process.env.AST_MCP_ROOTS;
    else process.env.AST_MCP_ROOTS = previous;
  }
});
