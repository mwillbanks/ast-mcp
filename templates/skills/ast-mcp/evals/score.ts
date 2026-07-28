import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  type FileOperationPolicy,
  type Invocation,
  type EvalCase as SemanticEvalCase,
  verifyEvaluation,
} from "./semantic";
import { extractExecInvocations as extractExecInvocationsHelper } from "./source";

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

function extractExecInvocations(source: string) {
  return extractExecInvocationsHelper(source);
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

class TranscriptCollector {
  readonly calls = new Map<string, TranscriptCall>();
  readonly errors: string[] = [];
  readonly knownCallIds = new Set<string>();
  readonly outputs = new Map<string, RecordPayload>();
  readonly roots = new Set<string>();
  private activeEvalIds: number[] = [];
  private invocationIndex = 0;

  processLine(line: string, index: number) {
    let record: TranscriptRecord;
    try {
      record = JSON.parse(line) as TranscriptRecord;
    } catch {
      this.errors.push(`line ${index + 1}: invalid JSON`);
      return;
    }
    this.processRecord(record);
  }

  private processRecord(record: TranscriptRecord) {
    const payload = record.payload ?? {};
    if (record.type === "turn_context") return this.recordRoots(payload);
    if (record.type !== "response_item") return;
    responseRecordHandlers[payload.type ?? ""]?.(this, payload);
  }

  recordRoots(payload: RecordPayload) {
    if (typeof payload.cwd === "string")
      this.roots.add(path.resolve(payload.cwd));
    for (const root of payload.workspace_roots ?? [])
      this.roots.add(path.resolve(root));
  }

  recordMessage(payload: RecordPayload) {
    if (payload.role !== "user") return;
    this.activeEvalIds = markerIds(messageText(payload.content));
    this.validateIsolated(this.activeEvalIds, "user evaluation prompt");
  }

  recordCall(payload: RecordPayload) {
    if (typeof payload.call_id !== "string" || typeof payload.name !== "string")
      return;
    this.knownCallIds.add(payload.call_id);
    if (this.calls.has(payload.call_id)) {
      this.errors.push(`duplicate call ID: ${payload.call_id}`);
      return;
    }
    const source = inputText(payload.input);
    const rawInvocations = invocationsFor(payload.name, source);
    if (rawInvocations.length === 0) return;
    const invocations = rawInvocations.map((invocation) => ({
      ...invocation,
      index: this.invocationIndex++,
    }));
    const evalIds = markerIds(source, this.activeEvalIds);
    this.validateIsolated(evalIds, `call ${payload.call_id}`);
    this.calls.set(payload.call_id, {
      evalIds,
      id: payload.call_id,
      invocations,
      source,
      tools: invocations.map((invocation) => invocation.tool),
      verifiable: payload.name.startsWith(directToolPrefix),
    });
  }

  recordOutput(payload: RecordPayload) {
    if (typeof payload.call_id !== "string") return;
    if (this.outputs.has(payload.call_id))
      this.errors.push(`duplicate output ID: ${payload.call_id}`);
    else this.outputs.set(payload.call_id, payload);
  }

  private validateIsolated(evalIds: number[], source: string) {
    if (evalIds.length > 1)
      this.errors.push(
        `${source} carries multiple eval markers; evidence must be isolated per case`,
      );
  }
}

type ResponseRecordHandler = (
  collector: TranscriptCollector,
  payload: RecordPayload,
) => void;

const responseRecordHandlers: Record<string, ResponseRecordHandler> = {
  custom_tool_call: (collector, payload) => collector.recordCall(payload),
  custom_tool_call_output: (collector, payload) =>
    collector.recordOutput(payload),
  message: (collector, payload) => collector.recordMessage(payload),
};

function markerIds(source: string, initial: number[] = []) {
  return [
    ...new Set([
      ...initial,
      ...[...source.matchAll(evalPattern)].map((match) => Number(match[1])),
    ]),
  ];
}

function invocationsFor(name: string, source: string) {
  if (name.startsWith(directToolPrefix))
    return [{ input: source, tool: name.slice(directToolPrefix.length) }];
  if (name === "exec") return extractExecInvocations(source);
  return [];
}

async function collectTranscript(sessionPath: string) {
  const collector = new TranscriptCollector();
  const lines = (await readFile(sessionPath, "utf8"))
    .split(String.fromCharCode(10))
    .filter(Boolean);
  for (const [index, line] of lines.entries())
    collector.processLine(line, index);
  return collector;
}

function acceptedRenameFailure(
  call: TranscriptCall,
  evaluationId?: number,
  assertions: string[] = [],
) {
  if (!call.output || !outputFailed(call.output)) return false;
  if (!(evaluationId === 92 || call.evalIds.includes(92))) return false;
  if (
    !assertions.some((assertion) =>
      /does not overwrite|existing destination/i.test(assertion),
    ) &&
    evaluationId !== undefined
  )
    return false;
  if (!call.invocations.some((invocation) => invocation.tool === "file_rename"))
    return false;
  return /destination.*exist|already exists/i.test(
    outputText(call.output.output),
  );
}

function validateCallOutput(
  call: TranscriptCall,
  output: RecordPayload,
  errors: string[],
) {
  if (outputFailed(output) && !acceptedRenameFailure({ ...call, output }))
    errors.push(`failed call ID: ${call.id}`);
  const text = outputText(output.output);
  if (call.tools.length > 0 && text.length === 0)
    errors.push(`empty output for ast-mcp call ID: ${call.id}`);
  return text.length;
}

function countTools(call: TranscriptCall, toolCalls: Record<string, number>) {
  for (const invocation of call.invocations)
    toolCalls[invocation.tool] = (toolCalls[invocation.tool] ?? 0) + 1;
}

function bindOutputs(
  collector: TranscriptCollector,
  toolCalls: Record<string, number>,
) {
  let outputChars = 0;
  for (const call of collector.calls.values()) {
    const output = collector.outputs.get(call.id);
    if (!output) {
      collector.errors.push(`missing output for call ID: ${call.id}`);
      continue;
    }
    call.output = output;
    outputChars += validateCallOutput(call, output, collector.errors);
    countTools(call, toolCalls);
  }
  for (const outputId of collector.outputs.keys()) {
    if (!collector.knownCallIds.has(outputId))
      collector.errors.push(`unmatched output ID: ${outputId}`);
  }
  return outputChars;
}

interface GroupedEvaluations {
  evaluations: Map<number, TranscriptCall[]>;
  unscoredBatches: number;
}

function groupEvaluations(
  calls: Map<string, TranscriptCall>,
): GroupedEvaluations {
  const evaluations = new Map<number, TranscriptCall[]>();
  let unscoredBatches = 0;
  for (const call of calls.values()) {
    if (call.evalIds.length === 0) {
      unscoredBatches += 1;
      continue;
    }
    if (call.evalIds.length !== 1) continue;
    const evalId = call.evalIds[0] ?? 0;
    const evaluationCalls = evaluations.get(evalId) ?? [];
    evaluationCalls.push(call);
    evaluations.set(evalId, evaluationCalls);
  }
  return { evaluations, unscoredBatches };
}

function callExecutionFailed(call: TranscriptCall, evaluation: EvalCase) {
  if (!call.output) return true;
  if (!outputFailed(call.output)) return false;
  return !acceptedRenameFailure(call, evaluation.id, evaluation.assertions);
}

function evaluationText(calls: TranscriptCall[]) {
  return calls
    .map((call) => outputText(call.output?.output))
    .join(String.fromCharCode(10));
}

function evaluationInvocations(calls: TranscriptCall[]) {
  return calls
    .flatMap((call) => call.invocations)
    .sort((left, right) => left.index - right.index);
}

interface EvaluationResult {
  evaluatedCases: number;
  verifiedAssertions: number;
}

function evaluateCase(
  evalId: number,
  calls: TranscriptCall[],
  evaluation: EvalCase | undefined,
  roots: string[],
  fileOperationPolicy: FileOperationPolicy,
  errors: string[],
) {
  if (!evaluation) {
    errors.push(`unknown eval ID: ${evalId}`);
    return 0;
  }
  if (calls.some((call) => !call.verifiable)) {
    errors.push(
      `eval ${evalId} uses nested exec evidence that cannot be bound to individual MCP results`,
    );
    return 0;
  }
  const executionFailed = calls.some((call) =>
    callExecutionFailed(call, evaluation),
  );
  if (executionFailed)
    errors.push(`eval ${evalId} has no successful execution output`);
  const semanticErrors = verifyEvaluation(
    evaluation,
    evaluationInvocations(calls),
    evaluationText(calls),
    roots,
    fileOperationPolicy,
  );
  for (const error of semanticErrors) errors.push(`eval ${evalId} ${error}`);
  return !executionFailed && semanticErrors.length === 0
    ? evaluation.assertions.length
    : 0;
}

function evaluateGroups(
  grouped: GroupedEvaluations,
  cases: Map<number, EvalCase>,
  roots: string[],
  fileOperationPolicy: FileOperationPolicy,
  errors: string[],
): EvaluationResult {
  let evaluatedCases = 0;
  let verifiedAssertions = 0;
  for (const [evalId, calls] of grouped.evaluations) {
    evaluatedCases += 1;
    verifiedAssertions += evaluateCase(
      evalId,
      calls,
      cases.get(evalId),
      roots,
      fileOperationPolicy,
      errors,
    );
  }
  return { evaluatedCases, verifiedAssertions };
}

function validateStrictMatrix(
  strict: boolean,
  result: EvaluationResult,
  cases: Map<number, EvalCase>,
  evaluations: Map<number, TranscriptCall[]>,
  errors: string[],
) {
  if (!strict) return;
  if (result.evaluatedCases === 0) {
    errors.push("strict scoring requires at least one ast-mcp-eval marker");
    return;
  }
  for (const evaluation of cases.values()) {
    if (!evaluations.has(evaluation.id))
      errors.push(
        `strict scoring requires complete evaluation matrix; missing eval ${evaluation.id}`,
      );
  }
}

export async function scoreTranscript(
  sessionPath: string,
  strict = false,
  fileOperationPolicy: FileOperationPolicy = {},
): Promise<TranscriptScore> {
  const collector = await collectTranscript(sessionPath);
  const toolCalls: Record<string, number> = {};
  const outputChars = bindOutputs(collector, toolCalls);
  const cases = new Map(
    (await loadCases()).map((evaluation) => [evaluation.id, evaluation]),
  );
  const grouped = groupEvaluations(collector.calls);
  const result = evaluateGroups(
    grouped,
    cases,
    [...collector.roots],
    fileOperationPolicy,
    collector.errors,
  );
  validateStrictMatrix(
    strict,
    result,
    cases,
    grouped.evaluations,
    collector.errors,
  );
  const mutationCalls =
    (toolCalls.file_patch ?? 0) +
    (toolCalls.file_write ?? 0) +
    (toolCalls.file_rename ?? 0);
  return {
    astMcpOutputChars: outputChars,
    errors: collector.errors,
    evaluatedCases: result.evaluatedCases,
    execBatches: collector.calls.size,
    mutationCalls,
    passed: collector.errors.length === 0,
    session: sessionPath,
    toolCalls,
    unscoredBatches: grouped.unscoredBatches,
    verifiedAssertions: result.verifiedAssertions,
  };
}
