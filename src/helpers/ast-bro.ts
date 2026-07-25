export type IndexedAstBroTool = "search" | "find_related" | "index";

function stringArgument(
  args: Record<string, unknown>,
  key: string,
  fallback: string,
): string {
  return typeof args[key] === "string" ? args[key] : fallback;
}

function appendSearchArguments(
  command: string[],
  args: Record<string, unknown>,
  root: string,
): void {
  if (typeof args.query !== "string")
    throw new Error("ast-bro search requires a query");
  command.push(args.query, stringArgument(args, "path", root));
  if (typeof args.alpha === "number")
    command.push("--alpha", String(args.alpha));
  for (const language of Array.isArray(args.languages) ? args.languages : [])
    if (typeof language === "string") command.push("--lang", language);
}

function appendRelatedArguments(
  command: string[],
  args: Record<string, unknown>,
  root: string,
): void {
  if (typeof args.path !== "string" || typeof args.line !== "number")
    throw new Error("ast-bro find_related requires path and line");
  command.push(
    "--file",
    args.path,
    "--line",
    String(args.line),
    stringArgument(args, "root", root),
  );
}

function appendCommonArguments(
  command: string[],
  args: Record<string, unknown>,
): void {
  if (typeof args.top_k === "number")
    command.push("--top-k", String(args.top_k));
  if (args.rebuild === true) command.push("--rebuild");
  if (args.stats === true) command.push("--stats");
  if (args.json === true) command.push("--json", "--compact");
}

export function indexedAstBroCommand(
  toolName: IndexedAstBroTool,
  args: Record<string, unknown>,
  root: string,
): string[] {
  const command = [toolName.replace("_", "-")];
  if (toolName === "search") appendSearchArguments(command, args, root);
  else if (toolName === "find_related")
    appendRelatedArguments(command, args, root);
  else command.push(stringArgument(args, "path", root));
  appendCommonArguments(command, args);
  return command;
}
