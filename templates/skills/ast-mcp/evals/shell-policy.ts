import { type Command, parse } from "unbash";

const mutators = new Set([
  "apply_patch",
  "patch",
  "truncate",
  "touch",
  "rm",
  "unlink",
  "mv",
  "rename",
  "ed",
  "set-content",
  "add-content",
  "clear-content",
  "out-file",
  "remove-item",
  "move-item",
  "new-item",
]);

const wrappers = new Set([
  "env",
  "command",
  "builtin",
  "exec",
  "sudo",
  "doas",
  "nice",
  "nohup",
  "stdbuf",
  "busybox",
  "timeout",
  "chrt",
]);

export type ShellDialect = "cmd" | "posix" | "powershell";

function commandName(value = "") {
  return (
    value
      .split(/[\\/]/)
      .at(-1)
      ?.toLowerCase()
      .replace(/\.(?:bat|cmd|exe|ps1)$/i, "") ?? ""
  );
}

function executable(command: Command) {
  const values = [command.name, ...command.suffix].map(
    (word) => word?.value ?? "",
  );
  let index = 0;
  while (wrappers.has(commandName(values[index]))) {
    const wrapper = commandName(values[index++]);
    while (values[index]?.startsWith("-")) {
      const option = values[index++];
      if (
        (wrapper === "env" &&
          ["-u", "-C", "--unset", "--chdir"].includes(option)) ||
        ((wrapper === "sudo" || wrapper === "doas") &&
          [
            "-u",
            "-g",
            "-p",
            "-r",
            "-t",
            "-C",
            "-D",
            "-R",
            "-T",
            "--user",
            "--group",
            "--prompt",
            "--role",
            "--type",
            "--close-from",
            "--chdir",
            "--chroot",
            "--command-timeout",
          ].includes(option)) ||
        (wrapper === "nice" && ["-n", "--adjustment"].includes(option))
      )
        index++;
    }
    if (wrapper === "env")
      while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(values[index] ?? "")) index++;
    if ((wrapper === "timeout" || wrapper === "chrt") && index < values.length)
      index++;
  }
  return {
    args: values.slice(index + 1),
    name: commandName(values[index]),
  };
}

function inlineMutates(source: string) {
  const value = source.toLowerCase();
  if (
    [
      "writefile(",
      "writefilesync(",
      "appendfile(",
      "appendfilesync(",
      "bun.write(",
      "deno.write",
      ".write_text(",
      ".write_bytes(",
      "unlink(",
      "unlinksync(",
      "rmsync(",
      "truncate(",
      "truncatesync(",
      "mkdir(",
      "rename(",
      "renamesync(",
    ].some((marker) => value.includes(marker))
  )
    return true;
  const opens = value.includes("open(") || value.includes("opensync(");
  return (
    opens &&
    ([', "w', ", 'w", ', "a', ", 'a", ', "x', ", 'x", ', "r+', ", 'r+"].some(
      (marker) => value.includes(marker),
    ) ||
      /\bmode\s*=\s*["'](?:[wax]|r\+)/.test(value))
  );
}

function payloadAfter(
  args: string[],
  flags: string[],
  caseInsensitive = false,
) {
  const expected = caseInsensitive
    ? flags.map((flag) => flag.toLowerCase())
    : flags;
  const index = args.findIndex((arg) => {
    const candidate = caseInsensitive ? arg.toLowerCase() : arg;
    return (
      expected.includes(candidate) ||
      expected.some((flag) => candidate.startsWith(`${flag}=`))
    );
  });
  if (index < 0) return undefined;
  const argument = args[index];
  const separator = argument.indexOf("=");
  return separator >= 0 ? argument.slice(separator + 1) : args[index + 1];
}

const cmdMutators = new Set([
  "attrib",
  "copy",
  "del",
  "erase",
  "fsutil",
  "md",
  "mkdir",
  "mklink",
  "move",
  "rd",
  "ren",
  "rename",
  "replace",
  "rmdir",
  "robocopy",
  "sc",
  "xcopy",
]);

const powershellMutators = new Set([
  "add-content",
  "clear-item",
  "clear-itemproperty",
  "clear-content",
  "copy",
  "copy-item",
  "cp",
  "cpi",
  "del",
  "erase",
  "md",
  "mi",
  "mkdir",
  "move",
  "move-item",
  "mv",
  "new-item",
  "ni",
  "out-file",
  "rd",
  "remove-item",
  "remove-itemproperty",
  "ren",
  "rename",
  "rename-item",
  "rename-itemproperty",
  "ri",
  "rm",
  "rni",
  "rmdir",
  "sc",
  "set-acl",
  "set-content",
  "set-item",
  "set-itemproperty",
  "si",
  "sp",
  "tee",
  "tee-object",
  "xcopy",
]);

interface WindowsSegment {
  redirected: boolean;
  source: string;
}

function windowsSegments(source: string): WindowsSegment[] {
  const segments: WindowsSegment[] = [];
  let current = "";
  let quote = "";
  let redirected = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] as string;
    if (quote) {
      current += character;
      if ((character === "`" || character === "^") && index + 1 < source.length)
        current += source[++index];
      else if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }
    if ((character === "`" || character === "^") && index + 1 < source.length) {
      current += character + source[++index];
      continue;
    }
    if (character === ">") {
      if (
        !/^>?\s*(?:\$null|nul|&\d)(?=$|\s|[;&|])/i.test(source.slice(index + 1))
      )
        redirected = true;
      current += character;
      continue;
    }
    if (/[;&|{}\r\n]/.test(character)) {
      if (current.trim()) segments.push({ redirected, source: current });
      current = "";
      redirected = false;
      continue;
    }
    current += character;
  }
  if (current.trim()) segments.push({ redirected, source: current });
  return segments;
}

