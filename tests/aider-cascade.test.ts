import { describe, expect, test } from "bun:test";
import { applyAiderBlock, parseAiderBlocks } from "../src/patch/aider";

describe("native TypeScript Aider cascade", () => {
  test("parses fenced SEARCH/REPLACE blocks", () => {
    expect(
      parseAiderBlocks(
        "src/a.ts\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> CONTENT",
      ),
    ).toEqual([{ filename: "src/a.ts", replace: "new", search: "old" }]);
    expect(() => parseAiderBlocks("<<<<<<< SEARCH\nold")).toThrow(
      "unterminated",
    );
  });
  test("repairs uniform indentation shifts", () => {
    const result = applyAiderBlock(
      "function x() {\n  one()\n  two()\n}",
      "    one()\n    two()",
      "  changed()",
    );
    expect(result.method).toBe("relative-indentation");
    expect(result.content).toContain("changed()");
  });
  test("uses diff-match-patch as the final native tier", () => {
    const result = applyAiderBlock(
      "const importantValue = 1;\n",
      "const importantValu = 1;",
      "const importantValue = 2;",
    );
    expect(result.method).toBe("diff-match-patch");
    expect(result.content).toContain("importantValue = 2");
  });
  test("fuzzy matching supports SEARCH blocks longer than DMP Match_MaxBits", () => {
    const prefix = "header line\n".repeat(20);
    const result = applyAiderBlock(
      `${prefix}const longTargetValueWithManyCharacters = 1;\n`,
      "const longTargetValueWithManyCharacter = 1;",
      "const longTargetValueWithManyCharacters = 2;",
    );
    expect(result.method).toBe("diff-match-patch");
    expect(result.content).toContain("ManyCharacters = 2");
  });
  test("rejects equally plausible fuzzy locations", () => {
    const prefix = "const sharedPrefixWithMoreThanThirtyTwoCharacters";
    expect(() =>
      applyAiderBlock(
        `${prefix} = 1;\n${prefix} = 2;\n`,
        `${prefix} = 3;`,
        `${prefix} = 4;`,
      ),
    ).toThrow("ambiguous");
  });
  test("preserves dollar sequences in exact replacements", () => {
    const replacement = ["$", "$", "$", "ARGS"].join("");
    const result = applyAiderBlock("old", "old", replacement);
    expect(result.method).toBe("exact");
    expect(result.content).toBe(replacement);
  });
});
