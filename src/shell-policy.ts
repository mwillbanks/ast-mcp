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

function executable(command: Command) {
  const values = [command.name, ...command.suffix].map(
    (word) => word?.value ?? "",
  );
  let index = 0;
  while (wrappers.has(values[index]?.split("/").at(-1)?.toLowerCase() ?? "")) {
    const wrapper = values[index++].split("/").at(-1)?.toLowerCase();
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
    name: values[index]?.split("/").at(-1)?.toLowerCase() ?? "",
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

function payloadAfter(args: string[], flags: string[]) {
  const index = args.findIndex(
    (arg) =>
      flags.includes(arg) || flags.some((flag) => arg.startsWith(`${flag}=`)),
  );
  if (index < 0) return undefined;
  const argument = args[index];
  const separator = argument.indexOf("=");
  return separator >= 0 ? argument.slice(separator + 1) : args[index + 1];
}

function commandMutates(command: Command) {
  const original = command.name?.value.split("/").at(-1)?.toLowerCase() ?? "";
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
      payloadAfter(args, ["-c", "--command", "-Command"]) ??
      (grouped >= 0 ? args[grouped + 1] : undefined);
    return payload ? shellMutates(payload) : false;
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

export function shellMutates(source: string) {
  if (source.length > 100_000) return false;
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
