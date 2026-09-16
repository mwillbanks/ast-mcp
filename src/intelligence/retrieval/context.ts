import type { ContextAssembly, RetrievalCandidate } from "./types.ts";

export function compareCandidate(
  left: RetrievalCandidate,
  right: RetrievalCandidate,
): number {
  return (
    right.score - left.score ||
    left.path.localeCompare(right.path) ||
    left.range.startByte - right.range.startByte ||
    left.entityId.localeCompare(right.entityId)
  );
}

export function assembleContext(
  candidates: readonly RetrievalCandidate[],
  budget: { maxBytes: number; maxItems: number },
): ContextAssembly {
  if (!Number.isSafeInteger(budget.maxBytes) || budget.maxBytes < 1)
    throw new TypeError("context_max_bytes_invalid");
  if (!Number.isSafeInteger(budget.maxItems) || budget.maxItems < 1)
    throw new TypeError("context_max_items_invalid");
  const items: ContextAssembly["items"][number][] = [];
  const fragments: string[] = [];
  let consumedBytes = 0;
  let truncated = false;
  const seen = new Set<string>();
  for (const candidate of [...candidates].sort(compareCandidate)) {
    const occurrence = JSON.stringify([
      candidate.entityId,
      candidate.path,
      candidate.range,
      candidate.text,
    ]);
    if (seen.has(occurrence)) continue;
    seen.add(occurrence);
    if (items.length >= budget.maxItems) {
      truncated = true;
      break;
    }
    const header =
      `### ${candidate.path}:${candidate.range.start.line + 1}` +
      ` [${candidate.entityId}]\n`;
    const separator = items.length === 0 ? "" : "\n";
    const rendered = `${separator}${header}${candidate.text}\n`;
    const bytes = Buffer.byteLength(rendered);
    if (consumedBytes + bytes > budget.maxBytes) {
      truncated = true;
      continue;
    }
    items.push({
      entityId: candidate.entityId,
      path: candidate.path,
      range: candidate.range,
      score: candidate.score,
      text: candidate.text,
    });
    fragments.push(rendered);
    consumedBytes += bytes;
  }
  const rendered = fragments.join("");
  return {
    consumedBytes: Buffer.byteLength(rendered),
    items,
    rendered,
    truncated,
  };
}
