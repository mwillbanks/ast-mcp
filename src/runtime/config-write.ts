import { currentConfig, type ResolvedConfig } from "../config";
import {
  addPathTable,
  existingPathPolicies,
  pathTableIds,
  readConfigSource,
  removePathTable,
  setTomlSectionKey,
  type TomlValue,
  updatePathTable,
  writeConfigSource,
} from "../config-edit";
import { configRegistry } from "../config-registry";
import { withFileLocks } from "./locks";
import { assertPolicy, evaluatePolicy, PathPolicyError } from "./path-policy";

export type ConfigTarget = "global" | "project";

export interface ConfigCorePatch {
  dependencies?: {
    ast_bro_binary?: string;
    dprint_binary?: string;
  };
  files?: {
    patch?: {
      aider_matchers?: Array<
        "diff-match-patch" | "exact" | "relative-indentation" | "whitespace"
      >;
      strategies?: Array<"aider_block" | "ast">;
    };
    read?: { modes?: Array<"ast" | "text"> };
  };
  formatting?: {
    dprint_config?: string;
    enabled?: boolean;
    fallback?: "dprint" | "preserve" | "reject";
  };
  http?: {
    host?: string;
    port?: number;
    session_sweep_interval_ms?: number;
    session_timeout_ms?: number;
  };
  mcp?: { configuration?: { enabled?: boolean; require_approval?: boolean } };
  safety?: {
    hook?: {
      allow_tools?: string[];
      block_tools?: string[];
      enabled?: boolean;
    };
    require_hash?: boolean;
  };
  target?: ConfigTarget;
  workspace?: {
    roots?: string[];
    worktrees?: "ignore" | "include" | "request";
  };
}

export interface ConfigPathRulePatch {
  excludes?: string[];
  follow_symlinks?: boolean;
  includes?: string[];
  path?: string;
  policies?: {
    delete?: "allow" | "deny" | "request";
    read?: "allow" | "deny" | "request";
    write?: "allow" | "deny" | "request";
  };
}

export type ConfigPathOperation =
  | {
      op: "add";
      rule: ConfigPathRulePatch & {
        id: string;
        path: string;
        policies: {
          read: "allow" | "deny" | "request";
          write: "allow" | "deny" | "request";
        };
      };
    }
  | { id: string; op: "remove" }
  | { id: string; op: "update"; rule: ConfigPathRulePatch };

export interface ConfigPathsPatch {
  operations: ConfigPathOperation[];
  target?: ConfigTarget;
}

function configurationError(
  code: string,
  message: string,
  suggestedNextCall?: string,
): Error {
  return Object.assign(new Error(message), {
    code,
    retryable: true,
    suggestedNextCall,
  });
}

async function targetFilePath(target: ConfigTarget) {
  const config = await currentConfig();
  const filePath =
    target === "global" ? config.sources.global : config.sources.project;
  if (!filePath)
    throw configurationError(
      "configuration_missing",
      `No ${target} ast-mcp.toml exists; create version 2 configuration first`,
      "ast-mcp config migrate",
    );
  return { config, filePath };
}

async function loadTarget(target: ConfigTarget = "project") {
  const { config, filePath } = await targetFilePath(target);
  const source = await readConfigSource(filePath);
  const parsed = Bun.TOML.parse(source) as { version?: unknown };
  if (parsed.version !== 2)
    throw configurationError(
      "configuration_migration_required",
      `${filePath} is not version 2; run ast-mcp config migrate before MCP configuration edits`,
      "ast-mcp config migrate",
    );
  return { config, filePath, source };
}

function authorizeConfigWrite(
  config: ResolvedConfig,
  filePath: string,
  touchesMcpConfiguration: boolean,
): void {
  if (!config.mcp.configuration.enabled)
    throw configurationError(
      "configuration_mcp_disabled",
      "MCP configuration tools are disabled (mcp.configuration.enabled = false)",
      "config_status",
    );
  const decision = evaluatePolicy(config, filePath, "write");
  if (decision.policy === "deny") throw new PathPolicyError(decision);
  const required =
    config.mcp.configuration.requireApproval || touchesMcpConfiguration;
  if (!required) return;
  assertPolicy(
    {
      ...decision,
      policy: "request",
      reason: "MCP configuration change requires approval",
    },
    config.generation,
  );
}

function compactEntries(
  value: Record<string, unknown> | undefined,
): Array<[string, TomlValue]> {
  if (!value) return [];
  return Object.entries(value).filter(
    (entry): entry is [string, TomlValue] => entry[1] !== undefined,
  );
}

function applyObjectKeys(
  source: string,
  header: string,
  value: Record<string, unknown> | undefined,
): string {
  let next = source;
  for (const [key, item] of compactEntries(value))
    next = setTomlSectionKey(next, header, key, item);
  return next;
}

