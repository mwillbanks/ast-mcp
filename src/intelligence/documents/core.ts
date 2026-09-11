/* biome-ignore-all lint/style/noNonNullAssertion: parser indices and source-map segments are bounds-checked */
import {
  EmbeddedSourceMap,
  parseSource,
  SourceCoordinateIndex,
  type SyntaxFacts,
  sha256,
} from "../parser/index.ts";
import type {
  DocumentAnalyzeRequest,
  DocumentDiagnostic,
  DocumentFacts,
  DocumentFormat,
  DocumentNode,
  DocumentReference,
  DocumentReferenceKind,
  EmbeddedCodeRegion,
  RtfTextSegment,
} from "./types.ts";

interface RawNode {
  end: number;
  kind: string;
  name?: string;
  parent?: number;
  start: number;
  value?: string;
}

interface Parsed {
  diagnostics?: DocumentDiagnostic[];
  embedded?: Array<{ end: number; languageId: string; start: number }>;
  nodes: RawNode[];
  references?: Array<{
    end: number;
    kind: DocumentReferenceKind;
    start: number;
    target: string;
  }>;
  rtfText?: string;
  rtfTextSegments?: RtfTextSegment[];
}

const encoder = new TextEncoder();

function lines(
  source: string,
): Array<{ end: number; start: number; text: string }> {
  const result: Array<{ end: number; start: number; text: string }> = [];
  let start = 0;
  for (let index = 0; index <= source.length; index += 1) {
    if (index === source.length || source[index] === "\n") {
      const end =
        index > start && source[index - 1] === "\r" ? index - 1 : index;
      result.push({ end, start, text: source.slice(start, end) });
      start = index + 1;
    }
  }
  return result;
}

interface RawRange {
  end: number;
  start: number;
}

function includedRanges(
  length: number,
  excluded: readonly RawRange[],
): RawRange[] {
  const ranges: RawRange[] = [];
  let cursor = 0;
  for (const range of [...excluded].sort(
    (left, right) => left.start - right.start,
  )) {
    const start = Math.max(cursor, Math.min(length, range.start));
    const end = Math.max(start, Math.min(length, range.end));
    if (cursor < start) ranges.push({ end: start, start: cursor });
    cursor = Math.max(cursor, end);
  }
  if (cursor < length) ranges.push({ end: length, start: cursor });
  return ranges;
}

function commentRanges(source: string): RawRange[] {
  const ranges: RawRange[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    const start = source.indexOf("<!--", cursor);
    if (start < 0) break;
    const close = source.indexOf("-->", start + 4);
    const end = close < 0 ? source.length : close + 3;
    ranges.push({ end, start });
    cursor = end;
  }
  return ranges;
}

function rawMarkupRanges(source: string): RawRange[] {
  const lower = source.toLowerCase();
  const ranges: RawRange[] = [];
  for (const tag of ["script", "style"]) {
    let cursor = 0;
    while (cursor < source.length) {
      const start = lower.indexOf(`<${tag}`, cursor);
      if (start < 0) break;
      const openEnd = lower.indexOf(">", start + tag.length + 1);
      if (openEnd < 0) {
        ranges.push({ end: source.length, start });
        break;
      }
      const close = lower.indexOf(`</${tag}>`, openEnd + 1);
      const end = close < 0 ? source.length : close + tag.length + 3;
      ranges.push({ end, start });
      cursor = end;
    }
  }
  return ranges;
}

function mdxExpressionRanges(source: string): RawRange[] {
  const ranges: RawRange[] = [];
  let blockComment = false;
  let depth = 0;
  let escaped = false;
  let lineComment = false;
  let quote = 0;
  let start = 0;
  for (let cursor = 0; cursor < source.length; cursor += 1) {
    const code = source.charCodeAt(cursor);
    const next = source.charCodeAt(cursor + 1);
    if (lineComment) {
      if (code === 10 || code === 13) lineComment = false;
      continue;
    }
    if (blockComment) {
      if (code === 42 && next === 47) {
        blockComment = false;
        cursor += 1;
      }
      continue;
    }
    if (quote !== 0) {
      if (escaped) escaped = false;
      else if (code === 92) escaped = true;
      else if (code === quote) quote = 0;
      continue;
    }
    if (depth > 0 && code === 47 && next === 47) {
      lineComment = true;
      cursor += 1;
      continue;
    }
    if (depth > 0 && code === 47 && next === 42) {
      blockComment = true;
      cursor += 1;
      continue;
    }
    if (depth > 0 && (code === 34 || code === 39 || code === 96)) {
      quote = code;
      continue;
    }
    if (code === 123) {
      if (depth === 0) start = cursor;
      depth += 1;
    } else if (code === 125 && depth > 0) {
      depth -= 1;
      if (depth === 0) ranges.push({ end: cursor + 1, start });
    }
  }
  if (depth > 0) ranges.push({ end: source.length, start });
  return ranges;
}

