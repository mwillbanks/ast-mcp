import path from "node:path";

export const DOCUMENT_RESULT_MAX_BYTES = 256 * 1024;

export interface DocumentSelection {
  selector: string;
  value: unknown;
}

export function parseStructuredDocument(
  filePath: string,
  source: string,
): unknown {
  switch (path.extname(filePath).toLowerCase()) {
    case ".json":
      return JSON.parse(source);
    case ".jsonc":
      return Bun.JSONC.parse(source);
    case ".toml":
      return Bun.TOML.parse(source);
    case ".yaml":
    case ".yml":
      return Bun.YAML.parse(source);
    default:
      throw Object.assign(
        new Error(
          "Structured document inspection supports JSON, JSONC, TOML, and YAML files",
        ),
        { code: "document_format_unsupported", retryable: false },
      );
  }
}

export function selectDocumentValue(
  document: unknown,
  selector: string,
): unknown {
  if (selector === "") return document;
  if (!selector.startsWith("/"))
    throw Object.assign(new Error(`Invalid RFC 6901 selector: ${selector}`), {
      code: "invalid_document_selector",
      retryable: true,
    });
  return selector
    .slice(1)
    .split("/")
    .map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce<unknown>((value, token) => {
      if (Array.isArray(value)) return value[Number(token)];
      if (value && typeof value === "object")
        return (value as Record<string, unknown>)[token];
      return undefined;
    }, document);
}

export function selectDocumentValues(
  filePath: string,
  source: string,
  selectors: string[],
): DocumentSelection[] {
  const document = parseStructuredDocument(filePath, source);
  const values = selectors.map((selector) => ({
    selector,
    value: selectDocumentValue(document, selector),
  }));
  if (Buffer.byteLength(JSON.stringify(values)) > DOCUMENT_RESULT_MAX_BYTES)
    throw Object.assign(
      new Error(
        "Structured document result exceeds the 256 KiB limit; use narrower selectors or text mode",
      ),
      {
        code: "document_result_too_large",
        retryable: true,
        suggestedNextCall: "file_read",
      },
    );
  return values;
}