function windowsTokens(source: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote = "";
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] as string;
    if (quote) {
      if ((character === "`" || character === "^") && index + 1 < source.length)
        current += source[++index];
      else if (character === quote) quote = "";
      else current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if ((character === "`" || character === "^") && index + 1 < source.length) {
      current += source[++index];
      continue;
    }
    if (/\s/.test(character)) {
      if (current) tokens.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  if (current) tokens.push(current);
  return tokens;
}

function windowsSegmentMutates(
  source: string,
  dialect: Exclude<ShellDialect, "posix">,
): boolean {
  const tokens = windowsTokens(source);
  while (/^(?:&|@|\()$/.test(tokens[0] ?? "")) tokens.shift();
  const name = commandName(tokens[0]);
  if (!name) return false;
  const mutators = dialect === "powershell" ? powershellMutators : cmdMutators;
  if (mutators.has(name)) return true;
  if (name === "call")
    return windowsSegmentMutates(tokens.slice(1).join(" "), "cmd");
  if (name === "invoke-expression" || name === "iex")
    return windowsShellMutates(tokens.slice(1).join(" "), "powershell");
  if (name === "powershell" || name === "pwsh") {
    if (
      tokens
        .slice(1)
        .some((token) =>
          /^-(?:e|ec|en|enc|enco|encod|encode|encodedcommand)$/i.test(token),
        )
    )
      return true;
    const payload = payloadAfter(tokens.slice(1), ["-c", "-command"], true);
    return payload ? windowsShellMutates(payload, "powershell") : false;
  }
  if (name === "cmd") {
    const payload = payloadAfter(tokens.slice(1), ["/c", "/k"], true);
    return payload ? windowsShellMutates(payload, "cmd") : false;
  }
  if (name === "if" || name === "for")
    return tokens.slice(1).some((token, index) => {
      const candidate = commandName(token.replace(/^[@&(]+/, ""));
      return (
        mutators.has(candidate) ||
        (["do", "else"].includes(candidate) &&
          windowsSegmentMutates(tokens.slice(index + 2).join(" "), dialect))
      );
    });
  return false;
}

function windowsShellMutates(
  source: string,
  dialect: Exclude<ShellDialect, "posix">,
): boolean {
  if (
    /\[(?:system\.)?io\.(?:file|directory)\]\s*::\s*(?:appendalltext|copy|create|createdirectory|createhardlink|createsymboliclink|delete|move|openwrite|replace|setattributes|writeallbytes|writealllines|writealltext)\s*\(/i.test(
      source,
    )
  )
    return true;
  return windowsSegments(source).some(
    (segment) =>
      segment.redirected || windowsSegmentMutates(segment.source, dialect),
  );
}

function commandMutates(command: Command) {
  const original = commandName(command.name?.value);
  const originalArgs = command.suffix.map((word) => word.value);
  if (
    original === "command" &&
    originalArgs.some((arg) => arg === "-v" || arg === "-V")
  )
    return false;
  if (original === "env") {
    const dispatched = payloadAfter(originalArgs, ["-S", "--split-string"]);
    if (dispatched) return shellMutates(dispatched);
  }
  const { args, name } = executable(command);
  if (name === "git") return false;
  if (mutators.has(name)) return true;
  if (name === "sed")
    return args.some(
      (arg) =>
        arg === "--in-place" ||
        arg.startsWith("--in-place=") ||
        /^-[^-]*i/.test(arg),
    );
  if (name === "ast-grep")
    return (
      args.some((arg) => arg === "--rewrite" || arg.startsWith("--rewrite=")) &&
      args.some((arg) => arg === "-U" || arg === "--update-all")
    );
  if (name === "find") {
    if (args.includes("-delete")) return true;
    const action = args.findIndex((arg) =>
      ["-exec", "-execdir", "-ok", "-okdir"].includes(arg),
    );
    return action >= 0 && shellMutates(args.slice(action + 1).join(" "));
  }
  if (name === "xargs") return shellMutates(args.join(" "));
  if (name === "eval") return shellMutates(args.join(" "));
  if (
    ["bash", "sh", "zsh", "dash", "ksh", "fish", "pwsh", "powershell"].includes(
      name,
    )
  ) {
    const grouped = args.findIndex((arg) => /^-[A-Za-z]*c[A-Za-z]*$/.test(arg));
    const payload =
      payloadAfter(args, ["-c", "--command", "-command"], true) ??
      (grouped >= 0 ? args[grouped + 1] : undefined);
    return payload
      ? shellMutates(
          payload,
          name === "pwsh" || name === "powershell" ? "powershell" : "posix",
        )
      : false;
  }
  if (/^(?:node|python\d*(?:\.\d+)*|ruby|perl|php|bun|deno)$/.test(name)) {
    const flags = name.startsWith("python") ? ["-c"] : ["-e", "--eval"];
    const payload = payloadAfter(args, flags);
    return payload ? inlineMutates(payload) : false;
  }
  return false;
}

function visit(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(visit);
  const node = value as {
    command?: unknown;
    commands?: unknown[];
    parts?: unknown[];
    script?: unknown;
    type?: string;
  };
  if (node.type === "Command" && commandMutates(node as Command)) return true;
  if (node.script && visit(node.script)) return true;
  if (node.command && visit(node.command)) return true;
  if (node.commands?.some(visit)) return true;
  if (node.parts?.some(visit)) return true;
  return Object.values(value).some(visit);
}

export function shellMutates(source: string, dialect: ShellDialect = "posix") {
  if (source.length > 100_000) return false;
  if (dialect !== "posix" && windowsShellMutates(source, dialect)) return true;
  try {
    const script = parse(source);
    return script.errors?.length ? false : visit(script);
  } catch {
    return false;
  }
}

const embeddedKeys = new Set(["cmd", "command", "script", "source", "code"]);

function stringLiteral(source: string, start: number) {
  const quote = source[start];
  if (quote !== '"' && quote !== "'" && quote !== "`") return undefined;
  let value = "";
  for (let index = start + 1; index < source.length; index++) {
    const character = source[index];
    if (character === "\\" && index + 1 < source.length) {
      value += source[++index];
      continue;
    }
    if (character === quote) return { end: index + 1, value };
    value += character;
  }
  return undefined;
}

export function embeddedShellMutates(source: string) {
  if (source.length > 100_000) return false;
  for (let index = 0; index < source.length; index++) {
    let key = "";
    let end = index;
    const literal = stringLiteral(source, index);
    if (literal) {
      key = literal.value;
      end = literal.end;
    } else if (/[A-Za-z_$]/.test(source[index] ?? "")) {
      while (/[A-Za-z0-9_$]/.test(source[end] ?? "")) end++;
      key = source.slice(index, end);
    } else continue;
    index = end - 1;
    if (!embeddedKeys.has(key)) continue;
    while (/\s/.test(source[end] ?? "")) end++;
    if (source[end++] !== ":") continue;
    while (/\s/.test(source[end] ?? "")) end++;
    const payload = stringLiteral(source, end);
    if (payload && shellMutates(payload.value)) return true;
  }
  return false;
}