function referenceScan(
  source: string,
  ranges: readonly RawRange[] = [{ end: source.length, start: 0 }],
): Parsed["references"] {
  const refs: NonNullable<Parsed["references"]> = [];
  const add = (
    kind: DocumentReferenceKind,
    start: number,
    end: number,
    target: string,
  ) => {
    if (target) refs.push({ end, kind, start, target });
  };
  for (const range of ranges) {
    for (let i = range.start; i < range.end; i += 1) {
      if (source.startsWith("[[", i)) {
        const close = source.indexOf("]]", i + 2);
        if (close >= 0 && close + 2 <= range.end) {
          add("wikilink", i, close + 2, source.slice(i + 2, close).trim());
          i = close + 1;
          continue;
        }
      }
      if (source[i] === "[") {
        const labelEnd = source.indexOf("](", i + 1);
        const close =
          labelEnd >= 0 && labelEnd < range.end
            ? source.indexOf(")", labelEnd + 2)
            : -1;
        if (close >= 0 && close < range.end) {
          add("link", labelEnd + 2, close, source.slice(labelEnd + 2, close));
          i = close;
          continue;
        }
      }
      if (source[i] === "`") {
        const close = source.indexOf("`", i + 1);
        if (close > i + 1 && close < range.end) {
          add("code", i + 1, close, source.slice(i + 1, close));
          i = close;
          continue;
        }
      }
      const rest = source.slice(i, range.end);
      const adr = /^ADR[- ]?(\d+)/iu.exec(rest);
      const rfc = /^RFC[- ]?(\d+)/iu.exec(rest);
      const pkg =
        /^(?:package:)?(@[a-z0-9._-]+\/[a-z0-9._-]+|[a-z][a-z0-9._-]*\/[a-z0-9._-]+)/iu.exec(
          rest,
        );
      const match = adr ?? rfc ?? pkg;
      if (match) {
        const kind: DocumentReferenceKind = adr
          ? "adr"
          : rfc
            ? "rfc"
            : "package";
        add(kind, i, i + match[0].length, match[1] ?? match[0]);
        i += match[0].length - 1;
      }
    }
  }
  return refs;
}

