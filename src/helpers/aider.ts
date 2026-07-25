import { DiffMatchPatch } from "diff-match-patch-ts";
import type { AiderReplacement, SearchReplaceBlock } from "../patch/aider";
import { normalizeNewlines, normalizeWhitespaceLine } from "./string";

export function parseAiderBlocksFromOutput(
  output: string,
): SearchReplaceBlock[] {
  const blocks: SearchReplaceBlock[] = [];
  const lines = output.split(/\r?\n/);
  let filename = "";
  let mode: "outside" | "search" | "replace" = "outside";
  let search: string[] = [];
  let replace: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith("<<<<<<< SEARCH")) {
      const prior = lines[index - 1]?.trim();
      if (prior && !prior.includes("```"))
        filename = prior.replace(/[:`*]/g, "").trim();
      search = [];
      replace = [];
      mode = "search";
    } else if (line.startsWith("=======")) mode = "replace";
    else if (line.startsWith(">>>>>>>")) {
      if (mode !== "replace")
        throw new Error(
          "Malformed Aider block: replacement terminator arrived out of order",
        );
      blocks.push({
        filename,
        replace: replace.join("\n"),
        search: search.join("\n"),
      });
      mode = "outside";
    } else if (mode === "search") search.push(line);
    else if (mode === "replace") replace.push(line);
  }
  if (mode !== "outside")
    throw new Error("Malformed Aider block: unterminated SEARCH/REPLACE block");
  return blocks;
}

function replaceLines(
  contentLines: string[],
  start: number,
  count: number,
  replacement: string,
): string {
  const before = contentLines.slice(0, start).join("\n");
  const after = contentLines.slice(start + count).join("\n");
  return (
    before + (before ? "\n" : "") + replacement + (after ? "\n" : "") + after
  );
}

function exactReplacement(
  content: string,
  search: string,
  replace: string,
): AiderReplacement | undefined {
  const matches = content.split(search).length - 1;
  if (matches > 1) throw new Error("Aider exact match is ambiguous");
  return matches === 1
    ? { content: content.replace(search, () => replace), method: "exact" }
    : undefined;
}

function whitespaceReplacement(
  content: string,
  search: string,
  replace: string,
): AiderReplacement | undefined {
  const contentLines = content.split("\n");
  const searchLines = search.split("\n");
  const starts = contentLines
    .map((_, start) => start)
    .filter((start) =>
      searchLines.every(
        (line, offset) =>
          normalizeWhitespaceLine(contentLines[start + offset] ?? "") ===
          normalizeWhitespaceLine(line),
      ),
    );
  if (starts.length > 1) throw new Error("Aider whitespace match is ambiguous");
  return starts.length === 1
    ? {
        content: replaceLines(
          contentLines,
          starts[0],
          searchLines.length,
          replace,
        ),
        method: "whitespace",
      }
    : undefined;
}

function shiftedSearches(
  contentLines: string[],
  searchLines: string[],
): string[] {
  const sample = searchLines.find((line) => line.trim());
  if (!sample) return [];
  const searchIndent = sample.match(/^[ \t]*/)?.[0] ?? "";
  return contentLines
    .filter((line) => line.trim() === sample.trim())
    .map((line) => line.match(/^[ \t]*/)?.[0] ?? "")
    .filter((indent) => indent !== searchIndent)
    .map((indent) =>
      searchLines
        .map((line) =>
          line.startsWith(searchIndent)
            ? indent + line.slice(searchIndent.length)
            : line,
        )
        .join("\n"),
    );
}

function relativeIndentationReplacement(
  content: string,
  search: string,
  replace: string,
): AiderReplacement | undefined {
  const matches = shiftedSearches(content.split("\n"), search.split("\n"))
    .map((shifted) => ({ index: content.indexOf(shifted), shifted }))
    .filter(
      ({ index, shifted }) =>
        index >= 0 && content.indexOf(shifted, index + 1) < 0,
    );
  if (matches.length > 1)
    throw new Error("Aider indentation match is ambiguous");
  const match = matches[0];
  return match
    ? {
        content:
          content.slice(0, match.index) +
          replace +
          content.slice(match.index + match.shifted.length),
        method: "relative-indentation",
      }
    : undefined;
}

type FuzzyCandidate = { index: number; length: number; ratio: number };

function fuzzyLocations(
  content: string,
  anchor: string,
  matcher: DiffMatchPatch,
): number[] {
  const locations: number[] = [];
  for (
    let location = content.indexOf(anchor);
    location >= 0;
    location = content.indexOf(anchor, location + 1)
  )
    locations.push(location);
  if (locations.length > 0) return locations;
  const fallback = (
    matcher as unknown as {
      match_main(text: string, pattern: string, location: number): number;
    }
  ).match_main(content, anchor, 0);
  return fallback >= 0 ? [fallback] : [];
}

function bestFuzzyCandidate(
  content: string,
  search: string,
  index: number,
  adjustment: number,
  matcher: DiffMatchPatch,
): FuzzyCandidate | undefined {
  const minimum = Math.max(1, search.length - adjustment);
  const maximum = Math.min(content.length - index, search.length + adjustment);
  let best: FuzzyCandidate | undefined;
  for (let length = minimum; length <= maximum; length += 1) {
    const candidate = content.slice(index, index + length);
    const edits = matcher.diff_levenshtein(
      matcher.diff_main(search, candidate),
    );
    const ratio = edits / Math.max(search.length, length);
    if (!best || ratio < best.ratio) best = { index, length, ratio };
    else if (
      ratio === best.ratio &&
      Math.abs(length - search.length) < Math.abs(best.length - search.length)
    )
      best = { index, length, ratio };
  }
  return best;
}

function fuzzyReplacement(
  content: string,
  search: string,
  replace: string,
): AiderReplacement {
  const matcher = new DiffMatchPatch();
  matcher.Match_Distance = Math.max(1000, content.length);
  matcher.Match_Threshold = 0.5;
  const anchor = search.slice(0, matcher.Match_MaxBits);
  const adjustment = Math.min(64, Math.max(4, Math.ceil(search.length * 0.2)));
  const candidates = fuzzyLocations(content, anchor, matcher)
    .map((index) =>
      bestFuzzyCandidate(content, search, index, adjustment, matcher),
    )
    .filter((candidate): candidate is FuzzyCandidate => Boolean(candidate))
    .sort((left, right) => left.ratio - right.ratio);
  const best = candidates[0];
  if (!best || best.ratio > 0.5)
    throw new Error(
      "Aider cascade match failed: SEARCH block was not found with sufficient confidence",
    );
  if (
    candidates[1] &&
    Math.abs(candidates[1].ratio - best.ratio) < Number.EPSILON
  )
    throw new Error("Aider diff-match-patch match is ambiguous");
  return {
    content:
      content.slice(0, best.index) +
      replace +
      content.slice(best.index + best.length),
    method: "diff-match-patch",
  };
}

export function applyAiderBlockCascade(
  fileContent: string,
  searchInput: string,
  replaceInput: string,
): AiderReplacement {
  const content = normalizeNewlines(fileContent);
  const search = normalizeNewlines(searchInput);
  const replace = normalizeNewlines(replaceInput);
  if (!search.trim() && replace.trim())
    return {
      content: content + (content.endsWith("\n") ? "" : "\n") + replace,
      method: "append",
    };
  if (!search)
    throw new Error(
      "Aider SEARCH block must not be empty when replacement is empty",
    );
  return (
    exactReplacement(content, search, replace) ??
    whitespaceReplacement(content, search, replace) ??
    relativeIndentationReplacement(content, search, replace) ??
    fuzzyReplacement(content, search, replace)
  );
}
