import type { InfraLanguageId } from "../infra/types.ts";
import type { JvmLanguageId } from "../jvm/types.ts";
import type { SystemsLanguageId } from "../systems/types.ts";

export type MainstreamLanguageId =
  | "apex"
  | "c"
  | "cpp"
  | "csharp"
  | "dart"
  | "go"
  | "groovy"
  | "java"
  | "kotlin"
  | "objc"
  | "rust"
  | "scala"
  | "swift"
  | "zig";

export interface WorkerStartMessage<LanguageId extends string> {
  id: number;
  languageId: LanguageId;
  source: string;
  type: "start";
}

interface WorkerCancelMessage {
  id: number;
  type: "cancel";
}

export type WorkerMessage<LanguageId extends string> =
  | WorkerStartMessage<LanguageId>
  | WorkerCancelMessage;

export type MainstreamWorkerStartMessage<
  LanguageId extends MainstreamLanguageId,
> = WorkerStartMessage<LanguageId>;

export type MainstreamWorkerMessage<LanguageId extends MainstreamLanguageId> =
  WorkerMessage<LanguageId>;

export type InfraWorkerStartMessage = WorkerStartMessage<InfraLanguageId>;

export function positiveRequestId(value: unknown): number | null {
  if (!value || typeof value !== "object") return null;
  const id = (value as Record<string, unknown>).id;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0
    ? id
    : null;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function createWorkerRequestValidator<LanguageId extends string>(options: {
  family: "Infrastructure" | "JVM" | "SYSTEMS";
  idError: string;
  languages: ReadonlySet<LanguageId>;
}): (value: unknown) => WorkerMessage<LanguageId> {
  return (value) => {
    if (!value || typeof value !== "object") {
      throw new TypeError(`${options.family} worker request must be an object`);
    }
    const request = value as Record<string, unknown>;
    const id = positiveRequestId(request);
    if (id === null) {
      throw new TypeError(options.idError);
    }
    if (request.type === "cancel") {
      if (!exactKeys(request, ["id", "type"])) {
        throw new TypeError(
          `${options.family} cancel request contains invalid fields`,
        );
      }
      return { id, type: "cancel" };
    }
    if (request.type !== "start") {
      throw new TypeError(`${options.family} worker request type is invalid`);
    }
    if (!exactKeys(request, ["id", "languageId", "source", "type"])) {
      throw new TypeError(
        `${options.family} start request contains invalid fields`,
      );
    }
    if (
      typeof request.languageId !== "string" ||
      !options.languages.has(request.languageId as LanguageId)
    ) {
      throw new TypeError(
        `${options.family} start request language is invalid`,
      );
    }
    if (typeof request.source !== "string") {
      throw new TypeError(
        `${options.family} start request source must be a string`,
      );
    }
    return {
      id,
      languageId: request.languageId as LanguageId,
      source: request.source,
      type: "start",
    };
  };
}

const infraLanguages = new Set<InfraLanguageId>([
  "bash",
  "powershell",
  "sql",
  "hcl",
  "fortran",
  "verilog",
  "systemverilog",
]);
const jvmLanguages = new Set<JvmLanguageId>([
  "apex",
  "csharp",
  "groovy",
  "java",
  "kotlin",
  "scala",
]);
const systemsLanguages = new Set<SystemsLanguageId>([
  "c",
  "cpp",
  "objc",
  "swift",
  "rust",
  "go",
  "zig",
  "dart",
]);

export const validateInfraWorkerRequest = createWorkerRequestValidator({
  family: "Infrastructure",
  idError: "Infrastructure worker request id must be a safe positive integer",
  languages: infraLanguages,
});

export const validateJvmWorkerRequest = createWorkerRequestValidator({
  family: "JVM",
  idError: "JVM worker request id must be positive",
  languages: jvmLanguages,
});

export const validateSystemsWorkerRequest = createWorkerRequestValidator({
  family: "SYSTEMS",
  idError: "SYSTEMS worker request id must be positive",
  languages: systemsLanguages,
});