function markdown(source: string, mdx = false): Parsed {
  const rows = lines(source);
  const nodes: RawNode[] = [];
  const embedded: NonNullable<Parsed["embedded"]> = [];
  const excluded: RawRange[] = [
    ...commentRanges(source),
    ...rawMarkupRanges(source),
    ...(mdx ? mdxExpressionRanges(source) : []),
  ];
  const hasFrontmatter = rows[0]?.text.trim() === "---";
  let frontmatterEnd = -1;
  if (hasFrontmatter) {
    const close = rows.slice(1).find((row) => row.text.trim() === "---");
    if (close) {
      frontmatterEnd = close.end;
      excluded.push({ end: close.end, start: 0 });
      nodes.push({ end: close.end, kind: "frontmatter", start: 0 });
      for (const row of rows) {
        if (row.start <= 0 || row.start >= close.start) continue;
        const colon = row.text.indexOf(":");
        if (colon > 0)
          nodes.push({
            end: row.end,
            kind: "frontmatter-entry",
            name: row.text.slice(0, colon).trim(),
            parent: 0,
            start: row.start,
            value: row.text.slice(colon + 1).trim(),
          });
      }
    } else {
      excluded.push({ end: source.length, start: 0 });
    }
  }
  let fence: {
    delimiter: string;
    languageId: string;
    rawStart: number;
    start: number;
  } | null = null;
  const initiallyExcluded = (offset: number) =>
    excluded.some((range) => range.start <= offset && offset < range.end);
  for (const row of rows) {
    const trimmed = row.text.trimStart();
    const delimiter = trimmed.startsWith("```")
      ? "```"
      : trimmed.startsWith("~~~")
        ? "~~~"
        : null;
    if (!delimiter) continue;
    if (!fence) {
      if (initiallyExcluded(row.start)) continue;
      fence = {
        delimiter,
        languageId: trimmed.slice(3).trim().split(/[ \t]/u)[0] || "text",
        rawStart: row.start,
        start: row.end + (source[row.end] === "\r" ? 2 : 1),
      };
    } else if (fence.delimiter === delimiter) {
      embedded.push({
        end: row.start,
        languageId: fence.languageId,
        start: fence.start,
      });
      nodes.push({
        end: row.end,
        kind: "fenced-code",
        name: fence.languageId,
        start: fence.start,
      });
      excluded.push({ end: row.end, start: fence.rawStart });
      fence = null;
    }
  }
  if (fence) {
    nodes.push({
      end: source.length,
      kind: "malformed-fence",
      name: fence.languageId,
      start: fence.start,
    });
    excluded.push({ end: source.length, start: fence.rawStart });
  }
  const visible = (offset: number) =>
    !excluded.some((range) => range.start <= offset && offset < range.end);
  const headings: Array<{ index: number; level: number }> = [];
  for (const row of rows) {
    if (!visible(row.start)) continue;
    let level = 0;
    while (row.text[level] === "#" && level < 6) level += 1;
    if (level > 0 && row.text[level] === " ") {
      headings.push({ index: nodes.length, level });
      nodes.push({
        end: source.length,
        kind: "section",
        name: row.text.slice(level + 1).trim(),
        start: row.start,
      });
    }
  }
  for (let index = 0; index < headings.length; index += 1) {
    const current = headings[index]!;
    const next = headings
      .slice(index + 1)
      .find((item) => item.level <= current.level);
    nodes[current.index]!.end = next ? nodes[next.index]?.start : source.length;
  }
  for (let i = 0; i + 1 < rows.length; i += 1) {
    const row = rows[i]!;
    const separator = rows[i + 1]!;
    if (!visible(row.start) || !visible(separator.start)) continue;
    const separatorCells = separator.text
      .split("|")
      .map((cell) => cell.trim())
      .filter(Boolean);
    if (
      row.text.includes("|") &&
      separatorCells.length > 0 &&
      separatorCells.every((cell) => {
        const value = cell.trim();
        return (
          value.length >= 3 &&
          [...value].every(
            (character) => character === "-" || character === ":",
          )
        );
      })
    ) {
      let end = separator.end;
      for (
        let j = i + 2;
        j < rows.length &&
        rows[j]?.text.includes("|") &&
        visible(rows[j]!.start);
        j += 1
      )
        end = rows[j]?.end;
      nodes.push({ end, kind: "table", start: row.start });
    }
  }
  const diagnostics: DocumentDiagnostic[] = fence
    ? [
        {
          code: "malformed-document",
          message: "Unclosed fenced code block",
          range: new SourceCoordinateIndex(source).range(
            fence.start,
            source.length,
          ),
          severity: "error",
        },
      ]
    : [];
  if (hasFrontmatter && frontmatterEnd < 0)
    diagnostics.push({
      code: "malformed-document",
      message: "Unclosed frontmatter",
      range: new SourceCoordinateIndex(source).range(0, source.length),
      severity: "error",
    });
  return {
    diagnostics,
    embedded,
    nodes,
    references: referenceScan(source, includedRanges(source.length, excluded)),
  };
}

