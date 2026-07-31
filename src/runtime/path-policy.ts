import { realpathSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ResolvedConfig } from "../config";
import type { PathPolicy } from "../config-v2-schema";
import { authorizeRequestedDecision } from "./approval";
import {
  canonicalizePath,
  effectiveWorkspaceRoot,
  pathWithin,
} from "./path-utils";

export type PathOperation = "read" | "write" | "delete";

export interface PolicyDecision {
  canonicalPath: string;
  operation: PathOperation;
  policy: PathPolicy;
  reason: string;
  ruleId?: string;
  source: "baseline" | "configuration" | "global" | "project";
  specificity: number;
  symlinks: boolean;
}

const precedence: Record<PathPolicy, number> = {
  allow: 0,
  deny: 2,
  request: 1,
};
const temporaryRoot = (() => {
  try {
    return realpathSync.native(os.tmpdir());
  } catch {
    return path.resolve(os.tmpdir());
  }
})();

async function canonicalPolicyPath(targetPath: string): Promise<string> {
  const absolute = path.resolve(targetPath);
  return path.join(
    await canonicalizePath(path.dirname(absolute)),
    path.basename(absolute),
  );
}

function within(root: string, target: string): boolean {
  return pathWithin(root, target);
}

function literalPrefix(glob: string): number {
  const wildcard = glob.search(/[?*[{]/);
  return (wildcard < 0 ? glob : glob.slice(0, wildcard)).length;
}

function matchingIncludes(relative: string, includes: string[]): string[] {
  if (relative === "") return [];
  const unix = relative.split(path.sep).join("/");
  return includes.filter((glob) => new Bun.Glob(glob).match(unix));
}

function matches(
  relative: string,
  includes: string[],
  excludes: string[],
): boolean {
  const unix = relative.split(path.sep).join("/") || ".";
  const selectorMatches = (glob: string) => {
    if (new Bun.Glob(glob).match(unix)) return true;
    const recursiveRoot = recursiveSelectorPath(glob);
    return (
      recursiveRoot !== undefined &&
      (recursiveRoot === "" || new Bun.Glob(recursiveRoot).match(unix))
    );
  };
  if (excludes.some(selectorMatches)) return false;
  return relative === "" || includes.some(selectorMatches);
}

function protectedConfiguration(
  config: ResolvedConfig,
  target: string,
  platform: NodeJS.Platform,
): boolean {
  const normalizedTarget = platform === "win32" ? target.toLowerCase() : target;
  return [config.sources.global, config.sources.project]
    .filter((item): item is string => Boolean(item))
    .some((item) => {
      const candidate = path.resolve(item);
      return (
        (platform === "win32" ? candidate.toLowerCase() : candidate) ===
        normalizedTarget
      );
    });
}

export function evaluatePolicy(
  config: ResolvedConfig,
  targetPath: string,
  operation: PathOperation,
  platform: NodeJS.Platform = process.platform,
): PolicyDecision {
  const canonicalPath = path.resolve(targetPath);
  if (
    operation !== "read" &&
    protectedConfiguration(config, canonicalPath, platform)
  )
    return {
      canonicalPath,
      operation,
      policy: "request",
      reason: "Active configuration files are protected targets",
      source: "configuration",
      specificity: Number.MAX_SAFE_INTEGER,
      symlinks: false,
    };

  const candidates = (config.paths ?? []).flatMap((rule) => {
    const anchor = path.resolve(rule.path);
    if (!within(anchor, canonicalPath)) return [];
    const relative = path.relative(anchor, canonicalPath);
    if (relative !== "" && !matches(relative, rule.includes, rule.excludes))
      return [];
    const exact = canonicalPath === anchor ? 1_000_000 : 0;
    const depth = anchor.split(path.sep).length * 10_000;
    const includeSpecificity = Math.max(
      ...matchingIncludes(relative, rule.includes).map(literalPrefix),
      0,
    );
    return [
      {
        canonicalPath,
        operation,
        policy: rule.policies[operation],
        reason: `Matched paths rule ${rule.id}`,
        ruleId: rule.id,
        source: rule.source,
        specificity: exact + depth + includeSpecificity,
        symlinks: rule.followSymlinks,
      } satisfies PolicyDecision,
    ];
  });

  candidates.sort(
    (left, right) =>
      right.specificity - left.specificity ||
      precedence[right.policy] - precedence[left.policy],
  );
  const winner = candidates[0];
  if (winner) {
    const withinBaseline = config.trustedRoots.some((root) =>
      within(root, canonicalPath),
    );
    if (
      winner.policy === "allow" &&
      !withinBaseline &&
      winner.source === "project"
    )
      return {
        ...winner,
        policy: "request",
        reason: `${winner.reason}; project access beyond the host baseline requires approval`,
      };
    return winner;
  }

  if (
    config.version === 1 &&
    config.safety.allowTempDirectory &&
    within(temporaryRoot, canonicalPath)
  )
    return {
      canonicalPath,
      operation,
      policy: "allow",
      reason: "Legacy safety.allow_temp_directory",
      source: "baseline",
      specificity: 0,
      symlinks: config.safety.followSymlinks,
    };
  if (config.version === 1 && config.safety.allowAnyPath)
    return {
      canonicalPath,
      operation,
      policy: "allow",
      reason: "Legacy safety.allow_any_path",
      source: "baseline",
      specificity: 0,
      symlinks: config.safety.followSymlinks,
    };
  const inBaseline = config.trustedRoots.some((root) =>
    within(root, canonicalPath),
  );
  return {
    canonicalPath,
    operation,
    policy: inBaseline ? "allow" : "deny",
    reason: inBaseline
      ? "Path is within the host baseline"
      : "No explicit rule matches outside the host baseline",
    source: "baseline",
    specificity: 0,
    symlinks: config.version === 1 && config.safety.followSymlinks,
  };
}

function symlinkDenied(
  decision: PolicyDecision,
  target: string,
): PolicyDecision {
  return {
    ...decision,
    canonicalPath: target,
    policy: "deny",
    reason: `${decision.reason}; the winning rule does not permit symbolic links`,
  };
}

export async function evaluatePolicyForCheck(
  config: ResolvedConfig,
  targetPath: string,
  operation: PathOperation,
): Promise<PolicyDecision> {
  const workspaceRoots = await Promise.all(
    config.workspace.roots.map(canonicalizePath),
  );
  const base = effectiveWorkspaceRoot(
    await canonicalizePath(config.projectRoot),
    workspaceRoots,
  );
  const inputPath = path.isAbsolute(targetPath)
    ? targetPath
    : path.resolve(base, targetPath);
  const linkPath = await canonicalPolicyPath(inputPath);
  const linkDecision = evaluatePolicy(config, linkPath, operation);
  const metadata = await lstat(linkPath).catch(() => undefined);
  if (!metadata?.isSymbolicLink()) return linkDecision;
  if (linkDecision.policy !== "allow") return linkDecision;
  if (!linkDecision.symlinks) return symlinkDenied(linkDecision, linkPath);
  const target = await realpath(linkPath);
  const targetDecision = evaluatePolicy(config, target, operation);
  if (targetDecision.policy !== "allow") return targetDecision;
  return targetDecision.symlinks
    ? targetDecision
    : symlinkDenied(targetDecision, target);
}

function allowRuleCoversTree(
  rule: ResolvedConfig["paths"][number],
  root: string,
): boolean {
  const anchor = path.resolve(rule.path);
  if (!within(anchor, root)) return false;
  const relative = path.relative(anchor, root).split(path.sep).join("/");
  const included = rule.includes.some((value) => {
    const glob = value.replace(/^\.\//, "").replace(/\/$/, "");
    const prefix =
      glob === "**" || glob === "**/*"
        ? ""
        : glob.endsWith("/**/*")
          ? glob.slice(0, -5)
          : glob.endsWith("/**")
            ? glob.slice(0, -3)
            : undefined;
    return (
      prefix !== undefined &&
      (prefix === "" ||
        relative === prefix ||
        relative.startsWith(`${prefix}/`))
    );
  });
  if (!included) return false;
  return !rule.excludes.some((value) => {
    const glob = value.replace(/^\.\//, "").replace(/\/$/, "");
    const wildcard = glob.search(/[?*[{]/);
    const prefix = (wildcard < 0 ? glob : glob.slice(0, wildcard)).replace(
      /\/$/,
      "",
    );
    return (
      !relative ||
      !prefix ||
      prefix === relative ||
      prefix.startsWith(`${relative}/`) ||
      relative.startsWith(`${prefix}/`)
    );
  });
}

function normalizedSelector(selector: string): string {
  return selector.replace(/^\.\//, "").replace(/\/$/, "");
}

const selectorExpansionLimit = 256;

function selectorSegments(selector: string): string[] {
  return normalizedSelector(selector).split("/").filter(Boolean);
}

function expandBraceAlternatives(selector: string): string[] | undefined {
  const match = /\{([^{}]*,[^{}]*)\}/.exec(selector);
  if (!match || match.index === undefined) return [selector];
  const prefix = selector.slice(0, match.index);
  const suffix = selector.slice(match.index + match[0].length);
  const expanded: string[] = [];
  for (const alternative of match[1].split(",")) {
    const nested = expandBraceAlternatives(`${prefix}${alternative}${suffix}`);
    if (!nested) return undefined;
    expanded.push(...nested);
    if (expanded.length > selectorExpansionLimit) return undefined;
  }
  return expanded;
}

function expandCharacterRange(
  start: string,
  end: string,
): string[] | undefined {
  const startCode = start.codePointAt(0) ?? 0;
  const endCode = end.codePointAt(0) ?? 0;
  const distance = endCode - startCode;
  if (distance < 0 || distance > 64) return undefined;
  return Array.from({ length: distance + 1 }, (_, offset) =>
    String.fromCodePoint(startCode + offset),
  );
}

function expandClassCharacters(value: string): string[] | undefined {
  if (!value || value.startsWith("!") || value.startsWith("^"))
    return undefined;
  const characters: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const start = value[index] as string;
    if (value[index + 1] !== "-" || index + 2 >= value.length) {
      characters.push(start);
      continue;
    }
    const range = expandCharacterRange(start, value[index + 2] as string);
    if (!range) return undefined;
    characters.push(...range);
    index += 2;
  }
  return [...new Set(characters)];
}

function expandClassAlternatives(selector: string): string[] | undefined {
  const match = /\[([^\]]+)\]/.exec(selector);
  if (!match || match.index === undefined) return [selector];
  const characters = expandClassCharacters(match[1] as string);
  if (!characters) return [selector];
  const prefix = selector.slice(0, match.index);
  const suffix = selector.slice(match.index + match[0].length);
  const expanded: string[] = [];
  for (const character of characters) {
    const nested = expandClassAlternatives(`${prefix}${character}${suffix}`);
    if (!nested) return undefined;
    expanded.push(...nested);
    if (expanded.length > selectorExpansionLimit) return undefined;
  }
  return expanded;
}

function expandSelectorAlternatives(selector: string): string[] | undefined {
  const braces = expandBraceAlternatives(selector);
  if (!braces) return undefined;
  const expanded: string[] = [];
  for (const alternative of braces) {
    const classes = expandClassAlternatives(alternative);
    if (!classes) return undefined;
    expanded.push(...classes);
    if (expanded.length > selectorExpansionLimit) return undefined;
  }
  return [...new Set(expanded)];
}

function recursiveSelectorPath(selector: string): string | undefined {
  const normalized = normalizedSelector(selector);
  if (normalized === "**" || normalized === "**/*") return "";
  if (normalized.endsWith("/**/*")) return normalized.slice(0, -5);
  if (normalized.endsWith("/**")) return normalized.slice(0, -3);
  return undefined;
}

function selectorCoveredByExclusion(
  selector: string,
  exclusion: string,
): boolean {
  if (normalizedSelector(exclusion) === normalizedSelector(selector))
    return true;
  const excludedPath = recursiveSelectorPath(exclusion);
  if (excludedPath === undefined) return false;
  if (excludedPath === "") return true;
  const excludedSegments = selectorSegments(excludedPath);
  if (excludedSegments.some((segment) => /[?*[{]/.test(segment))) return false;
  const includeSegments = selectorSegments(selector);
  return (
    excludedSegments.length <= includeSegments.length &&
    excludedSegments.every(
      (segment, index) => includeSegments[index] === segment,
    )
  );
}

function expandedSelectorExclusions(excludes: string[]): string[] {
  return excludes.flatMap(
    (exclude) => expandSelectorAlternatives(exclude) ?? [],
  );
}

function selectorAlternativeIntersectsTree(
  selector: string,
  relativeRoot: string,
): boolean {
  const selectors = selectorSegments(selector);
  const roots = relativeRoot.split("/").filter(Boolean);
  const visited = new Set<string>();
  const intersects = (selectorIndex: number, rootIndex: number): boolean => {
    if (rootIndex === roots.length) return true;
    if (selectorIndex === selectors.length) return false;
    const key = `${selectorIndex}:${rootIndex}`;
    if (visited.has(key)) return false;
    visited.add(key);
    const segment = selectors[selectorIndex] as string;
    if (segment === "**")
      return (
        intersects(selectorIndex + 1, rootIndex) ||
        intersects(selectorIndex, rootIndex + 1)
      );
    return (
      new Bun.Glob(segment).match(roots[rootIndex] as string) &&
      intersects(selectorIndex + 1, rootIndex + 1)
    );
  };
  return intersects(0, 0);
}

function exclusionCoversRequestedTree(
  exclusion: string,
  relativeRoot: string,
): boolean {
  return (
    recursiveSelectorPath(exclusion) !== undefined &&
    matches(relativeRoot, [exclusion], [])
  );
}

function selectorIntersectsRuleTree(
  selector: string,
  excludes: string[],
  relativeRoot: string,
): boolean {
  if (
    excludes.some(
      (exclude) => normalizedSelector(exclude) === normalizedSelector(selector),
    )
  )
    return false;
  const alternatives = expandSelectorAlternatives(selector);
  if (!alternatives) return true;
  const expandedExcludes = expandedSelectorExclusions(excludes);
  return alternatives.some(
    (alternative) =>
      selectorAlternativeIntersectsTree(alternative, relativeRoot) &&
      !expandedExcludes.some(
        (exclude) =>
          selectorCoveredByExclusion(alternative, exclude) ||
          exclusionCoversRequestedTree(exclude, relativeRoot),
      ),
  );
}

function ruleIntersectsTree(
  rule: ResolvedConfig["paths"][number],
  root: string,
): boolean {
  const anchor = path.resolve(rule.path);
  if (within(root, anchor)) return true;
  if (!within(anchor, root)) return false;
  const relativeRoot = path.relative(anchor, root).split(path.sep).join("/");
  return rule.includes.some((selector) =>
    selectorIntersectsRuleTree(selector, rule.excludes, relativeRoot),
  );
}

export function assertReadableTree(
  config: ResolvedConfig,
  targetPath: string,
): void {
  const root = path.resolve(targetPath);
  assertPolicy(evaluatePolicy(config, root, "read"), config.generation);
  let fullTreeAllowed =
    config.trustedRoots.some((trustedRoot) => within(trustedRoot, root)) ||
    (config.version === 1 &&
      (config.safety.allowAnyPath ||
        (config.safety.allowTempDirectory && within(temporaryRoot, root))));
  for (const rule of config.paths ?? []) {
    if (!ruleIntersectsTree(rule, root)) continue;
    if (rule.policies.read === "allow") {
      fullTreeAllowed ||= allowRuleCoversTree(rule, root);
      continue;
    }
    assertPolicy(
      {
        canonicalPath: root,
        operation: "read",
        policy: rule.policies.read,
        reason: `Recursive read intersects paths rule ${rule.id}`,
        ruleId: rule.id,
        source: rule.source,
        specificity: 0,
        symlinks: rule.followSymlinks,
      },
      config.generation,
    );
  }
  if (!fullTreeAllowed)
    assertPolicy(
      {
        canonicalPath: root,
        operation: "read",
        policy: "deny",
        reason: "Recursive read is not fully covered by an allow rule",
        source: "baseline",
        specificity: 0,
        symlinks: false,
      },
      config.generation,
    );
}

export class PathPolicyError extends Error {
  readonly code: "path_denied" | "approval_required";
  readonly decision: PolicyDecision;

  constructor(decision: PolicyDecision) {
    super(
      decision.policy === "deny"
        ? `${decision.operation} denied for ${decision.canonicalPath}: ${decision.reason}`
        : `${decision.operation} requires approval for ${decision.canonicalPath}: ${decision.reason}`,
    );
    this.name = "PathPolicyError";
    this.code =
      decision.policy === "deny" ? "path_denied" : "approval_required";
    this.decision = decision;
  }
}

export function assertPolicy(decision: PolicyDecision, generation = 0): void {
  if (decision.policy === "allow") return;
  if (
    decision.policy === "request" &&
    authorizeRequestedDecision(decision, generation)
  )
    return;
  throw new PathPolicyError(decision);
}
