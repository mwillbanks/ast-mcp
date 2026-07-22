import { expect, test } from "bun:test";
import {
  type AstBroResult,
  astBroMatchFiles,
  astBroRewrittenFiles,
  parseAstBroJson,
} from "../src/ast-bro/result";

const result = (value: unknown): AstBroResult => ({
  content: [{ text: JSON.stringify(value), type: "text" }],
});

test("parses ast-bro JSON and extracts unique files", () => {
  expect(parseAstBroJson(result({ ok: true }))).toEqual({ ok: true });
  expect(
    astBroMatchFiles(
      result({ matches: [{ file: "/a.ts" }, { file: "/a.ts" }, {}] }),
    ),
  ).toEqual(["/a.ts"]);
  expect(
    astBroRewrittenFiles(
      result({
        files: [
          { file: "/a.ts", status: "rewritten" },
          { file: "/a.ts", status: "rewritten" },
          { file: "/b.ts", status: "diff" },
        ],
      }),
    ),
  ).toEqual(["/a.ts"]);
});

test("rejects error, empty, and invalid ast-bro responses", () => {
  expect(() => parseAstBroJson({ content: [], isError: true })).toThrow(
    "ast-bro MCP call failed",
  );
  expect(() => parseAstBroJson({ content: [] })).toThrow("no JSON text");
  expect(() =>
    parseAstBroJson({ content: [{ text: "not-json", type: "text" }] }),
  ).toThrow("Invalid ast-bro MCP JSON");
});