class JsonParser {
  readonly nodes: RawNode[] = [];
  readonly diagnostics: DocumentDiagnostic[] = [];
  index = 0;
  constructor(
    readonly source: string,
    readonly comments: boolean,
  ) {}
  skip(): void {
    while (this.index < this.source.length) {
      const char = this.source[this.index];
      if (/\s/u.test(char ?? "")) {
        this.index += 1;
        continue;
      }
      if (this.comments && this.source.startsWith("//", this.index)) {
        const end = this.source.indexOf("\n", this.index + 2);
        this.index = end < 0 ? this.source.length : end + 1;
        continue;
      }
      if (this.comments && this.source.startsWith("/*", this.index)) {
        const end = this.source.indexOf("*/", this.index + 2);
        this.index = end < 0 ? this.source.length : end + 2;
        continue;
      }
      break;
    }
  }
  string(): { end: number; start: number; value: string } | null {
    this.skip();
    if (this.source[this.index] !== '"') return null;
    const start = this.index++;
    let value = "";
    while (this.index < this.source.length) {
      const char = this.source[this.index++]!;
      if (char === '"') return { end: this.index, start, value };
      if (char === "\\" && this.index < this.source.length) {
        const escaped = this.source[this.index++]!;
        value += escaped === "n" ? "\n" : escaped;
      } else value += char;
    }
    return null;
  }
  value(parent?: number, name?: string): number | null {
    this.skip();
    const start = this.index;
    const char = this.source[this.index];
    if (char === "{" || char === "[") {
      const kind = char === "{" ? "object" : "array";
      const nodeIndex =
        this.nodes.push({ end: start, kind, name, parent, start }) - 1;
      this.index += 1;
      this.skip();
      while (
        this.index < this.source.length &&
        this.source[this.index] !== (char === "{" ? "}" : "]")
      ) {
        if (char === "{") {
          const key = this.string();
          if (!key) break;
          this.skip();
          if (this.source[this.index] !== ":") break;
          this.index += 1;
          const child = this.value(nodeIndex, key.value);
          if (child === null) break;
        } else if (this.value(nodeIndex) === null) break;
        this.skip();
        if (this.source[this.index] === ",") {
          this.index += 1;
          this.skip();
        } else break;
      }
      if (this.source[this.index] === (char === "{" ? "}" : "]"))
        this.index += 1;
      else
        this.diagnostics.push({
          code: "malformed-document",
          message: `Unclosed JSON ${kind}`,
          range: new SourceCoordinateIndex(this.source).range(
            start,
            this.source.length,
          ),
          severity: "error",
        });
      this.nodes[nodeIndex]!.end = this.index;
      return nodeIndex;
    }
    const text = this.string();
    if (text)
      return (
        this.nodes.push({
          end: text.end,
          kind: "value",
          name,
          parent,
          start: text.start,
          value: text.value,
        }) - 1
      );
    while (
      this.index < this.source.length &&
      !/[\s,}\]]/u.test(this.source[this.index]!)
    )
      this.index += 1;
    if (this.index === start) return null;
    const value = this.source.slice(start, this.index);
    if (
      !["true", "false", "null"].includes(value) &&
      !/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u.test(value)
    ) {
      this.diagnostics.push({
        code: "malformed-document",
        message: "Invalid JSON literal",
        range: new SourceCoordinateIndex(this.source).range(start, this.index),
        severity: "error",
      });
    }
    return (
      this.nodes.push({
        end: this.index,
        kind: "value",
        name,
        parent,
        start,
        value,
      }) - 1
    );
  }
}

function json(source: string, comments: boolean): Parsed {
  const parser = new JsonParser(source, comments);
  parser.value();
  parser.skip();
  if (parser.index < source.length)
    parser.diagnostics.push({
      code: "malformed-document",
      message: "Unexpected JSON content",
      range: new SourceCoordinateIndex(source).range(
        parser.index,
        source.length,
      ),
      severity: "error",
    });
  return {
    diagnostics: parser.diagnostics,
    nodes: parser.nodes,
    references: [],
  };
}

function lineStructured(source: string, format: "toml" | "yaml"): Parsed {
  const nodes: RawNode[] = [];
  for (const row of lines(source)) {
    const text = row.text.trim();
    if (!text || text.startsWith("#")) continue;
    if (format === "toml" && text.startsWith("[") && text.endsWith("]")) {
      nodes.push({
        end: row.end,
        kind: "section",
        name: text.slice(1, -1).trim(),
        start: row.start,
      });
      continue;
    }
    const separator = format === "toml" ? text.indexOf("=") : text.indexOf(":");
    if (separator >= 0)
      nodes.push({
        end: row.end,
        kind:
          format === "yaml" && text.startsWith("-")
            ? "sequence-entry"
            : "property",
        name: text.slice(text.startsWith("-") ? 1 : 0, separator).trim(),
        start: row.start,
        value: text.slice(separator + 1).trim(),
      });
  }
  return { nodes, references: [] };
}

function markupTagEnd(source: string, start: number): number {
  let escaped = false;
  let quote = 0;
  for (let cursor = start; cursor < source.length; cursor += 1) {
    const code = source.charCodeAt(cursor);
    if (quote !== 0) {
      if (escaped) escaped = false;
      else if (code === 92) escaped = true;
      else if (code === quote) quote = 0;
    } else if (code === 34 || code === 39) quote = code;
    else if (code === 62) return cursor;
  }
  return -1;
}

