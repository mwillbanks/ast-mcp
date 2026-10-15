import { describe, expect, test } from "bun:test";

import { normalizeBasePath } from "../src/lib/base-path";

describe("deployment base paths", () => {
  test("normalizes root and project paths", () => {
    expect(normalizeBasePath("/")).toBe("/");
    expect(normalizeBasePath("/ast-mcp")).toBe("/ast-mcp/");
    expect(normalizeBasePath("/ast-mcp/")).toBe("/ast-mcp/");
  });
  test("rejects external or ambiguous paths", () => {
    for (const path of [
      "https://example.com/",
      "//example.com/",
      "ast-mcp",
      "/docs?x",
      "/docs#x",
      "/docs\\x",
    ]) {
      expect(() => normalizeBasePath(path)).toThrow();
    }
  });
});
