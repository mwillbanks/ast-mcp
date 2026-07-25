export function normalizeNewlines(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

export function normalizeWhitespaceLine(value: string): string {
  const indent = value.match(/^[ \t]*/)?.[0] ?? "";
  const body = value
    .slice(indent.length)
    .replace(/[ \t]+/g, " ")
    .trimEnd();
  return `${indent.replace(/\t/g, "  ")}${body}`;
}

type Quote = '"' | "'" | "`";

class CompactSourceScanner {
  private escaped = false;
  private index = 0;
  private quote: Quote | undefined;

  constructor(private readonly source: string) {}

  read(): string {
    let output = "";
    while (this.index < this.source.length) output += this.readCharacter();
    return output;
  }

  private readCharacter(): string {
    const character = this.source[this.index] ?? "";
    if (this.quote) return this.readQuoted(character);
    const quote = this.asQuote(character);
    if (quote) return this.beginQuote(quote);
    if (character === "/" && this.source[this.index + 1] === "/") {
      this.skipLineComment();
      return "";
    }
    if (character === "/" && this.source[this.index + 1] === "*") {
      this.skipBlockComment();
      return "";
    }
    this.index += 1;
    return /\s/.test(character) ? "" : character.toLowerCase();
  }

  private readQuoted(character: string): string {
    this.index += 1;
    if (this.escaped) this.escaped = false;
    else if (character === "\\") this.escaped = true;
    else if (character === this.quote) this.quote = undefined;
    return character.toLowerCase();
  }

  private asQuote(character: string): Quote | undefined {
    return character === '"' || character === "'" || character === "`"
      ? character
      : undefined;
  }

  private beginQuote(quote: Quote): string {
    this.quote = quote;
    this.index += 1;
    return quote;
  }

  private skipLineComment(): void {
    const newline = this.source.indexOf("\n", this.index + 2);
    this.index = newline < 0 ? this.source.length : newline + 1;
  }

  private skipBlockComment(): void {
    const terminator = this.source.indexOf("*/", this.index + 2);
    this.index = terminator < 0 ? this.source.length : terminator + 2;
  }
}

export function compactCallSyntax(source: string): string {
  return new CompactSourceScanner(source)
    .read()
    .replaceAll("tools?.", "tools.");
}
export function containsToolInvocation(
  source: string,
  tools: Iterable<string>,
): boolean {
  const value = compactCallSyntax(source);
  return [...tools].some((tool) =>
    [
      `tools.${tool}(`,
      `tools.${tool}?.(`,
      `tools["${tool}"](`,
      `tools["${tool}"]?.(`,
      `tools['${tool}'](`,
      `tools['${tool}']?.(`,
    ].some((syntax) => value.includes(syntax)),
  );
}