function markupAttributeReferences(
  source: string,
  start: number,
  end: number,
): NonNullable<Parsed["references"]> {
  const references: NonNullable<Parsed["references"]> = [];
  let cursor = start;
  while (cursor < end) {
    while (cursor < end && /\s/u.test(source[cursor] ?? "")) cursor += 1;
    const nameStart = cursor;
    while (cursor < end && !/[\s=/>]/u.test(source[cursor] ?? "")) cursor += 1;
    const name = source.slice(nameStart, cursor).toLowerCase();
    while (cursor < end && /\s/u.test(source[cursor] ?? "")) cursor += 1;
    if (source[cursor] !== "=") {
      if (cursor === nameStart) cursor += 1;
      continue;
    }
    cursor += 1;
    while (cursor < end && /\s/u.test(source[cursor] ?? "")) cursor += 1;
    const quote =
      source[cursor] === '"' || source[cursor] === "'" ? source[cursor] : null;
    if (quote) cursor += 1;
    const valueStart = cursor;
    while (
      cursor < end &&
      (quote ? source[cursor] !== quote : !/[\s>]/u.test(source[cursor] ?? ""))
    )
      cursor += 1;
    const valueEnd = cursor;
    if ((name === "href" || name === "src") && valueEnd > valueStart)
      references.push({
        end: valueEnd,
        kind: "link",
        start: valueStart,
        target: source.slice(valueStart, valueEnd),
      });
    if (quote && source[cursor] === quote) cursor += 1;
  }
  return references;
}

function markup(source: string, html: boolean): Parsed {
  const nodes: RawNode[] = [];
  const references: NonNullable<Parsed["references"]> = [];
  const diagnostics: DocumentDiagnostic[] = [];
  const stack: number[] = [];
  const coordinates = new SourceCoordinateIndex(source);
  const scanText = (start: number, end: number) => {
    const parentName = nodes[stack.at(-1) ?? -1]?.name?.toLowerCase();
    if (end > start && parentName !== "script" && parentName !== "style") {
      references.push(...(referenceScan(source, [{ end, start }]) ?? []));
    }
  };
  let index = 0;
  while (index < source.length) {
    const open = source.indexOf("<", index);
    if (open < 0) {
      scanText(index, source.length);
      break;
    }
    scanText(index, open);
    if (source.startsWith("<!--", open)) {
      const close = source.indexOf("-->", open + 4);
      const end = close < 0 ? source.length : close + 3;
      nodes.push({ end, kind: "comment", parent: stack.at(-1), start: open });
      if (close < 0)
        diagnostics.push({
          code: "malformed-document",
          message: "Unclosed markup comment",
          range: coordinates.range(open, source.length),
          severity: "error",
        });
      index = end;
      continue;
    }
    const close = markupTagEnd(source, open + 1);
    if (close < 0) {
      diagnostics.push({
        code: "malformed-document",
        message: "Unclosed markup tag",
        range: coordinates.range(open, source.length),
        severity: "error",
      });
      break;
    }
    const token = source.slice(open + 1, close).trim();
    if (token.startsWith("/")) {
      const closeName = token.slice(1).trim().split(/\s/u)[0] ?? "";
      const parent = stack.at(-1);
      const expected = parent === undefined ? undefined : nodes[parent]?.name;
      const matches = html
        ? expected?.toLowerCase() === closeName.toLowerCase()
        : expected === closeName;
      if (parent !== undefined && matches) {
        stack.pop();
        nodes[parent]!.end = close + 1;
      } else {
        diagnostics.push({
          code: "malformed-document",
          message: `Mismatched closing element </${closeName}>`,
          range: coordinates.range(open, close + 1),
          severity: "error",
        });
      }
    } else if (!token.startsWith("!") && !token.startsWith("?")) {
      const name = token.split(/[\s/>]/u)[0] ?? "";
      references.push(...markupAttributeReferences(source, open + 1, close));
      const nodeIndex =
        nodes.push({
          end: close + 1,
          kind: "element",
          name,
          parent: stack.at(-1),
          start: open,
        }) - 1;
      if (
        !token.endsWith("/") &&
        !(
          html &&
          ["br", "img", "meta", "link", "input", "hr"].includes(
            name.toLowerCase(),
          )
        )
      )
        stack.push(nodeIndex);
    }
    index = close + 1;
  }
  diagnostics.push(
    ...stack.map((nodeIndex) => ({
      code: "malformed-document" as const,
      message: `Unclosed element <${nodes[nodeIndex]?.name}>`,
      range: coordinates.range(nodes[nodeIndex]?.start, source.length),
      severity: "error" as const,
    })),
  );
  return { diagnostics, nodes, references };
}

