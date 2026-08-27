import { expect, test } from "bun:test";
import {
  type AstBroResult,
  type AstBroShowV2,
  astBroMatchFiles,
  astBroRewrittenFiles,
  parseAstBroJson,
  parseAstBroShowV2,
} from "../src/ast-bro/result";

const result = (value: unknown): AstBroResult => ({
  content: [{ text: JSON.stringify(value), type: "text" }],
});

test("parses ast-bro JSON and extracts unique files", () => {
  expect(
    parseAstBroJson(
      result({ dropped_members: 2, missing_paths: ["missing.ts"], ok: true }),
    ),
  ).toEqual({
    dropped_members: 2,
    missing_paths: ["missing.ts"],
    ok: true,
  });
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

test("accepts only the ast-bro show v2 response contract", () => {
  const payload: AstBroShowV2 = {
    files: [
      {
        language: "markdown",
        matches: [
          {
            end_line: 4,
            kind: "frontmatter",
            qualified_name: "frontmatter",
            source: "---\nname: example\n---",
            start_line: 1,
          },
        ],
        path: "docs/a.md",
      },
    ],
    files_matched: 2,
    files_scanned: 3,
    schema: "ast-bro.show.v2",
    shown: 2,
    symbols: ["frontmatter"],
    total: 4,
    truncated: true,
    unmatched: [],
  };
  expect(parseAstBroShowV2(result(payload))).toEqual(payload);
  expect(() =>
    parseAstBroShowV2(result({ ...payload, schema: "unexpected" })),
  ).toThrow("Invalid ast-bro.show.v2 response");
  expect(() =>
    parseAstBroShowV2(
      result({
        ...payload,
        files: [{ ...payload.files[0], matches: [{ kind: "function" }] }],
      }),
    ),
  ).toThrow("Invalid ast-bro.show.v2 response");
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
