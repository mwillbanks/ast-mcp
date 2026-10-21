import {
  parseSource,
  type ParserLanguageId,
} from "../intelligence/parser/index.ts";
import {
  computeNative,
  type CompilerAlias,
  type NativeFile,
} from "./code-intelligence-compute.ts";
import type { ToolInput, ToolName } from "./code-intelligence.ts";
export type CpuJob =
  | { kind: "compiler-config"; source: string }
  | { kind: "parse"; languageId: ParserLanguageId; source: string }
  | {
      kind: "compute";
      name: ToolName;
      input: ToolInput;
      files: NativeFile[];
      root: string;
      aliases: CompilerAlias[];
    };
export type CpuReply =
  | { ok: true; value: unknown; bytes: number }
  | { ok: false; error: { message: string; code: string; retryable: boolean } };
const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent<CpuJob>) => Promise<void>;
  postMessage(reply: CpuReply): void;
};
scope.onmessage = async ({ data }) => {
  try {
    const value =
      data.kind === "compiler-config"
        ? Bun.JSONC.parse(data.source)
        : data.kind === "parse"
          ? parseSource({
              languageId: data.languageId,
              source: data.source,
              maxNodes: 100_000,
            })
          : await computeNative(
              data.name,
              data.input,
              data.files,
              data.root,
              data.aliases,
            );
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (bytes > 16 * 1024 * 1024)
      throw Object.assign(
        new Error(
          "Parsed data exceeds the request byte limit; narrow paths, glob, or scan_limit",
        ),
        { code: "intelligence_budget_exceeded", retryable: true },
      );
    scope.postMessage({ ok: true, value, bytes });
  } catch (error) {
    const typed = error as {
      code?: string;
      message?: string;
      retryable?: boolean;
    };
    scope.postMessage({
      ok: false,
      error: {
        code: typed.code ?? "worker_error",
        message: typed.message ?? "Code intelligence worker failed",
        retryable: typed.retryable ?? false,
      },
    });
  }
};