function text(source: string): Parsed {
  const nodes: RawNode[] = [];
  let start: number | null = null;
  const rows = lines(source);
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]!;
    if (row.text.trim()) start ??= row.start;
    if (start !== null && (!row.text.trim() || i === rows.length - 1)) {
      nodes.push({
        end: row.text.trim() ? row.end : row.start,
        kind: "paragraph",
        start,
      });
      start = null;
    }
  }
  return { nodes, references: referenceScan(source) };
}

function rtf(source: string): Parsed {
  const coordinates = new SourceCoordinateIndex(source);
  const nodes: RawNode[] = [];
  const segments: RtfTextSegment[] = [];
  const stack: number[] = [];
  let extracted = "";
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    if (char === "{") {
      const node =
        nodes.push({
          end: source.length,
          kind: "control-group",
          parent: stack.at(-1),
          start: index,
        }) - 1;
      stack.push(node);
      index += 1;
      continue;
    }
    if (char === "}") {
      const node = stack.pop();
      if (node !== undefined) nodes[node]!.end = index + 1;
      index += 1;
      continue;
    }
    if (char === "\\") {
      const start = index++;
      if (
        source[index] === "'" &&
        /^[0-9a-f]{2}$/iu.test(source.slice(index + 1, index + 3))
      ) {
        const value = String.fromCharCode(
          Number.parseInt(source.slice(index + 1, index + 3), 16),
        );
        const extractedStart = extracted.length;
        extracted += value;
        segments.push({
          extractedEnd: extracted.length,
          extractedStart,
          sourceRange: coordinates.range(start, index + 3),
          text: value,
        });
        index += 3;
        continue;
      }
      if (["{", "}", "\\"].includes(source[index] ?? "")) {
        const value = source[index] ?? "";
        const extractedStart = extracted.length;
        extracted += value;
        index += 1;
        segments.push({
          extractedEnd: extracted.length,
          extractedStart,
          sourceRange: coordinates.range(start, index),
          text: value,
        });
        continue;
      }
      const wordStart = index;
      while (/[a-z]/iu.test(source[index] ?? "")) index += 1;
      const word = source.slice(wordStart, index);
      const parameterStart = index;
      while (/[0-9-]/u.test(source[index] ?? "")) index += 1;
      const parameter = source.slice(parameterStart, index);
      if (source[index] === " ") index += 1;
      if (word === "u" && parameter) {
        const signed = Number.parseInt(parameter, 10);
        const value = String.fromCharCode(
          signed < 0 ? signed + 65_536 : signed,
        );
        if (source[index] && !["{", "}", "\\"].includes(source[index]!))
          index += 1;
        const extractedStart = extracted.length;
        extracted += value;
        segments.push({
          extractedEnd: extracted.length,
          extractedStart,
          sourceRange: coordinates.range(start, index),
          text: value,
        });
      }
      continue;
    }
    let end = index + 1;
    while (end < source.length && !["{", "}", "\\"].includes(source[end]!))
      end += 1;
    const value = source
      .slice(index, end)
      .replaceAll("\r", "")
      .replaceAll("\n", "");
    if (value) {
      const extractedStart = extracted.length;
      extracted += value;
      segments.push({
        extractedEnd: extracted.length,
        extractedStart,
        sourceRange: coordinates.range(index, end),
        text: value,
      });
    }
    index = end;
  }
  const references = (referenceScan(extracted) ?? []).flatMap((reference) => {
    const startSegment = segments.find(
      (segment) =>
        segment.extractedStart <= reference.start &&
        segment.extractedEnd > reference.start,
    );
    const endSegment = [...segments]
      .reverse()
      .find(
        (segment) =>
          segment.extractedStart < reference.end &&
          segment.extractedEnd >= reference.end,
      );
    if (!startSegment || !endSegment) return [];
    const startDelta = reference.start - startSegment.extractedStart;
    const endDelta = reference.end - endSegment.extractedStart;
    const startRaw = source.slice(
      startSegment.sourceRange.startCoordinate.utf16Offset,
      startSegment.sourceRange.endCoordinate.utf16Offset,
    );
    const endRaw = source.slice(
      endSegment.sourceRange.startCoordinate.utf16Offset,
      endSegment.sourceRange.endCoordinate.utf16Offset,
    );
    return [
      {
        ...reference,
        end:
          endRaw === endSegment.text
            ? endSegment.sourceRange.startCoordinate.utf16Offset + endDelta
            : endSegment.sourceRange.endCoordinate.utf16Offset,
        start:
          startRaw === startSegment.text
            ? startSegment.sourceRange.startCoordinate.utf16Offset + startDelta
            : startSegment.sourceRange.startCoordinate.utf16Offset,
      },
    ];
  });
  return {
    diagnostics: stack.map((nodeIndex) => ({
      code: "malformed-document",
      message: "Unclosed RTF control group",
      range: coordinates.range(nodes[nodeIndex]?.start, source.length),
      severity: "error",
    })),
    nodes,
    references,
    rtfText: extracted,
    rtfTextSegments: segments,
  };
}

