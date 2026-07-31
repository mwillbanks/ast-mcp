import { expect, test } from "bun:test";
import { languageForExtension } from "../src/patch/languages";
import {
  DOCUMENT_RESULT_MAX_BYTES,
  parseStructuredDocument,
  selectDocumentValue,
  selectDocumentValues,
} from "../src/runtime/document-inspection";

test("structured document inspection supports every advertised format", () => {
  expect(parseStructuredDocument("value.json", '{"value":1}')).toEqual({
    value: 1,
  });
  expect(
    parseStructuredDocument("value.jsonc", '{/* note */"value":2}'),
  ).toEqual({ value: 2 });
  expect(parseStructuredDocument("value.toml", "value = 3\n")).toEqual({
    value: 3,
  });
  expect(parseStructuredDocument("value.yaml", "value: 4\n")).toEqual({
    value: 4,
  });
  expect(parseStructuredDocument("value.yml", "value: 5\n")).toEqual({
    value: 5,
  });
  expect(() => parseStructuredDocument("value.txt", "value")).toThrow(
    "supports JSON, JSONC, TOML, and YAML",
  );
});

test("RFC 6901 selection handles roots, arrays, and escaped tokens", () => {
  const document = { "a/b": { "m~n": ["zero", "one"] } };
  expect(selectDocumentValue(document, "")).toBe(document);
  expect(selectDocumentValue(document, "/a~1b/m~0n/1")).toBe("one");
  expect(selectDocumentValue(document, "/missing/value")).toBeUndefined();
  expect(() => selectDocumentValue(document, "not-a-pointer")).toThrow(
    "Invalid RFC 6901 selector",
  );
});

test("structured selections are bounded", () => {
  expect(selectDocumentValues("value.json", '{"value":1}', ["/value"])).toEqual(
    [{ selector: "/value", value: 1 }],
  );
  const source = JSON.stringify({
    value: "x".repeat(DOCUMENT_RESULT_MAX_BYTES),
  });
  expect(() => selectDocumentValues("value.json", source, [""])).toThrow(
    "exceeds the 256 KiB limit",
  );
});

test("language lookup normalizes extensions", () => {
  expect(languageForExtension(".TS")).toBe("typescript");
  expect(languageForExtension(".unknown")).toBeUndefined();
});
