const stableVersion = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const documentationRoot = "https://mwillbanks.github.io/ast-mcp";
const fenceOpening = /^ {0,3}(\x60{3,}|~{3,})[ \t]*(\S*)/;
const relativeDestination =
  /(\]\(|^ {0,3}\[[^\]]+\]:[ \t]+)(\/docs(?:\/|(?=[)#?\s]))[^\s)>]*)/;

export function validateReleaseVersion(value: unknown): string {
  if (typeof value !== "string" || !stableVersion.test(value))
    throw new Error("Invalid AST-MCP release version");
  return value;
}

function documentationLinks(line: string): string {
  const destinations = new RegExp(relativeDestination, "g");
  return line.replaceAll(
    destinations,
    (_, prefix: string, destination: string) =>
      prefix + documentationRoot + destination,
  );
}

function releaseBody(source: string, version: string): string {
  const normalized = source.replaceAll("\r\n", "\n");
  const metadata = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized);
  if (!metadata || /\bNEXT_RELEASE\b/.test(normalized))
    throw new Error("Release notes require versioned MDX front matter");
  const frontMatter: unknown = Bun.YAML.parse(metadata[1]!);
  if (
    !frontMatter ||
    typeof frontMatter !== "object" ||
    !("title" in frontMatter) ||
    (frontMatter.title !== version &&
      frontMatter.title !== "AST-MCP " + version)
  )
    throw new Error("Release notes title must match " + version);
  return normalized.slice(metadata[0].length);
}

export function renderReleaseNotes(
  source: string,
  inputVersion: string,
): string {
  const version = validateReleaseVersion(inputVersion);
  const lines: string[] = [];
  let fence: { delimiter: string; mermaid: boolean } | undefined;
  for (const line of releaseBody(source, version).split("\n")) {
    if (fence) {
      const trimmed = line.trim();
      if (!fence.mermaid) lines.push(line);
      if (
        trimmed.startsWith(fence.delimiter) &&
        [...trimmed].every((character) => character === fence!.delimiter[0])
      )
        fence = undefined;
      continue;
    }
    const opening = fenceOpening.exec(line);
    if (opening) {
      fence = { delimiter: opening[1]!, mermaid: opening[2] === "mermaid" };
      if (!fence.mermaid) lines.push(line);
      continue;
    }
    if (/^(?:import|export)\s|<\/?[A-Z][A-Za-z0-9]*(?:\s|\/?>)/.test(line))
      throw new Error("Release notes must use portable Markdown");
    lines.push(documentationLinks(line));
  }
  const markdown = lines.join("\n").trim();
  if (fence || !markdown) throw new Error("Invalid release notes body");
  const url = documentationRoot + "/docs/releases/" + version + "/";
  return (
    markdown +
    "\n\n[Read the full release notes on the documentation site](" +
    url +
    ").\n"
  );
}

type ReleaseSource = {
  exists(): Promise<boolean>;
  slice(start: number, end: number): Blob;
};

export async function releaseNotesCommand(
  args: readonly string[],
  open: (filename: string) => ReleaseSource = Bun.file,
): Promise<string> {
  const [argument, file, ...extra] = args;
  const version = validateReleaseVersion(argument);
  if (extra.length)
    throw new Error("Usage: render-release-notes <version> [mdx-file]");
  const source = open(
    file ?? "website/content/docs/releases/" + version + ".mdx",
  );
  if (!(await source.exists()))
    throw new Error("Release notes source is missing");
  const byteLimit = 1024 * 1024;
  const bytes = await source.slice(0, byteLimit + 1).arrayBuffer();
  if (bytes.byteLength > byteLimit)
    throw new Error("Release notes source is too large");
  return renderReleaseNotes(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    version,
  );
}

if (import.meta.main)
  process.stdout.write(await releaseNotesCommand(Bun.argv.slice(2)));