async function embeddedFacts(
  request: DocumentAnalyzeRequest,
  languageId: string,
  source: string,
): Promise<SyntaxFacts | null> {
  if (request.parseEmbedded) return request.parseEmbedded(languageId, source);
  const normalized = (
    {
      javascript: "javascript",
      js: "javascript",
      jsx: "tsx",
      ts: "typescript",
      tsx: "tsx",
      typescript: "typescript",
    } as Record<string, string>
  )[languageId.toLowerCase()];
  if (!normalized) return null;
  return parseSource({ languageId: normalized, source });
}

function rawParse(format: DocumentFormat, source: string): Parsed {
  if (format === "markdown" || format === "mdx")
    return markdown(source, format === "mdx");
  if (format === "json" || format === "jsonc")
    return json(source, format === "jsonc");
  if (format === "toml" || format === "yaml")
    return lineStructured(source, format);
  if (format === "xml" || format === "html")
    return markup(source, format === "html");
  if (format === "rtf") return rtf(source);
  return text(source);
}

function decodeDocumentSource(request: DocumentAnalyzeRequest): {
  encoding: "utf-8";
  source: string;
} {
  const normalizedEncoding = (request.encoding ?? "utf-8")
    .toLowerCase()
    .replaceAll("_", "-");
  if (normalizedEncoding !== "utf-8" && normalizedEncoding !== "utf8") {
    throw new TypeError(
      `Unsupported document encoding '${request.encoding}'; only UTF-8 is accepted`,
    );
  }
  if (typeof request.source === "string") {
    return { encoding: "utf-8", source: request.source };
  }
  return {
    encoding: "utf-8",
    source: new TextDecoder("utf-8", { fatal: true }).decode(request.source),
  };
}

