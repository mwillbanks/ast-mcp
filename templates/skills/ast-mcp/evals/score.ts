import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  type Invocation,
  type EvalCase as SemanticEvalCase,
  verifyEvaluation,
} from "./semantic";

type EvalCase = SemanticEvalCase;

type RecordPayload = {
  call_id?: string;
  content?: unknown;
  cwd?: string;
  input?: unknown;
  isError?: boolean;
  name?: string;
  output?: unknown;
  role?: string;
  type?: string;
  workspace_roots?: string[];
};

type TranscriptRecord = {
  payload?: RecordPayload;
  type?: string;
};

type TranscriptCall = {
  evalIds: number[];
  id: string;
  invocations: Invocation[];
  output?: RecordPayload;
  source: string;
  tools: string[];
  verifiable: boolean;
};

export type TranscriptScore = {
  astMcpOutputChars: number;
  errors: string[];
  evaluatedCases: number;
  execBatches: number;
  mutationCalls: number;
  passed: boolean;
  session: string;
  toolCalls: Record<string, number>;
  unscoredBatches: number;
  verifiedAssertions: number;
};

const directToolPrefix = "mcp__ast_mcp__";
const evalPattern = /ast-mcp-eval:(\d+)/g;

function inputText(input: unknown) {
  return typeof input === "string" ? input : JSON.stringify(input ?? {});
}

function messageText(content: unknown) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) =>
      item && typeof item === "object" && "text" in item
        ? String((item as { text?: unknown }).text ?? "")
        : "",
    )
    .join("\n");
}

function executableSource(source: string) {
  let state: "code" | "line" | "block" | "single" | "double" | "template" =
    "code";
  let escaped = false;
  let masked = "";
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (state === "line") {
      if (character === "\n") {
        state = "code";
        masked += character;
      } else masked += " ";
      continue;
    }
    if (state === "block") {
      if (character === "*" && next === "/") {
        masked += "  ";
        index += 1;
        state = "code";
      } else masked += character === "\n" ? "\n" : " ";
      continue;
    }
    if (state !== "code") {
      masked += character === "\n" ? "\n" : " ";
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (
        (state === "single" && character === "'") ||
        (state === "double" && character === '"') ||
        (state === "template" && character === "`")
      )
        state = "code";
      continue;
    }
    if (character === "/" && next === "/") {
      masked += "  ";
      index += 1;
      state = "line";
    } else if (character === "/" && next === "*") {
      masked += "  ";
      index += 1;
      state = "block";
    } else if (character === "'") {
      masked += " ";
      state = "single";
    } else if (character === '"') {
      masked += " ";
      state = "double";
    } else if (character === "`") {
      masked += " ";
      state = "template";
    } else masked += character;
  }
  return masked;
}
function isInsidePromiseAll(source: string, position: number) {
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

function extractExecInvocations(source: string) {
  const invocations: Array<Omit<Invocation, "index">> = [];
  const expression = /tools\.mcp__ast_mcp__(\w+)\s*\(/g;
  for (const match of executableSource(source).matchAll(expression)) {
    const open = (match.index ?? 0) + match[0].length - 1;
    let depth = 1;
    let quote = "";
    let escaped = false;
    let end = open + 1;
    for (; end < source.length && depth > 0; end += 1) {
      const character = source[end];
      if (quote) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === quote) quote = "";
        continue;
      }
      if (character === '"' || character === "'" || character === "`") {
        quote = character;
        continue;
      }
      if (character === "(") depth += 1;
      else if (character === ")") depth -= 1;
    }
    if (depth !== 0) continue;
    invocations.push({
      concurrent: isInsidePromiseAll(source, match.index ?? 0),
      input: source.slice(open + 1, end - 1).trim(),
      tool: match[1],
    });
  }
  return invocations;
}

function outputText(output: unknown) {
  const values = Array.isArray(output) ? output : [output];
  return values
    .map((value) => {
      if (typeof value === "string") return value;
      if (value && typeof value === "object" && "text" in value)
        return String((value as { text?: unknown }).text ?? "");
      return JSON.stringify(value ?? "");
    })
    .join("\n");
}

function outputFailed(payload: RecordPayload) {
  if (payload.isError) return true;
  const output = payload.output;
  if (!output || typeof output !== "object") return false;
  return (
    "isError" in output && (output as { isError?: unknown }).isError === true
  );
}

async function loadCases() {
  const directory = import.meta.dir;
  const [primary, fileHash, batch] = await Promise.all(
    ["evals.json", "file-hash.evals.json", "batch.evals.json"].map((file) =>
      readFile(path.join(directory, file), "utf8").then(JSON.parse),
    ),
  );
  return [
    ...(primary as { evals: EvalCase[] }).evals,
    ...(fileHash as EvalCase[]),
    ...(batch as EvalCase[]),
  ];
}

