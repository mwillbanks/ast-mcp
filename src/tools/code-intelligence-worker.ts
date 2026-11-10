import {
  parseSource,
  type ParserLanguageId,
} from "../intelligence/parser/index.ts";
import type { NativeGrammarSet } from "../intelligence/parser/native-pack-selection.ts";
import { initializeNativePackRegistry } from "../intelligence/parser/registry.ts";
import {
  computeNative,
  type CompilerAlias,
  type NativeFile,
} from "./code-intelligence-compute.ts";
import type { ToolInput, ToolName } from "./code-intelligence.ts";
export type CpuJob =
  | { kind: "compiler-config"; source: string }
  | {
      kind: "parse";
      languageId: ParserLanguageId;
      source: string;
      maxReplyBytes?: number;
    }
  | {
      kind: "compute";
      name: ToolName;
      input: ToolInput;
      files: NativeFile[];
      root: string;
      aliases: CompilerAlias[];
      scanExhaustive?: boolean;
    };
export type CpuReply =
  | { ok: true; value: unknown; bytes: number }
  | { ok: false; error: { message: string; code: string; retryable: boolean } };
const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent<CpuJob>) => Promise<void>;
  postMessage(reply: CpuReply): void;
};
type NativeCpuJob = CpuJob & { packs?: NativeGrammarSet };
let grammarIdentity: string | undefined;

async function execute(data: NativeCpuJob, reply: (value: CpuReply) => void) {
  try {
    if (data.packs && grammarIdentity === undefined) {
      await initializeNativePackRegistry(data.packs);
      grammarIdentity = data.packs.identity;
    }
    if (data.packs?.identity !== grammarIdentity)
      throw new TypeError("Native code intelligence grammar set changed");
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
              undefined,
              data.scanExhaustive,
            );
    const bytes = Buffer.byteLength(JSON.stringify(value));
    const maxBytes =
      data.kind === "parse"
        ? (data.maxReplyBytes ?? 16 * 1024 * 1024)
        : 16 * 1024 * 1024;
    if (bytes > maxBytes)
      throw Object.assign(
        new Error(
          "Parsed data exceeds the request byte limit; narrow paths, glob, or scan_limit",
        ),
        { code: "intelligence_budget_exceeded", retryable: true },
      );
    reply({ ok: true, value, bytes });
  } catch (error) {
    const typed = error as {
      code?: string;
      message?: string;
      retryable?: boolean;
    };
    reply({
      ok: false,
      error: {
        code: typed.code ?? "worker_error",
        message: typed.message ?? "Code intelligence worker failed",
        retryable: typed.retryable ?? false,
      },
    });
  }
}

if (typeof process.send === "function") {
  process.on("message", (message) => {
    void execute(message as NativeCpuJob, (reply) => process.send?.(reply));
  });
} else {
  scope.onmessage = ({ data }) =>
    execute(data, (reply) => scope.postMessage(reply));
}
