import os from "node:os";
import path from "node:path";
import { embeddedShellMutates, shellMutates } from "./shell-policy";
import { advanceQuote } from "./source";

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
  document_query: ["filePath", "selectors"],
  file_hash: ["filePaths"],
  file_read: ["files"],
  find_related: ["path", "line"],
  impact: ["target"],
  implements: ["paths", "target"],
  map: ["paths"],
  policy_check: ["checks"],
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

class CommentStripper {
  private index = 0;
  private output = "";
  private quote = "";
  private escaped = false;

  constructor(private readonly input: string) {}

  read() {
    while (this.index < this.input.length) {
      if (this.quote) this.readQuoted();
      else this.readCode();
      this.index += 1;
    }
    return this.output;
  }

  private readQuoted() {
    const character = this.input[this.index] as string;
    this.output += character;
    const state = advanceQuote(character, this.quote, this.escaped);
    this.quote = state.quote;
    this.escaped = state.escaped;
  }

  private readCode() {
    const character = this.input[this.index] as string;
    const next = this.input[this.index + 1];
    if ("\"'`".includes(character)) return this.beginQuote(character);
    if (character === "/" && next === "/") return this.skipLineComment();
    if (character === "/" && next === "*") return this.skipBlockComment();
    this.output += character;
  }

  private beginQuote(character: string) {
    this.quote = character;
    this.output += character;
  }

  private skipLineComment() {
    while (
      this.index + 1 < this.input.length &&
      this.input[this.index + 1] !== "\n"
    )
      this.index += 1;
    this.output += "\n";
  }

  private skipBlockComment() {
    this.index += 2;
    while (
      this.index + 1 < this.input.length &&
      !(this.input[this.index] === "*" && this.input[this.index + 1] === "/")
    )
      this.index += 1;
    this.index += 1;
    this.output += " ";
  }
}

function withoutComments(input: string) {
  return new CommentStripper(input).read();
}

function hasBoolean(input: string, key: string, value: boolean) {
  return new RegExp(
    `(?:["']${key}["']|\\b${key})\\s*:\\s*${String(value)}\\b`,
  ).test(input);
}

type InputValidator = (input: string) => boolean;

const fileEntryKeyPattern =
  "(?:aiderBlocks|astRules|chattr|content|destination|expectedSha256|forceReferences|patchStrategy|preview)";
const declaredFileBatchExpression = new RegExp(
  `^\\s*(?:(?:await\\s+)?tools\\.mcp__ast_mcp__file_(?:chattr|delete|patch|rename|write)\\s*\\(\\s*)?\\{\\s*["']?files["']?\\s*:\\s*\\{\\s*["']([^"']+)["']\\s*:\\s*\\{\\s*["']?${fileEntryKeyPattern}["']?\\s*:`,
  "s",
);

const hasDeclaredFileBatch = (input: string) => {
  declaredFileBatchExpression.lastIndex = 0;
  return declaredFileBatchExpression.test(withoutComments(input));
};
const inputValidators: Record<string, InputValidator> = {
  file_chattr: (input) =>
    hasKey(input, "chattr") && hasDeclaredFileBatch(input),
  file_delete: (input) =>
    hasKey(input, "expectedSha256") && hasDeclaredFileBatch(input),
  file_patch: (input) =>
    hasKey(input, "expectedSha256") &&
    hasKey(input, "patchStrategy") &&
    hasDeclaredFileBatch(input) &&
    (hasKey(input, "astRules") || hasKey(input, "aiderBlocks")),
  file_rename: (input) =>
    hasKey(input, "expectedSha256") &&
    hasKey(input, "destination") &&
    hasDeclaredFileBatch(input),
  file_write: (input) =>
    hasKey(input, "content") && hasDeclaredFileBatch(input),
};

