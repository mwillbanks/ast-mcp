export interface ProseIssue {
  file: string;
  line: number;
  message: string;
}

const imperative =
  /^(add|apply|avoid|call|check|choose|confirm|configure|continue|copy|create|delete|do|ensure|follow|install|keep|load|never|obtain|pass|prefer|preserve|read|remove|replace|restart|rerun|resolve|run|set|stop|treat|use|verify|write)\b/i;
const passive =
  /\b(?:am|are|be|been|being|is|was|were)\s+(?:\w+ly\s+)?\w+(?:ed|en)\b/i;

function words(value: string): number {
  return value.match(/[A-Za-z0-9][A-Za-z0-9'/-]*/g)?.length ?? 0;
}

export function checkMarkdown(file: string, source: string): ProseIssue[] {
  if (file.includes("/evals/")) return [];
  const issues: ProseIssue[] = [];
  let fence = false;
  let frontmatter = source.startsWith("---\n");
  for (const [index, raw] of source.split("\n").entries()) {
    const line = raw.trim();
    if (line.startsWith(String.fromCharCode(96).repeat(3))) {
      fence = !fence;
      continue;
    }
    if (frontmatter && line === "---") {
      if (index > 0) frontmatter = false;
      continue;
    }
    if (
      fence ||
      frontmatter ||
      !line ||
      line.startsWith("#") ||
      line.startsWith("|") ||
      line.startsWith("<!--") ||
      /^\s*https?:\/\//.test(line) ||
      line.startsWith(String.fromCharCode(96))
    )
      continue;
    const text = line.replace(/^[-*]\s+/, "").replace(/^\d+[.)]\s+/, "");
    const procedural = imperative.test(text) || /^[-*\d]/.test(line);
    for (const sentence of text.split(/(?<=[.!?])\s+/)) {
      const count = words(sentence);
      const limit = procedural ? 20 : 25;
      if (count > limit)
        issues.push({
          file,
          line: index + 1,
          message:
            (procedural ? "Procedural" : "Descriptive") +
            " sentence has " +
            count +
            " words; limit is " +
            limit +
            ".",
        });
      if (procedural && passive.test(sentence))
        issues.push({
          file,
          line: index + 1,
          message: "Procedural sentence uses passive voice.",
        });
    }
  }
  return issues;
}
