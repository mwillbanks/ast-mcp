import { sha256 } from "../parser/index.ts";
import type { DocumentCapability, DocumentFormat } from "./types.ts";

const formats: readonly DocumentFormat[] = [
  "markdown",
  "mdx",
  "json",
  "jsonc",
  "toml",
  "yaml",
  "xml",
  "html",
  "txt",
  "rtf",
];

const rewriteFormats = new Set<DocumentFormat>(["json", "jsonc"]);

export const DOCUMENT_GOLDEN_PROVENANCE = Object.freeze({
  graphifyRevision: "3f82bf7f837a07fb0f7668fbdbd5662801906942",
  schemaVersion: "ast-mcp.document-goldens.v1",
});

export const documentCapabilities: readonly DocumentCapability[] = formats.map(
  (format) => ({
    format,
    limitations:
      format === "rtf"
        ? [
            "RTF extracted-text offsets are mapped evidence and cannot drive raw-file edits",
          ]
        : format === "txt"
          ? [
              "TXT exposes paragraphs and explicit references without claiming an AST",
            ]
          : format === "json" || format === "jsonc"
            ? []
            : [
                "The bundled parser covers documented structural syntax but not every format extension",
              ],
    parse: format === "json" || format === "jsonc" ? "supported" : "partial",
    provider: format === "rtf" || format === "txt" ? "tokenizer" : "structured",
    rewrite: rewriteFormats.has(format) ? "supported" : "unsupported",
    structuralRead:
      format === "json" || format === "jsonc" ? "supported" : "partial",
  }),
);

export const documentCapabilityFingerprint = sha256(
  JSON.stringify(documentCapabilities),
);