function applyConfigCorePatch(source: string, patch: ConfigCorePatch): string {
  let next = source;
  next = applyObjectKeys(next, "workspace", patch.workspace);
  next = applyObjectKeys(next, "safety", {
    require_hash: patch.safety?.require_hash,
  });
  next = applyObjectKeys(next, "safety.hook", patch.safety?.hook);
  next = applyObjectKeys(next, "files.read", patch.files?.read);
  next = applyObjectKeys(next, "files.patch", patch.files?.patch);
  next = applyObjectKeys(next, "formatting", {
    dprint_config: patch.formatting?.dprint_config,
    enabled: patch.formatting?.enabled,
    fallback: patch.formatting?.fallback,
  });
  next = applyObjectKeys(next, "http", patch.http);
  next = applyObjectKeys(next, "dependencies", patch.dependencies);
  next = applyObjectKeys(next, "mcp.configuration", patch.mcp?.configuration);
  return next;
}

function pathRuleRecord(
  rule: ConfigPathRulePatch & { id?: string },
): Record<string, TomlValue> {
  const record: Record<string, TomlValue> = {};
  if (rule.id) record.id = rule.id;
  if (rule.path) record.path = rule.path;
  if (rule.policies) record.policies = rule.policies;
  if (rule.follow_symlinks !== undefined)
    record.follow_symlinks = rule.follow_symlinks;
  if (rule.includes) record.includes = rule.includes;
  if (rule.excludes) record.excludes = rule.excludes;
  return record;
}

function applyConfigPathOperations(
  source: string,
  operations: ConfigPathOperation[],
): string {
  let next = source;
  const ids = new Set(pathTableIds(next));
  for (const operation of operations) {
    if (operation.op === "add") {
      if (ids.has(operation.rule.id))
        throw configurationError(
          "configuration_path_duplicate",
          `A [[paths]] rule with id ${operation.rule.id} already exists`,
        );
      next = addPathTable(next, pathRuleRecord(operation.rule));
      ids.add(operation.rule.id);
      continue;
    }
    if (operation.op === "remove") {
      next = removePathTable(next, operation.id);
      ids.delete(operation.id);
      continue;
    }
    const record = pathRuleRecord(operation.rule);
    if (operation.rule.policies)
      record.policies = {
        ...existingPathPolicies(next, operation.id),
        ...operation.rule.policies,
      };
    next = updatePathTable(next, operation.id, record);
  }
  return next;
}

async function commitConfigEdit(
  target: ConfigTarget,
  filePath: string,
  source: string,
  changed: string[],
) {
  const current = await currentConfig();
  await writeConfigSource(filePath, source);
  const snapshots = await configRegistry.reload();
  const snapshot =
    snapshots.find(
      (item) =>
        item.config?.projectRoot === current.projectRoot ||
        item.config?.sources.project === filePath ||
        item.config?.sources.global === filePath,
    ) ?? (await configRegistry.snapshot({ cwd: current.projectRoot }));
  return {
    changed,
    filePath,
    generation: snapshot.generation,
    healthy: snapshot.healthy,
    target,
  };
}

function coreSectionChanges(patch: ConfigCorePatch): string[] {
  return [
    patch.workspace ? "workspace" : undefined,
    patch.safety ? "safety" : undefined,
    patch.files ? "files" : undefined,
    patch.formatting ? "formatting" : undefined,
    patch.http ? "http" : undefined,
    patch.dependencies ? "dependencies" : undefined,
    patch.mcp ? "mcp.configuration" : undefined,
  ].filter((item): item is string => Boolean(item));
}

async function editConfigCore(target: ConfigTarget, patch: ConfigCorePatch) {
  const loaded = await loadTarget(target);
  const changed = coreSectionChanges(patch);
  if (changed.length === 0)
    throw configurationError(
      "configuration_empty_patch",
      "config_core requires at least one core section",
    );
  authorizeConfigWrite(
    loaded.config,
    loaded.filePath,
    patch.mcp?.configuration?.enabled !== undefined ||
      patch.mcp?.configuration?.require_approval !== undefined,
  );
  return commitConfigEdit(
    target,
    loaded.filePath,
    applyConfigCorePatch(loaded.source, patch),
    changed,
  );
}

async function editConfigPaths(target: ConfigTarget, patch: ConfigPathsPatch) {
  const loaded = await loadTarget(target);
  authorizeConfigWrite(loaded.config, loaded.filePath, false);
  return commitConfigEdit(
    target,
    loaded.filePath,
    applyConfigPathOperations(loaded.source, patch.operations),
    patch.operations.map((operation) =>
      operation.op === "add"
        ? `paths.add:${operation.rule.id}`
        : `paths.${operation.op}:${operation.id}`,
    ),
  );
}

export async function applyConfigCore(patch: ConfigCorePatch) {
  const target = patch.target ?? "project";
  const { filePath } = await targetFilePath(target);
  return withFileLocks([filePath], () => editConfigCore(target, patch));
}

export async function applyConfigPaths(patch: ConfigPathsPatch) {
  const target = patch.target ?? "project";
  const { filePath } = await targetFilePath(target);
  return withFileLocks([filePath], () => editConfigPaths(target, patch));
}
