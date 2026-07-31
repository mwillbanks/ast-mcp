import type {
  FileCapabilities,
  PatchStrategyName,
} from "../runtime/file-capabilities";
import { aiderBlockStrategy } from "./strategy/aiderBlock";
import { astStrategy } from "./strategy/ast";

export interface AstRule {
  expectedMatches?: number;
  fix: string;
  pattern: string;
}

export interface AiderBlock {
  replace: string;
  search: string;
}

export interface PatchStrategyContext {
  aiderBlocks: AiderBlock[];
  astRules: AstRule[];
  capabilities: FileCapabilities;
  filePath: string;
  language?: string;
  mode: number;
  original: string;
}

export interface PatchStrategyMetadata {
  engine?: string;
  matches?: number;
  matchMethods?: string[];
  operations: number;
  strategy: PatchStrategyName;
}

export interface PreparedStrategyPatch {
  candidate: string;
  metadata: PatchStrategyMetadata;
}

export interface PatchStrategyAdapter {
  readonly name: PatchStrategyName;
  prepare(context: PatchStrategyContext): Promise<PreparedStrategyPatch>;
}

const adapters: Record<PatchStrategyName, PatchStrategyAdapter> = {
  aider_block: aiderBlockStrategy,
  ast: astStrategy,
};

export function patchStrategyAdapter(
  strategy: PatchStrategyName | undefined,
): PatchStrategyAdapter {
  if (!strategy)
    throw Object.assign(new Error("patchStrategy is required"), {
      code: "patch_strategy_required",
      retryable: true,
    });
  return adapters[strategy];
}
