import { readFile } from "node:fs/promises";

import { discoverTestFiles } from "./test-shard";

const decode = (value: string) =>
  value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");

/** Reject truncated reports and contradictory success markers before reading weights. */
function validateReport(xml: string) {
  const stack: string[] = [];
  const suites: string[] = [];
  let rootSeen = false;
  let offset = 0;
  const tags =
    /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<\/?[A-Za-z][\w:.-]*(?:[^"'<>]|"[^"]*"|'[^']*')*>/g;
  for (const match of xml.matchAll(tags)) {
    const between = xml.slice(offset, match.index);
    if (between.includes("<") || (!stack.length && between.trim()))
      throw new Error("Malformed timing report");
    offset = match.index + match[0].length;
    if (/^<(?:!|\?)/.test(match[0])) continue;
    const tag = /^<(\/?)([\w:.-]+)([\s\S]*?)(\/?)>$/.exec(match[0])!;
    const [, closing, name, attributes, selfClosing] = tag;
    if (closing) {
      if (attributes.trim() || selfClosing || stack.pop() !== name)
        throw new Error("Unbalanced timing report");
      continue;
    }
    if (!stack.length) {
      if (rootSeen || name !== "testsuites")
        throw new Error("Invalid timing report root");
      rootSeen = true;
    }
    if (name === "testsuite" && stack.length === 1) suites.push(attributes);
    if (name === "failure" || name === "error")
      throw new Error("Timing report contains failed tests");
    const seen = new Set<string>();
    let rest = attributes;
    while (rest.trim()) {
      const attribute = /^\s+([\w:.-]+)=("[^"]*"|'[^']*')/.exec(rest);
      if (!attribute || seen.has(attribute[1]))
        throw new Error("Invalid timing report attributes");
      seen.add(attribute[1]);
      if (
        ["failures", "errors"].includes(attribute[1]) &&
        !/^["']0["']$/.test(attribute[2])
      )
        throw new Error("Timing report contains unsuccessful tests");
      rest = rest.slice(attribute[0].length);
    }
    if (!selfClosing) stack.push(name);
  }
  if (!rootSeen || stack.length || xml.slice(offset).trim())
    throw new Error("Incomplete timing report");
  return suites;
}

/** Accept complete successful Bun JUnit reports; never silently omit tests. */
export function testDurations(xml: string, inventory: readonly string[]) {
  const suites = validateReport(xml);
  const root = xml.match(/<testsuites\b([^>]*)>/)?.[1];
  if (!root || !/\bfailures="0"/.test(root))
    throw new Error("Timing report must describe a successful complete suite");
  const files: Record<string, number> = {};
  for (const attributes of suites) {
    const file = attributes.match(/\bfile="([^"]+)"/)?.[1];
    const seconds = attributes.match(/\btime="([^"]+)"/)?.[1];
    if (
      !file ||
      seconds === undefined ||
      !/^(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(seconds)
    )
      throw new Error("Timing suites require file paths and numeric durations");
    const name = decode(file).replaceAll("\\", "/");
    const milliseconds = Number(seconds) * 1000;
    if (
      !inventory.includes(name) ||
      name in files ||
      !Number.isFinite(milliseconds) ||
      milliseconds < 0
    )
      throw new Error(
        "Timing report contains an unknown duplicate or invalid test duration",
      );
    files[name] = Math.max(1, Math.ceil(milliseconds));
  }
  if (Object.keys(files).length !== inventory.length)
    throw new Error("Timing report must cover every discovered test file");
  return {
    description:
      "Measured Bun test durations in milliseconds. Unknown new files use a conservative median baseline.",
    files: Object.fromEntries(
      Object.entries(files).sort(([a], [b]) => a.localeCompare(b)),
    ),
  };
}

export async function runDurationReport(
  args: string[],
  root = process.cwd(),
  output: (text: string) => void = console.log,
) {
  if (args.length !== 1 || !args[0])
    throw new Error(
      "Usage: bun scripts/testing/test-durations.ts <complete Bun JUnit report>",
    );
  output(
    JSON.stringify(
      testDurations(await readFile(args[0], "utf8"), discoverTestFiles(root)),
      null,
      2,
    ),
  );
}

if (import.meta.main) await runDurationReport(process.argv.slice(2));
