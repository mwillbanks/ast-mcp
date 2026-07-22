import { DiffMatchPatch } from "diff-match-patch-ts";

export interface SearchReplaceBlock {
  filename: string;
  replace: string;
  search: string;
}
export interface AiderReplacement {
  content: string;
  method:
    | "append"
    | "exact"
    | "whitespace"
    | "relative-indentation"
    | "diff-match-patch";
}

export function parseAiderBlocks(output: string): SearchReplaceBlock[] {
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

export function applyAiderBlock(
  fileContent: string,
  searchInput: string,
  replaceInput: string,
): AiderReplacement {
  const content = fileContent.replace(/\r\n/g, "\n");
  const search = searchInput.replace(/\r\n/g, "\n");
  const replace = replaceInput.replace(/\r\n/g, "\n");
  if (!search.trim() && replace.trim())
    return {
      content: content + (content.endsWith("\n") ? "" : "\n") + replace,
      method: "append",
    };
  if (!search)
    throw new Error(
      "Aider SEARCH block must not be empty when replacement is empty",
    );

  const exact = content.split(search).length - 1;
  if (exact === 1)
    return { content: content.replace(search, () => replace), method: "exact" };
  if (exact > 1) throw new Error("Aider exact match is ambiguous");

  const normalize = (value: string) => {
    const indent = value.match(/^[ \t]*/)?.[0] ?? "";
    return (
      indent.replace(/\t/g, "  ") +
      value
        .slice(indent.length)
        .replace(/[ \t]+/g, " ")
        .trimEnd()
    );
  };
  const contentLines = content.split("\n");
  const searchLines = search.split("\n");
  const whitespaceMatches: number[] = [];
  for (
    let start = 0;
    start <= contentLines.length - searchLines.length;
    start += 1
  ) {
    if (
      searchLines.every(
        (line, offset) =>
          normalize(contentLines[start + offset]) === normalize(line),
      )
    )
      whitespaceMatches.push(start);
  }
  if (whitespaceMatches.length === 1)
    return {
      content: replaceLines(
        contentLines,
        whitespaceMatches[0],
        searchLines.length,
        replace,
      ),
      method: "whitespace",
    };
  if (whitespaceMatches.length > 1)
    throw new Error("Aider whitespace match is ambiguous");

  const sample = searchLines.find((line) => line.trim());
  if (sample) {
    const searchIndent = sample.match(/^[ \t]*/)?.[0] ?? "";
    const shiftedMatches: Array<{ index: number; length: number }> = [];
    for (const line of contentLines) {
      if (line.trim() !== sample.trim()) continue;
      const fileIndent = line.match(/^[ \t]*/)?.[0] ?? "";
      if (fileIndent === searchIndent) continue;
      const shifted = searchLines
        .map((item) =>
          item.startsWith(searchIndent)
            ? fileIndent + item.slice(searchIndent.length)
            : item,
        )
        .join("\n");
      const index = content.indexOf(shifted);
      if (index >= 0 && content.indexOf(shifted, index + 1) < 0)
        shiftedMatches.push({ index, length: shifted.length });
    }
    if (shiftedMatches.length === 1) {
      const match = shiftedMatches[0];
      return {
        content:
          content.slice(0, match.index) +
          replace +
          content.slice(match.index + match.length),
        method: "relative-indentation",
      };
    }
    if (shiftedMatches.length > 1)
      throw new Error("Aider indentation match is ambiguous");
  }

  // Tier 4 (git cherry-pick) is deliberately omitted: this engine never spawns git or Python.
  const dmp = new DiffMatchPatch();
  dmp.Match_Distance = Math.max(1000, content.length);
  dmp.Match_Threshold = 0.5;
  const anchor = search.slice(0, dmp.Match_MaxBits);
  const locations: number[] = [];
  for (
    let location = content.indexOf(anchor);
    location >= 0;
    location = content.indexOf(anchor, location + 1)
  )
    locations.push(location);
  if (!locations.length) {
    const matcher = dmp as unknown as {
      match_main(text: string, pattern: string, location: number): number;
    };
    const location = matcher.match_main(content, anchor, 0);
    if (location >= 0) locations.push(location);
  }
  const adjustment = Math.min(64, Math.max(4, Math.ceil(search.length * 0.2)));
  const candidates: Array<{ index: number; length: number; ratio: number }> =
    [];
  for (const index of locations) {
    const minimum = Math.max(1, search.length - adjustment);
    const maximum = Math.min(
      content.length - index,
      search.length + adjustment,
    );
    let best: { index: number; length: number; ratio: number } | undefined;
    for (let length = minimum; length <= maximum; length += 1) {
      const candidate = content.slice(index, index + length);
      const edits = dmp.diff_levenshtein(dmp.diff_main(search, candidate));
      const ratio = edits / Math.max(search.length, length);
      if (
        !best ||
        ratio < best.ratio ||
        (ratio === best.ratio &&
          Math.abs(length - search.length) <
            Math.abs(best.length - search.length))
      )
        best = { index, length, ratio };
    }
    if (best) candidates.push(best);
  }
  candidates.sort((left, right) => left.ratio - right.ratio);
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
