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

const wrapperValueOptions: Record<string, Set<string>> = {
  doas: new Set([
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
  ]),
  env: new Set(["-u", "-C", "--unset", "--chdir"]),
  nice: new Set(["-n", "--adjustment"]),
  sudo: new Set([
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
  ]),
};

function commandName(value = "") {
  return value.split("/").at(-1)?.toLowerCase() ?? "";
}

function skipWrapper(values: string[], index: number) {
  const wrapper = commandName(values[index]);
  let cursor = index + 1;
  while (values[cursor]?.startsWith("-")) {
    const option = values[cursor] as string;
    cursor += wrapperValueOptions[wrapper]?.has(option) ? 2 : 1;
  }
  if (wrapper === "env")
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(values[cursor] ?? "")) cursor += 1;
  if ((wrapper === "timeout" || wrapper === "chrt") && cursor < values.length)
    cursor += 1;
  return cursor;
}

function executable(command: Command) {
  const values = [command.name, ...command.suffix].map(
    (word) => word?.value ?? "",
  );
  let index = 0;
  while (wrappers.has(commandName(values[index])))
    index = skipWrapper(values, index);
  return { args: values.slice(index + 1), name: commandName(values[index]) };
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

type CommandMutationHandler = (args: string[]) => boolean;

function sedMutates(args: string[]) {
  return args.some(
    (arg) =>
      arg === "--in-place" ||
      arg.startsWith("--in-place=") ||
      /^-[^-]*i/.test(arg),
  );
}

function astGrepMutates(args: string[]) {
  const rewrites = args.some(
    (arg) => arg === "--rewrite" || arg.startsWith("--rewrite="),
  );
  return rewrites && args.some((arg) => arg === "-U" || arg === "--update-all");
}

function findMutates(args: string[]) {
  if (args.includes("-delete")) return true;
  const action = args.findIndex((arg) =>
    ["-exec", "-execdir", "-ok", "-okdir"].includes(arg),
  );
  return action >= 0 && shellMutates(args.slice(action + 1).join(" "));
}

function shellInterpreterMutates(args: string[]) {
  const grouped = args.findIndex((arg) => /^-[A-Za-z]*c[A-Za-z]*$/.test(arg));
  const payload =
    payloadAfter(args, ["-c", "--command", "-Command"]) ??
    (grouped >= 0 ? args[grouped + 1] : undefined);
  return payload ? shellMutates(payload) : false;
}

function inlineInterpreterMutates(name: string, args: string[]) {
  const flags = name.startsWith("python") ? ["-c"] : ["-e", "--eval"];
  const payload = payloadAfter(args, flags);
  return payload ? inlineMutates(payload) : false;
}

const shellInterpreters = new Set([
  "bash",
  "sh",
  "zsh",
  "dash",
  "ksh",
  "fish",
  "pwsh",
  "powershell",
]);
const mutationHandlers: Record<string, CommandMutationHandler> = {
  "ast-grep": astGrepMutates,
  eval: (args) => shellMutates(args.join(" ")),
  find: findMutates,
  sed: sedMutates,
  xargs: (args) => shellMutates(args.join(" ")),
};

function originalCommandDecision(
  original: string,
  args: string[],
): boolean | undefined {
  if (
    original === "command" &&
    args.some((arg) => arg === "-v" || arg === "-V")
  )
    return false;
  if (original !== "env") return undefined;
  const dispatched = payloadAfter(args, ["-S", "--split-string"]);
  return dispatched ? shellMutates(dispatched) : undefined;
}

function commandMutates(command: Command) {
  const original = commandName(command.name?.value);
  const originalArgs = command.suffix.map((word) => word.value);
  const originalDecision = originalCommandDecision(original, originalArgs);
  if (originalDecision !== undefined) return originalDecision;
  const { args, name } = executable(command);
  if (name === "git") return false;
  if (mutators.has(name)) return true;
  const handler = mutationHandlers[name];
  if (handler) return handler(args);
  if (shellInterpreters.has(name)) return shellInterpreterMutates(args);
  if (/^(?:node|python\d*(?:\.\d+)*|ruby|perl|php|bun|deno)$/.test(name))
    return inlineInterpreterMutates(name, args);
  return false;
}

function nodeChildren(value: Record<string, unknown>) {
  const node = value as {
    command?: unknown;
    commands?: unknown[];
    parts?: unknown[];
    script?: unknown;
  };
  return [
    node.script,
    node.command,
    ...(node.commands ?? []),
    ...(node.parts ?? []),
  ];
}

function visit(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(visit);
  const node = value as { type?: string };
  if (node.type === "Command" && commandMutates(value as Command)) return true;
  if (nodeChildren(value as Record<string, unknown>).some(visit)) return true;
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

interface EmbeddedKey {
  end: number;
  key: string;
}

function embeddedKey(source: string, index: number): EmbeddedKey | undefined {
  const literal = stringLiteral(source, index);
  if (literal) return { end: literal.end, key: literal.value };
  if (!/[A-Za-z_$]/.test(source[index] ?? "")) return undefined;
  let end = index;
  while (/[A-Za-z0-9_$]/.test(source[end] ?? "")) end += 1;
  return { end, key: source.slice(index, end) };
}

function skipWhitespace(source: string, index: number) {
  while (/\s/.test(source[index] ?? "")) index += 1;
  return index;
}

function embeddedPayload(source: string, key: EmbeddedKey) {
  let index = skipWhitespace(source, key.end);
  if (source[index] !== ":") return undefined;
  index = skipWhitespace(source, index + 1);
  return stringLiteral(source, index)?.value;
}

export function embeddedShellMutates(source: string) {
  if (source.length > 100_000) return false;
  for (let index = 0; index < source.length; index += 1) {
    const key = embeddedKey(source, index);
    if (!key) continue;
    index = key.end - 1;
    if (!embeddedKeys.has(key.key)) continue;
    const payload = embeddedPayload(source, key);
    if (payload && shellMutates(payload)) return true;
  }
  return false;
}
