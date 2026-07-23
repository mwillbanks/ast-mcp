import path from "node:path";
import { embeddedShellMutates, shellMutates } from "./shell-policy";

export type EvalCase = {
  id: number;
  files: string[];
  forbidden_tools: string[];
  required_tools: string[];
  expected_output: string;
  assertions: string[];
};

export type Invocation = {
  concurrent?: boolean;
  index: number;
  input: string;
  tool: string;
};

const toolKeys: Record<string, string[]> = {
  callees: ["target"],
  callers: ["target"],
  context: ["target"],
  deps: ["file"],
  digest: ["paths"],
  file_hash: ["filePaths"],
  file_read: ["files"],
  find_related: ["path", "line"],
  impact: ["target"],
  implements: ["paths", "target"],
  map: ["paths"],
  reverse_deps: ["file"],
  run: ["pattern"],
  search: ["query"],
  show: ["path", "symbols"],
  squeeze: ["path"],
  trace: ["from", "to"],
};

function hasKey(input: string, key: string) {
  return new RegExp(`(?:["']${key}["']|\\b${key})\\s*:`).test(input);
}

function withoutComments(input: string) {
  let output = "";
  let quote = "";
  let escaped = false;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index] as string;
    const next = input[index + 1];
    if (quote) {
      output += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      output += character;
      continue;
    }
    if (character === "/" && next === "/") {
      while (index + 1 < input.length && input[index + 1] !== "\n") index += 1;
      output += "\n";
      continue;
    }
    if (character === "/" && next === "*") {
      index += 2;
      while (
        index + 1 < input.length &&
        !(input[index] === "*" && input[index + 1] === "/")
      )
        index += 1;
      index += 1;
      output += " ";
      continue;
    }
    output += character;
  }
  return output;
}

function hasBoolean(input: string, key: string, value: boolean) {
  return new RegExp(
    `(?:["']${key}["']|\\b${key})\\s*:\\s*${String(value)}\\b`,
  ).test(input);
}

function meaningfulInput(invocation: Invocation) {
  const input = withoutComments(invocation.input).trim();
  if (!input || input === "{}") return false;
  if (invocation.tool === "file_patch") {
    return (
      hasKey(input, "expectedSha256") &&
      hasKey(input, "patchStrategy") &&
      (hasKey(input, "astRules") || hasKey(input, "aiderBlocks"))
    );
  }
  if (invocation.tool === "file_write")
    return hasKey(input, "content") && /["'][^"']+["']\s*:/.test(input);
  if (invocation.tool === "file_chattr")
    return hasKey(input, "chattr") && /["'][^"']+["']\s*:/.test(input);
  if (invocation.tool === "file_delete")
    return hasKey(input, "expectedSha256") && /["'][^"']+["']\s*:/.test(input);
  if (invocation.tool === "file_rename")
    return (
      hasKey(input, "expectedSha256") &&
      hasKey(input, "destination") &&
      /["'][^"']+["']\s*:/.test(input)
    );
  return (toolKeys[invocation.tool] ?? []).every((key) => hasKey(input, key));
}

function pathIsWithinRoot(candidate: string, roots: string[]) {
  if (!path.isAbsolute(candidate))
    return !candidate.split(/[\\/]+/).includes("..");
  return roots.some((root) => {
    const relative = path.relative(root, candidate);
    return (
      relative === "" ||
      (!relative.startsWith("..") && !path.isAbsolute(relative))
    );
  });
}

