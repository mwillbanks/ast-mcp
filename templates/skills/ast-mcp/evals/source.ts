export interface QuoteState {
  escaped: boolean;
  quote: string;
}

export function advanceQuote(
  character: string,
  quote: string,
  escaped: boolean,
): QuoteState {
  if (escaped) return { escaped: false, quote };
  if (character === "\\") return { escaped: true, quote };
  return { escaped: false, quote: character === quote ? "" : quote };
}

type SourceState = "block" | "code" | "line" | "quoted";

class ExecutableSourceScanner {
  private escaped = false;
  private index = 0;
  private masked = "";
  private quote = "";
  private state: SourceState = "code";

  constructor(private readonly source: string) {}

  read() {
    while (this.index < this.source.length) {
      this.readCharacter();
      this.index += 1;
    }
    return this.masked;
  }

  private readCharacter() {
    const character = this.source[this.index] ?? "";
    const next = this.source[this.index + 1] ?? "";
    if (this.state === "code") return this.readCode(character, next);
    if (this.state === "line") return this.readLine(character);
    if (this.state === "block") return this.readBlock(character, next);
    return this.readQuoted(character);
  }

  private readCode(character: string, next: string) {
    if (character === "/" && next === "/") return this.beginComment("line");
    if (character === "/" && next === "*") return this.beginComment("block");
    if ("\"'`".includes(character)) return this.beginQuote(character);
    this.masked += character;
  }

  private beginComment(state: "block" | "line") {
    this.masked += "  ";
    this.index += 1;
    this.state = state;
  }

  private beginQuote(quote: string) {
    this.masked += " ";
    this.quote = quote;
    this.state = "quoted";
  }

  private readLine(character: string) {
    this.masked += character === "\n" ? "\n" : " ";
    if (character === "\n") this.state = "code";
  }

  private readBlock(character: string, next: string) {
    this.masked += character === "\n" ? "\n" : " ";
    if (character !== "*" || next !== "/") return;
    this.masked += " ";
    this.index += 1;
    this.state = "code";
  }

  private readQuoted(character: string) {
    this.masked += character === "\n" ? "\n" : " ";
    const result = advanceQuote(character, this.quote, this.escaped);
    this.escaped = result.escaped;
    this.quote = result.quote;
    if (!this.quote) this.state = "code";
  }
}

export function executableSource(source: string) {
  return new ExecutableSourceScanner(source).read();
}

export function isInsidePromiseAll(source: string, position: number) {
  const executable = executableSource(source);
  const promise = executable.lastIndexOf("Promise.all", position);
  if (promise < 0) return false;
  const open = executable.indexOf("(", promise);
  if (open < 0 || open >= position) return false;
  let depth = 1;
  for (let index = open + 1; index < position; index += 1) {
    if (executable[index] === "(") depth += 1;
    else if (executable[index] === ")") depth -= 1;
  }
  return depth > 0;
}

class ParenthesisScanner {
  private depth = 1;
  private escaped = false;
  private quote = "";

  constructor(
    private readonly source: string,
    private index: number,
  ) {}

  read() {
    for (; this.index < this.source.length; this.index += 1) {
      if (this.readCharacter()) return this.index;
    }
    return -1;
  }

  private readCharacter() {
    const character = this.source[this.index] ?? "";
    if (this.quote) return this.readQuoted(character);
    if ("\"'`".includes(character)) {
      this.quote = character;
      return false;
    }
    if (character === "(") this.depth += 1;
    else if (character === ")") this.depth -= 1;
    return this.depth === 0;
  }

  private readQuoted(character: string) {
    const state = advanceQuote(character, this.quote, this.escaped);
    this.quote = state.quote;
    this.escaped = state.escaped;
    return false;
  }
}

function closingParenthesis(source: string, open: number) {
  return new ParenthesisScanner(source, open + 1).read();
}

export interface SourceInvocation {
  concurrent: boolean;
  input: string;
  tool: string;
}

export function extractExecInvocations(source: string): SourceInvocation[] {
  const invocations: SourceInvocation[] = [];
  const expression = /tools\.mcp__ast_mcp__(\w+)\s*\(/g;
  for (const match of executableSource(source).matchAll(expression)) {
    const open = (match.index ?? 0) + match[0].length - 1;
    const close = closingParenthesis(source, open);
    if (close < 0) continue;
    invocations.push({
      concurrent: isInsidePromiseAll(source, match.index ?? 0),
      input: source.slice(open + 1, close).trim(),
      tool: match[1] ?? "",
    });
  }
  return invocations;
}