function meaningfulInput(invocation: Invocation) {
  const input = withoutComments(invocation.input).trim();
  if (!input || input === "{}") return invocation.tool === "config_status";
  const validator = inputValidators[invocation.tool];
  if (validator) return validator(input);
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

const singlePathExpression =
  /["']?(?:filePath|file|path|root|destination)["']?\s*:\s*["']([^"']+)["']/g;
const pathArrayExpression =
  /["']?(?:filePaths|paths)["']?\s*:\s*\[([^\]]*)\]/gs;
const keyedPathExpression = new RegExp(
  `["']([^"']+)["']\\s*:\\s*\\{\\s*["']?${fileEntryKeyPattern}["']?\\s*:`,
  "g",
);

function expressionValues(input: string, expression: RegExp) {
  expression.lastIndex = 0;
  const values: string[] = [];
  for (const match of input.matchAll(expression))
    if (match[1]) values.push(match[1]);
  return values;
}

function pathCandidates(input: string) {
  const candidates = [
    ...expressionValues(input, singlePathExpression),
    ...expressionValues(input, keyedPathExpression),
  ];
  pathArrayExpression.lastIndex = 0;
  for (const match of input.matchAll(pathArrayExpression)) {
    for (const value of match[1]?.matchAll(/["']([^"']+)["']/g) ?? []) {
      if (value[1]) candidates.push(value[1]);
    }
  }
  return candidates;
}

function escapedPath(candidate: string, roots: string[]) {
  const pathLike = candidate.includes("/") || candidate.includes("\\");
  return pathLike && !pathIsWithinRoot(candidate, roots);
}

const fileOperationTools = new Set([
  "file_chattr",
  "file_delete",
  "file_hash",
  "file_patch",
  "file_read",
  "file_rename",
  "file_write",
]);

export interface FileOperationPolicy {
  allowAnyPath?: boolean;
  allowTempDirectory?: boolean;
  roots?: string[];
}

interface InvocationPathPolicy {
  allowAnyPath: boolean;
  boundary: string;
  roots: string[];
}

function effectiveFileOperationRoots(
  workspaceRoots: string[],
  policy: FileOperationPolicy,
) {
  if (policy.roots) return policy.roots;
  return policy.allowTempDirectory === false
    ? workspaceRoots
    : [...workspaceRoots, os.tmpdir()];
}

function invocationPathPolicy(
  invocation: Invocation,
  workspaceRoots: string[],
  fileOperationPolicy: FileOperationPolicy,
): InvocationPathPolicy {
  if (!fileOperationTools.has(invocation.tool))
    return {
      allowAnyPath: false,
      boundary: "transcript workspace roots",
      roots: workspaceRoots,
    };
  return {
    allowAnyPath: fileOperationPolicy.allowAnyPath === true,
    boundary: "transcript file-operation roots",
    roots: effectiveFileOperationRoots(workspaceRoots, fileOperationPolicy),
  };
}

function invocationPathErrors(
  invocation: Invocation,
  policy: InvocationPathPolicy,
) {
  if (policy.allowAnyPath) return [];
  return pathCandidates(withoutComments(invocation.input))
    .filter((candidate) => escapedPath(candidate, policy.roots))
    .map(
      (candidate) =>
        `${invocation.tool} input escapes ${policy.boundary}: ${candidate}`,
    );
}

function pathErrors(
  invocations: Invocation[],
  workspaceRoots: string[],
  fileOperationPolicy: FileOperationPolicy,
) {
  return invocations.flatMap((invocation) =>
    invocationPathErrors(
      invocation,
      invocationPathPolicy(invocation, workspaceRoots, fileOperationPolicy),
    ),
  );
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
  ) {
    keyedPathExpression.lastIndex = 0;
    return expressionValues(input, keyedPathExpression).length > 1;
  }
  if (invocation.tool === "file_hash")
    return /filePaths\s*:\s*\[[^\]]+,[^\]]+\]/s.test(input);
  if (invocation.tool === "file_read")
    return (input.match(/filePath\s*:/g) ?? []).length > 1;
  return false;
}

type RenameFiles = Record<
  string,
  { destinationPath?: string; renamed?: boolean }
>;

function renameEntryMatches(
  files: RenameFiles,
  workspaceRoot: string,
  entry: [string, unknown],
) {
  const [source, value] = entry;
  if (!value || typeof value !== "object") return false;
  const destination = (value as { destination?: unknown }).destination;
  if (typeof destination !== "string") return false;
  const destinationPath = path.resolve(workspaceRoot, destination);
  const sourcePath = path.resolve(workspaceRoot, source);
  const file = files[source] ?? files[sourcePath];
  return (
    file?.destinationPath !== undefined &&
    path.resolve(file.destinationPath) === destinationPath &&
    file.renamed === true
  );
}

function renameResultsCoverInputs(
  call: Invocation,
  output: string,
  roots: string[] = [],
) {
  try {
    const request = JSON.parse(call.input) as {
      files?: Record<string, unknown>;
    };
    const result = JSON.parse(output) as { files?: RenameFiles };
    if (!request.files || !result.files) return false;
    const workspaceRoot = roots[0] ?? process.cwd();
    return Object.entries(request.files).every((entry) =>
      renameEntryMatches(result.files as RenameFiles, workspaceRoot, entry),
    );
  } catch {
    return false;
  }
}

function shellMutationSource(source: string) {
  return embeddedShellMutates(source) || shellMutates(source);
}

interface AssertionContext {
  evaluation: EvalCase;
  invocations: Invocation[];
  normalized: string;
  output: string;
  roots: string[];
  sanitized: Invocation[];
  source: string;
  tools: Set<string>;
}

type AssertionRule = (context: AssertionContext) => boolean | undefined;

function assertionContext(
  assertion: string,
  evaluation: EvalCase,
  invocations: Invocation[],
  output: string,
  roots: string[],
): AssertionContext {
  const sanitized = invocations.map((invocation) => ({
    ...invocation,
    input: withoutComments(invocation.input),
  }));
  return {
    evaluation,
    invocations,
    normalized: assertion.toLowerCase(),
    output,
    roots,
    sanitized,
    source: sanitized.map((invocation) => invocation.input).join("\n"),
    tools: new Set(sanitized.map((invocation) => invocation.tool)),
  };
}

function calls(context: AssertionContext, tool: string) {
  return context.sanitized.filter((invocation) => invocation.tool === tool);
}

function rejectedDestinationAssertion(
  renameCalls: Invocation[],
  output: string,
) {
  return (
    renameCalls.length > 0 &&
    /(?:already exists|destination.*exist|exist.*destination|rejected|error|failed)/i.test(
      output,
    ) &&
    /destination/i.test(output)
  );
}

function renameReportAssertion(
  renameCalls: Invocation[],
  output: string,
  roots: string[],
) {
  if (renameCalls.length === 0) return false;
  return (
    renameResultsCoverInputs(renameCalls[0] as Invocation, output, roots) &&
    /["']?files["']?\s*:/i.test(output) &&
    /destinationPath|renamed/i.test(output)
  );
}

function renameAssertion(context: AssertionContext): boolean | undefined {
  const { normalized, output, roots } = context;
  const renameCalls = calls(context, "file_rename");
  if (
    normalized.includes("does not overwrite") ||
    normalized.includes("existing destination")
  )
    return rejectedDestinationAssertion(renameCalls, output);
  if (
    normalized.includes("reports each source") &&
    normalized.includes("destination")
  )
    return renameReportAssertion(renameCalls, output, roots);
  return undefined;
}

function prohibitionAssertion(context: AssertionContext): boolean | undefined {
  const { evaluation, normalized, source, tools } = context;
  if (
    normalized.includes("does not call") ||
    normalized.includes("does not use") ||
    normalized.includes("never calls")
  ) {
    return (
      evaluation.forbidden_tools.every((tool) => !tools.has(tool)) &&
      !(normalized.includes("shell") && shellMutationSource(source))
    );
  }
  if (
    normalized.includes("direct filesystem") ||
    normalized.includes("direct editor") ||
    normalized.includes("shell mutation")
  )
    return !shellMutationSource(source);
  return undefined;
}

function readAssertion(context: AssertionContext): boolean | undefined {
  const { normalized } = context;
  const readCalls = calls(context, "file_read");
  if (normalized.includes("bounded") && normalized.includes("lines")) {
    return readCalls.some((call) =>
      /lines\s*:\s*\[\s*\d+\s*,\s*\d+\s*\]/.test(call.input),
    );
  }
  if (normalized.includes("maxbytes") || normalized.includes("64 kib"))
    return readCalls.every((call) => hasKey(call.input, "maxBytes"));
  return undefined;
}

function hashPrecedesMutation(context: AssertionContext) {
  const hashIndex = calls(context, "file_hash")[0]?.index;
  const mutation = context.invocations.find((call) =>
    ["file_patch", "file_write", "file_delete", "file_rename"].includes(
      call.tool,
    ),
  );
  return (
    hashIndex !== undefined &&
    mutation?.index !== undefined &&
    hashIndex < mutation.index
  );
}

function declaredFileBatchAssertion(
  context: AssertionContext,
): boolean | undefined {
  const { invocations, normalized } = context;
  if (!normalized.includes("declared") || !normalized.includes("files"))
    return undefined;
  const requireBatch = normalized.includes("batch");
  return invocations.some(
    (invocation) =>
      [
        "file_patch",
        "file_write",
        "file_chattr",
        "file_delete",
        "file_rename",
      ].includes(invocation.tool) &&
      hasDeclaredFileBatch(invocation.input) &&
      (!requireBatch || isBatch(invocation)),
  );
}

function previewAssertion(context: AssertionContext): boolean | undefined {
  const patchCalls = calls(context, "file_patch");
  if (context.normalized.includes("preview true"))
    return patchCalls.some((call) => hasBoolean(call.input, "preview", true));
  if (
    !context.normalized.includes("preview") &&
    !context.normalized.includes("dry run")
  )
    return undefined;
  return (
    calls(context, "run").some(
      (call) => !hasBoolean(call.input, "write", true),
    ) || patchCalls.some((call) => hasBoolean(call.input, "preview", true))
  );
}

function workflowAssertion(context: AssertionContext): boolean | undefined {
  const declaredBatch = declaredFileBatchAssertion(context);
  if (declaredBatch !== undefined) return declaredBatch;
  const { invocations, normalized } = context;
  if (normalized.includes("batch") || normalized.includes("one keyed"))
    return invocations.some(isBatch);
  if (normalized.includes("fresh") && normalized.includes("hash"))
    return hashPrecedesMutation(context);
  return previewAssertion(context);
}

function strategyAssertion(context: AssertionContext): boolean | undefined {
  const { normalized } = context;
  const patchCalls = calls(context, "file_patch");
  if (normalized.includes("exactly one match"))
    return patchCalls.some((call) =>
      /expectedMatches\s*:\s*1\b/.test(call.input),
    );
  if (
    normalized.includes("ast strategy") ||
    normalized.includes("patchstrategy ast")
  )
    return patchCalls.some((call) =>
      /patchStrategy\s*:\s*["']ast["']/.test(call.input),
    );
  if (normalized.includes("aider"))
    return patchCalls.some((call) =>
      /patchStrategy\s*:\s*["']aider_block["']/.test(call.input),
    );
  return undefined;
}

function outputAssertion(context: AssertionContext): boolean | undefined {
  const { normalized, output } = context;
  if (
    normalized.includes("reports") ||
    normalized.includes("verification") ||
    normalized.includes("output")
  )
    return output.trim().length > 0;
  return undefined;
}

const assertionRules: AssertionRule[] = [
  renameAssertion,
  prohibitionAssertion,
  readAssertion,
  workflowAssertion,
  strategyAssertion,
  outputAssertion,
];

function assertionSatisfied(
  assertion: string,
  evaluation: EvalCase,
  invocations: Invocation[],
  output: string,
  roots: string[] = [],
) {
  const context = assertionContext(
    assertion,
    evaluation,
    invocations,
    output,
    roots,
  );
  for (const rule of assertionRules) {
    const result = rule(context);
    if (result !== undefined) return result;
  }
  return (
    context.evaluation.required_tools.every((tool) =>
      context.tools.has(tool),
    ) &&
    context.sanitized.every(meaningfulInput) &&
    context.output.trim().length > 0
  );
}

function sanitizeInvocations(invocations: Invocation[]): Invocation[] {
  return invocations.map((invocation) => ({
    ...invocation,
    input: withoutComments(invocation.input),
  }));
}

function toolContractErrors(evaluation: EvalCase, invocations: Invocation[]) {
  const errors: string[] = [];
  const tools = new Set(
    sanitizeInvocations(invocations).map((invocation) => invocation.tool),
  );
  for (const tool of evaluation.required_tools)
    if (!tools.has(tool)) errors.push(`missing required tool: ${tool}`);
  for (const tool of evaluation.forbidden_tools)
    if (tools.has(tool)) errors.push(`used forbidden tool: ${tool}`);
  for (const invocation of invocations)
    if (!meaningfulInput(invocation))
      errors.push(`${invocation.tool} has empty or schema-incomplete input`);
  return errors;
}

function sequenceErrors(evaluation: EvalCase, invocations: Invocation[]) {
  const errors: string[] = [];
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
      if (invocations.some((invocation) => invocation.tool === tool))
        errors.push(`required tool sequence is not satisfied at: ${tool}`);
      continue;
    }
    priorIndex = next.index;
  }
  return errors;
}

function fileEvidenceErrors(
  evaluation: EvalCase,
  invocations: Invocation[],
  output: string,
) {
  const errors: string[] = [];
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
  return errors;
}

function transportOutputMissing(evaluation: EvalCase, output: string) {
  if (evaluation.required_tools.length !== 0) return false;
  return !evaluation.expected_output
    .toLowerCase()
    .split(/\W+/)
    .filter((word) => word.length >= 7)
    .some((word) => output.toLowerCase().includes(word));
}

export function verifyEvaluation(
  evaluation: EvalCase,
  invocations: Invocation[],
  output: string,
  roots: string[],
  fileOperationPolicy: FileOperationPolicy = {},
) {
  const errors = [
    ...toolContractErrors(evaluation, invocations),
    ...sequenceErrors(evaluation, invocations),
    ...pathErrors(invocations, roots, fileOperationPolicy),
    ...fileEvidenceErrors(evaluation, invocations, output),
  ];
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
  if (transportOutputMissing(evaluation, output))
    errors.push("output does not prove expected transport behavior");
  for (const assertion of evaluation.assertions)
    if (!assertionSatisfied(assertion, evaluation, invocations, output, roots))
      errors.push(`assertion not proven: ${assertion}`);
  return errors;
}