function pathErrors(invocations: Invocation[], roots: string[]) {
  const errors: string[] = [];
  const singlePath =
    /["']?(?:filePath|file|path|root|destination)["']?\s*:\s*["']([^"']+)["']/g;
  const pathArray = /["']?(?:filePaths|paths)["']?\s*:\s*\[([^\]]*)\]/gs;
  const keyedPath =
    /["']([^"']+)["']\s*:\s*\{\s*(?:content|expectedSha256|destination|chattr|astRules|aiderBlocks|patchStrategy)\s*:/g;
  for (const invocation of invocations) {
    const input = withoutComments(invocation.input);
    const candidates: string[] = [];
    for (const expression of [singlePath, keyedPath]) {
      expression.lastIndex = 0;
      for (const match of input.matchAll(expression))
        if (match[1]) candidates.push(match[1]);
    }
    pathArray.lastIndex = 0;
    for (const match of input.matchAll(pathArray))
      for (const value of match[1]?.matchAll(/["']([^"']+)["']/g) ?? [])
        if (value[1]) candidates.push(value[1]);
    for (const candidate of candidates)
      if (
        (candidate.includes("/") || candidate.includes("\\")) &&
        !pathIsWithinRoot(candidate, roots)
      )
        errors.push(
          `${invocation.tool} input escapes transcript workspace roots: ${candidate}`,
        );
  }
  return errors;
}

function isBatch(invocation: Invocation) {
  const input = withoutComments(invocation.input);
  if (
    [
      "file_patch",
      "file_write",
      "file_chattr",
      "file_delete",
      "file_rename",
    ].includes(invocation.tool)
  )
    return (input.match(/["'][^"']+["']\s*:\s*\{/g) ?? []).length > 1;
  if (invocation.tool === "file_hash")
    return /filePaths\s*:\s*\[[^\]]+,[^\]]+\]/s.test(input);
  if (invocation.tool === "file_read")
    return (input.match(/filePath\s*:/g) ?? []).length > 1;
  return false;
}

function renameResultsCoverInputs(
  call: Invocation,
  output: string,
  roots: string[] = [],
) {
  try {
    const request = JSON.parse(call.input) as Record<string, unknown>;
    const result = JSON.parse(output) as {
      files?: Record<string, { destinationPath?: string; renamed?: boolean }>;
    };
    if (!result.files) return false;
    const workspaceRoot = roots[0] ?? process.cwd();
    return Object.entries(request).every(([source, value]) => {
      if (!value || typeof value !== "object") return false;
      const destination = (value as { destination?: unknown }).destination;
      const sourcePath = path.resolve(workspaceRoot, source);
      const destinationPath =
        typeof destination === "string"
          ? path.resolve(workspaceRoot, destination)
          : undefined;
      const file = result.files?.[source] ?? result.files?.[sourcePath];
      return (
        destinationPath !== undefined &&
        file?.destinationPath !== undefined &&
        path.resolve(file.destinationPath) === destinationPath &&
        file.renamed === true
      );
    });
  } catch {
    return false;
  }
}

function shellMutationSource(source: string) {
  return embeddedShellMutates(source) || shellMutates(source);
}

function assertionSatisfied(
  assertion: string,
  evaluation: EvalCase,
  invocations: Invocation[],
  output: string,
  roots: string[] = [],
) {
  const normalized = assertion.toLowerCase();
  const sanitizedInvocations = invocations.map((invocation) => ({
    ...invocation,
    input: withoutComments(invocation.input),
  }));
  const tools = new Set(
    sanitizedInvocations.map((invocation) => invocation.tool),
  );
  const source = sanitizedInvocations
    .map((invocation) => invocation.input)
    .join("\n");
  const calls = (tool: string) =>
    sanitizedInvocations.filter((invocation) => invocation.tool === tool);
  if (
    normalized.includes("does not overwrite") ||
    normalized.includes("existing destination")
  ) {
    const renameCall = calls("file_rename");
    return (
      renameCall.length > 0 &&
      /(?:already exists|destination.*exist|exist.*destination|rejected|error|failed)/i.test(
        output,
      ) &&
      /destination/i.test(output)
    );
  }
  if (
    normalized.includes("reports each source") &&
    normalized.includes("destination")
  )
    return (
      calls("file_rename").length > 0 &&
      renameResultsCoverInputs(calls("file_rename")[0], output, roots) &&
      /["']?files["']?\s*:/i.test(output) &&
      /destinationPath|renamed/i.test(output)
    );
  if (
    normalized.includes("does not call") ||
    normalized.includes("does not use") ||
    normalized.includes("never calls")
  )
    return (
      evaluation.forbidden_tools.every((tool) => !tools.has(tool)) &&
      !(normalized.includes("shell") && shellMutationSource(source))
    );
  if (
    normalized.includes("direct filesystem") ||
    normalized.includes("direct editor") ||
    normalized.includes("shell mutation")
  )
    return !shellMutationSource(source);
  if (normalized.includes("bounded") && normalized.includes("lines"))
    return calls("file_read").some((call) =>
      /lines\s*:\s*\[\s*\d+\s*,\s*\d+\s*\]/.test(call.input),
    );
  if (normalized.includes("maxbytes") || normalized.includes("64 kib"))
    return calls("file_read").every((call) => hasKey(call.input, "maxBytes"));
  if (normalized.includes("batch") || normalized.includes("one keyed"))
    return invocations.some(isBatch);
  if (normalized.includes("fresh") && normalized.includes("hash")) {
    const hashIndex = calls("file_hash")[0]?.index;
    const mutationIndex = invocations.find((call) =>
      ["file_patch", "file_write", "file_delete", "file_rename"].includes(
        call.tool,
      ),
    )?.index;
    return (
      hashIndex !== undefined &&
      mutationIndex !== undefined &&
      hashIndex < mutationIndex
    );
  }
  if (normalized.includes("preview true"))
    return calls("file_patch").some((call) =>
      hasBoolean(call.input, "preview", true),
    );
  if (normalized.includes("preview") || normalized.includes("dry run"))
    return (
      calls("run").some((call) => !hasBoolean(call.input, "write", true)) ||
      calls("file_patch").some((call) =>
        hasBoolean(call.input, "preview", true),
      )
    );
  if (normalized.includes("exactly one match"))
    return calls("file_patch").some((call) =>
      /expectedMatches\s*:\s*1\b/.test(call.input),
    );
  if (
    normalized.includes("ast strategy") ||
    normalized.includes("patchstrategy ast")
  )
    return calls("file_patch").some((call) =>
      /patchStrategy\s*:\s*["']ast["']/.test(call.input),
    );
  if (normalized.includes("aider"))
    return calls("file_patch").some((call) =>
      /patchStrategy\s*:\s*["']aider_block["']/.test(call.input),
    );
  if (
    normalized.includes("reports") ||
    normalized.includes("verification") ||
    normalized.includes("output")
  )
    return output.trim().length > 0;
  return (
    evaluation.required_tools.every((tool) => tools.has(tool)) &&
    sanitizedInvocations.every(meaningfulInput) &&
    output.trim().length > 0
  );
}

export function verifyEvaluation(
  evaluation: EvalCase,
  invocations: Invocation[],
  output: string,
  roots: string[],
) {
  const errors: string[] = [];
  const sanitizedInvocations = invocations.map((invocation) => ({
    ...invocation,
    input: withoutComments(invocation.input),
  }));
  const tools = new Set(
    sanitizedInvocations.map((invocation) => invocation.tool),
  );
  for (const tool of evaluation.required_tools)
    if (!tools.has(tool)) errors.push(`missing required tool: ${tool}`);
  for (const tool of evaluation.forbidden_tools)
    if (tools.has(tool)) errors.push(`used forbidden tool: ${tool}`);
  for (const invocation of invocations)
    if (!meaningfulInput(invocation))
      errors.push(`${invocation.tool} has empty or schema-incomplete input`);
  if (
    evaluation.required_tools.length > 1 &&
    invocations.some(
      (invocation) =>
        invocation.concurrent &&
        evaluation.required_tools.includes(invocation.tool),
    )
  )
    errors.push("required tool sequence is concurrent and cannot be proven");
  let priorIndex = -1;
  for (const tool of evaluation.required_tools) {
    const next = invocations.find(
      (invocation) => invocation.tool === tool && invocation.index > priorIndex,
    );
    if (!next) {
      if (tools.has(tool))
        errors.push(`required tool sequence is not satisfied at: ${tool}`);
      continue;
    }
    priorIndex = next.index;
  }
  errors.push(...pathErrors(invocations, roots));
  for (const file of evaluation.files) {
    if (
      !invocations.some((invocation) =>
        withoutComments(invocation.input).includes(file),
      )
    )
      errors.push(`input does not target required file: ${file}`);
    if (!output.includes(file))
      errors.push(`output does not prove file result: ${file}`);
  }
  if (
    !assertionSatisfied(
      evaluation.expected_output,
      evaluation,
      invocations,
      output,
      roots,
    )
  )
    errors.push(`expected output not proven: ${evaluation.expected_output}`);
  if (
    evaluation.required_tools.length === 0 &&
    !evaluation.expected_output
      .toLowerCase()
      .split(/\W+/)
      .filter((word) => word.length >= 7)
      .some((word) => output.toLowerCase().includes(word))
  )
    errors.push("output does not prove expected transport behavior");
  for (const assertion of evaluation.assertions)
    if (!assertionSatisfied(assertion, evaluation, invocations, output, roots))
      errors.push(`assertion not proven: ${assertion}`);
  return errors;
}