export async function analyzeDocument(
  request: DocumentAnalyzeRequest,
): Promise<DocumentFacts> {
  const { encoding, source } = decodeDocumentSource(request);
  const sourceDigest = sha256(source);
  const coordinates = new SourceCoordinateIndex(source);
  const parsed = rawParse(request.format, source);
  const nodes: DocumentNode[] = parsed.nodes.map((node, index) => ({
    childIds: parsed.nodes.flatMap((candidate, _child) =>
      candidate.parent === index
        ? [
            sha256(
              JSON.stringify([
                sourceDigest,
                candidate.kind,
                candidate.start,
                candidate.end,
              ]),
            ),
          ]
        : [],
    ),
    id: sha256(JSON.stringify([sourceDigest, node.kind, node.start, node.end])),
    kind: node.kind,
    name: node.name ?? null,
    parentId:
      node.parent === undefined
        ? null
        : sha256(
            JSON.stringify([
              sourceDigest,
              parsed.nodes[node.parent]?.kind,
              parsed.nodes[node.parent]?.start,
              parsed.nodes[node.parent]?.end,
            ]),
          ),
    range: coordinates.range(node.start, node.end),
    value: node.value ?? null,
  }));
  const embeddedCode: EmbeddedCodeRegion[] = [];
  for (const [ordinal, region] of (parsed.embedded ?? []).entries()) {
    const embeddedSource = source.slice(region.start, region.end);
    const facts = await embeddedFacts(
      request,
      region.languageId,
      embeddedSource,
    );
    if (!facts) {
      const documentDiagnostics = parsed.diagnostics ?? [];
      documentDiagnostics.push({
        code: "unsupported-embedded-language",
        message: `No embedded parser for ${region.languageId}`,
        range: coordinates.range(region.start, region.end),
        severity: "warning",
      });
      parsed.diagnostics = documentDiagnostics;
    }
    if (facts) {
      const map = new EmbeddedSourceMap(source, embeddedSource, [
        {
          embeddedEnd: embeddedSource.length,
          embeddedStart: 0,
          hostEnd: region.end,
          hostStart: region.start,
        },
      ]);
      facts.nodes = facts.nodes.map((node) => ({
        ...node,
        range: map.embeddedToHost(node.range)!,
      }));
      facts.symbols = facts.symbols.map((symbol) => ({
        ...symbol,
        declarationRange: map.embeddedToHost(symbol.declarationRange)!,
        range: map.embeddedToHost(symbol.range)!,
      }));
      facts.imports = facts.imports.map((item) => ({
        ...item,
        range: map.embeddedToHost(item.range)!,
      }));
      facts.exports = facts.exports.map((item) => ({
        ...item,
        range: map.embeddedToHost(item.range)!,
      }));
      facts.calls = facts.calls.map((item) => ({
        ...item,
        range: map.embeddedToHost(item.range)!,
      }));
      facts.references = facts.references.map((item) => ({
        ...item,
        range: map.embeddedToHost(item.range)!,
      }));
      facts.inheritance = facts.inheritance.map((item) => ({
        ...item,
        range: map.embeddedToHost(item.range)!,
      }));
      facts.implementations = facts.implementations.map((item) => ({
        ...item,
        range: map.embeddedToHost(item.range)!,
      }));
      facts.diagnostics = facts.diagnostics.map((item) => ({
        ...item,
        range: map.embeddedToHost(item.range)!,
      }));
    }
    embeddedCode.push({
      facts,
      hostRange: coordinates.range(region.start, region.end),
      languageId: region.languageId,
      ordinal,
      source: embeddedSource,
    });
  }
  const resolveCodeSymbol = (
    reference: NonNullable<Parsed["references"]>[number],
  ): string | null => {
    const candidates = embeddedCode.flatMap((region) =>
      (region.facts?.symbols ?? [])
        .filter((symbol) => symbol.name === reference.target)
        .map((symbol) => ({ region, symbol })),
    );
    if (candidates.length === 1) return candidates[0]?.symbol.id ?? null;
    const section = nodes
      .filter(
        (node) =>
          node.kind === "section" &&
          node.range.startCoordinate.utf16Offset <= reference.start &&
          node.range.endCoordinate.utf16Offset >= reference.end,
      )
      .sort(
        (left, right) =>
          left.range.endByte -
          left.range.startByte -
          (right.range.endByte - right.range.startByte),
      )[0];
    if (!section) return null;
    const scoped = candidates.filter(
      ({ region }) =>
        region.hostRange.startByte >= section.range.startByte &&
        region.hostRange.endByte <= section.range.endByte,
    );
    return scoped.length === 1 ? (scoped[0]?.symbol.id ?? null) : null;
  };
  const references: DocumentReference[] = (parsed.references ?? []).map(
    (reference) => ({
      id: sha256(
        JSON.stringify([
          sourceDigest,
          reference.kind,
          reference.target,
          reference.start,
          reference.end,
        ]),
      ),
      kind: reference.kind,
      range: coordinates.range(reference.start, reference.end),
      resolvedSymbolId:
        reference.kind === "code" ? resolveCodeSymbol(reference) : null,
      target: reference.target,
    }),
  );
  return {
    diagnostics: parsed.diagnostics ?? [],
    embeddedCode,
    encoding,
    format: request.format,
    nodes,
    references,
    rewriteSupported: request.format === "json" || request.format === "jsonc",
    rtfText: parsed.rtfText ?? null,
    rtfTextSegments: parsed.rtfTextSegments ?? [],
    schemaVersion: "ast-mcp.document-facts.v1",
    sourceByteLength: encoder.encode(source).byteLength,
    sourceDigest,
    syntaxFactsArtifactId: sha256(
      JSON.stringify([
        sourceDigest,
        request.format,
        encoding,
        nodes.map((node) => node.id),
        references.map((reference) => reference.id),
        embeddedCode.map(
          (region) => region.facts?.syntaxFactsArtifactId ?? null,
        ),
      ]),
    ),
  };
}