export async function scoreTranscript(
  sessionPath: string,
  strict = false,
): Promise<TranscriptScore> {
  const errors: string[] = [];
  const calls = new Map<string, TranscriptCall>();
  const knownCallIds = new Set<string>();
  const outputs = new Map<string, RecordPayload>();
  const roots = new Set<string>();
  const toolCalls: Record<string, number> = {};
  let invocationIndex = 0;
  let activeEvalIds: number[] = [];
  const lines = (await readFile(sessionPath, "utf8"))
    .split(String.fromCharCode(10))
    .filter(Boolean);

  for (const [index, line] of lines.entries()) {
    let record: TranscriptRecord;
    try {
      record = JSON.parse(line) as TranscriptRecord;
    } catch {
      errors.push(`line ${index + 1}: invalid JSON`);
      continue;
    }

    const payload = record.payload;
    if (record.type === "turn_context") {
      if (typeof payload?.cwd === "string")
        roots.add(path.resolve(payload.cwd));
      for (const root of payload?.workspace_roots ?? [])
        roots.add(path.resolve(root));
      continue;
    }
    if (
      record.type === "response_item" &&
      payload?.type === "message" &&
      payload.role === "user"
    ) {
      activeEvalIds = [
        ...new Set(
          [...messageText(payload.content).matchAll(evalPattern)].map((match) =>
            Number(match[1]),
          ),
        ),
      ];
      if (activeEvalIds.length > 1)
        errors.push(
          "user evaluation prompt carries multiple eval markers; evidence must be isolated per case",
        );
      continue;
    }

    if (
      record.type === "response_item" &&
      payload?.type === "custom_tool_call" &&
      typeof payload.call_id === "string" &&
      typeof payload.name === "string"
    ) {
      knownCallIds.add(payload.call_id);
      if (calls.has(payload.call_id)) {
        errors.push(`duplicate call ID: ${payload.call_id}`);
        continue;
      }
      const source = inputText(payload.input);
      const rawInvocations = payload.name.startsWith(directToolPrefix)
        ? [
            {
              input: source,
              tool: payload.name.slice(directToolPrefix.length),
            },
          ]
        : payload.name === "exec"
          ? extractExecInvocations(source)
          : [];
      if (rawInvocations.length === 0) continue;
      const invocations = rawInvocations.map((invocation) => ({
        ...invocation,
        index: invocationIndex++,
      }));
      const evalIds = [
        ...new Set([
          ...activeEvalIds,
          ...[...source.matchAll(evalPattern)].map((match) => Number(match[1])),
        ]),
      ];
      if (evalIds.length > 1)
        errors.push(
          `call ${payload.call_id} carries multiple eval markers; evidence must be isolated per case`,
        );
      calls.set(payload.call_id, {
        evalIds,
        id: payload.call_id,
        invocations,
        source,
        tools: invocations.map((invocation) => invocation.tool),
        verifiable: payload.name.startsWith(directToolPrefix),
      });
      continue;
    }

    if (
      record.type === "response_item" &&
      payload?.type === "custom_tool_call_output" &&
      typeof payload.call_id === "string"
    ) {
      if (outputs.has(payload.call_id))
        errors.push(`duplicate output ID: ${payload.call_id}`);
      else outputs.set(payload.call_id, payload);
    }
  }

  let outputChars = 0;
  for (const call of calls.values()) {
    const output = outputs.get(call.id);
    if (!output) {
      errors.push(`missing output for call ID: ${call.id}`);
      continue;
    }
    call.output = output;
    if (outputFailed(output)) errors.push(`failed call ID: ${call.id}`);
    const text = outputText(output.output);
    outputChars += text.length;
    if (call.tools.length > 0 && text.length === 0)
      errors.push(`empty output for ast-mcp call ID: ${call.id}`);
    for (const invocation of call.invocations)
      toolCalls[invocation.tool] = (toolCalls[invocation.tool] ?? 0) + 1;
  }

  for (const outputId of outputs.keys())
    if (!knownCallIds.has(outputId))
      errors.push(`unmatched output ID: ${outputId}`);

  const cases = new Map(
    (await loadCases()).map((evaluation) => [evaluation.id, evaluation]),
  );
  let evaluatedCases = 0;
  let unscoredBatches = 0;
  let verifiedAssertions = 0;
  const evaluations = new Map<number, TranscriptCall[]>();
  for (const call of calls.values()) {
    if (call.evalIds.length === 0) {
      unscoredBatches += 1;
      continue;
    }
    if (call.evalIds.length > 1) continue;
    for (const evalId of call.evalIds) {
      const evaluationCalls = evaluations.get(evalId) ?? [];
      evaluationCalls.push(call);
      evaluations.set(evalId, evaluationCalls);
    }
  }

  for (const [evalId, evaluationCalls] of evaluations) {
    evaluatedCases += 1;
    const evaluation = cases.get(evalId);
    if (!evaluation) {
      errors.push(`unknown eval ID: ${evalId}`);
      continue;
    }
    if (evaluationCalls.some((call) => !call.verifiable)) {
      errors.push(
        `eval ${evalId} uses nested exec evidence that cannot be bound to individual MCP results`,
      );
      continue;
    }
    const executionFailed = evaluationCalls.some(
      (call) => !call.output || outputFailed(call.output),
    );
    if (executionFailed)
      errors.push(`eval ${evalId} has no successful execution output`);
    const text = evaluationCalls
      .map((call) => outputText(call.output?.output))
      .join(String.fromCharCode(10));
    const invocations = evaluationCalls
      .flatMap((call) => call.invocations)
      .sort((left, right) => left.index - right.index);
    const semanticErrors = verifyEvaluation(evaluation, invocations, text, [
      ...roots,
    ]);
    for (const error of semanticErrors) errors.push(`eval ${evalId} ${error}`);
    if (!executionFailed && semanticErrors.length === 0)
      verifiedAssertions += evaluation.assertions.length;
  }

  if (strict && evaluatedCases === 0)
    errors.push("strict scoring requires at least one ast-mcp-eval marker");
  if (strict && evaluatedCases > 0)
    for (const evaluation of cases.values())
      if (!evaluations.has(evaluation.id))
        errors.push(
          `strict scoring requires complete evaluation matrix; missing eval ${evaluation.id}`,
        );

  const mutationCalls =
    (toolCalls.file_patch ?? 0) + (toolCalls.file_write ?? 0);
  return {
    astMcpOutputChars: outputChars,
    errors,
    evaluatedCases,
    execBatches: calls.size,
    mutationCalls,
    passed: errors.length === 0,
    session: sessionPath,
    toolCalls,
    unscoredBatches,
    verifiedAssertions,
  };
}
