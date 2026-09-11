import { analyzeDocument } from "./core.ts";
import type { DocumentRewriteRequest } from "./types.ts";

export async function rewriteDocumentInMemory(
  request: DocumentRewriteRequest,
): Promise<{
  facts: Awaited<ReturnType<typeof analyzeDocument>>;
  source: string;
}> {
  if (!request.facts.rewriteSupported) {
    throw new TypeError(
      "Structural rewriting is unavailable for this document",
    );
  }
  if (
    request.facts.sourceDigest !==
    (
      await analyzeDocument({
        encoding: request.facts.encoding,
        format: request.facts.format,
        source: request.source,
      })
    ).sourceDigest
  ) {
    throw new TypeError("Document source does not match analyzed facts");
  }
  const evidenceNode = request.facts.nodes.find(
    (node) => node.id === request.nodeId,
  );
  if (
    !evidenceNode ||
    evidenceNode.range.startByte !== request.range.startByte ||
    evidenceNode.range.endByte !== request.range.endByte ||
    evidenceNode.range.startCoordinate.utf16Offset !==
      request.range.startCoordinate.utf16Offset ||
    evidenceNode.range.endCoordinate.utf16Offset !==
      request.range.endCoordinate.utf16Offset
  ) {
    throw new TypeError(
      "Document rewrite must target one analyzed structural node",
    );
  }
  const start = request.range.startCoordinate.utf16Offset;
  const end = request.range.endCoordinate.utf16Offset;
  if (request.source.slice(start, end) !== request.expectedText) {
    throw new TypeError("Document rewrite evidence does not match source");
  }
  const source =
    request.source.slice(0, start) +
    request.replacement +
    request.source.slice(end);
  const facts = await analyzeDocument({
    encoding: request.facts.encoding,
    format: request.facts.format,
    source,
  });
  if (facts.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    throw new TypeError("Document rewrite would produce malformed content");
  }
  return { facts, source };
}
