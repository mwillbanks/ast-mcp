import { lstat, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { currentConfig } from "../config";
import {
  assertPolicy,
  evaluatePolicy,
  type PathOperation,
} from "./path-policy";
import {
  canonicalizePath,
  effectiveWorkspaceRoot,
  pathWithin,
} from "./path-utils";

async function realpathOrSelf(filePath: string): Promise<string> {
  try {
    return await realpath(filePath);
  } catch {
    return filePath;
  }
}

async function configuredRoots(): Promise<string[]> {
  return (await currentConfig()).workspace.roots;
}
function within(root: string, target: string): boolean {
  return pathWithin(root, target);
}

async function workspaceRoots(): Promise<string[]> {
  const config = await currentConfig();
  const roots = await Promise.all(
    (await configuredRoots()).map(realpathOrSelf),
  );
  const trustedRoots = await Promise.all(
    config.trustedRoots.map(realpathOrSelf),
  );
  if (
    config.version === 1 &&
    !config.safety.allowExternalRoots &&
    roots.some(
      (root) => !trustedRoots.some((trustedRoot) => within(trustedRoot, root)),
    )
  )
    throw new Error(
      "Configured workspace roots contain a root outside the trusted project boundary; set safety.allow_external_roots=true or AST_MCP_ALLOW_EXTERNAL_ROOTS=1 to opt in",
    );
  const primary = effectiveWorkspaceRoot(
    await realpathOrSelf(config.projectRoot),
    roots,
  );
  return [primary, ...roots.filter((root) => root !== primary)];
}

async function fileOperationRoots(): Promise<string[]> {
  const config = await currentConfig();
  const roots = await workspaceRoots();
  const policyRoots = (config.paths ?? []).map((rule) => rule.path);
  const combined = [...new Set([...roots, ...policyRoots])];
  if (!config.safety.allowTempDirectory) return combined;
  const temporaryRoot = await realpathOrSelf(os.tmpdir());
  return combined.includes(temporaryRoot)
    ? combined
    : [...combined, temporaryRoot];
}

export async function primaryRoot(): Promise<string> {
  return (await workspaceRoots())[0] as string;
}

async function configuredRootForPath(
  filePath: string,
): Promise<string | undefined> {
  return (await fileOperationRoots()).find((candidate) =>
    within(candidate, filePath),
  );
}

export async function referenceRootForPath(
  filePath: string,
): Promise<string | undefined> {
  const candidates = await Promise.all(
    (await fileOperationRoots()).map(async (candidate) =>
      (await lstat(candidate).catch(() => undefined))?.isDirectory()
        ? candidate
        : undefined,
    ),
  );
  return candidates
    .filter((candidate): candidate is string => Boolean(candidate))
    .filter((candidate) => within(candidate, filePath))
    .sort((left, right) => right.length - left.length)[0];
}

export async function rootForPath(filePath: string): Promise<string> {
  const root = await configuredRootForPath(filePath);
  if (root) return root;
  if ((await currentConfig()).safety.allowAnyPath)
    return path.dirname(filePath);
  throw new Error(
    `Path is outside configured file-operation roots: ${filePath}`,
  );
}

export async function assertSingleProjectRoot(
  filePaths: string[],
): Promise<void> {
  const selectedRoots = new Set(
    await Promise.all(filePaths.map((filePath) => rootForPath(filePath))),
  );
  if (selectedRoots.size > 1)
    throw Object.assign(
      new Error(
        "AST requests may not span project roots; issue one root-specific call per project",
      ),
      {
        code: "cross_root_ast_request",
        retryable: true,
        suggestedNextCall:
          "Split the request by project root; independent read-only calls may run in parallel",
      },
    );
}

export async function pathsShareRoot(
  first: string,
  second: string,
): Promise<boolean> {
  const config = await currentConfig();
  if (config.version === 2 || config.safety.allowAnyPath) return true;
  return (await rootForPath(first)) === (await rootForPath(second));
}
async function canonicalCandidate(filePath: string, root: string) {
  const absolute = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(root, filePath);
  return path.join(
    await canonicalizePath(path.dirname(absolute)),
    path.basename(absolute),
  );
}

function assertWithinBoundary(
  target: string,
  roots: string[],
  allowAnyPath: boolean,
  message: string,
) {
  if (!allowAnyPath && !roots.some((root) => within(root, target)))
    throw new Error(message);
}

function enforcePolicy(
  config: Awaited<ReturnType<typeof currentConfig>>,
  decision: ReturnType<typeof evaluatePolicy>,
): void {
  if (config.version === 2 || config.paths?.length)
    assertPolicy(decision, config.generation);
}

async function resolvedSymlinkTarget(args: {
  allowAnyPath: boolean;
  boundary: string;
  config: Awaited<ReturnType<typeof currentConfig>>;
  filePath: string;
  linkDecision: ReturnType<typeof evaluatePolicy>;
  operation: PathOperation;
  resolved: string;
  roots: string[];
}): Promise<string> {
  if (!args.linkDecision.symlinks)
    throw new Error(
      `Symbolic-link targets are not permitted by the winning path rule: ${args.filePath}`,
    );
  const target = await realpath(args.resolved);
  assertWithinBoundary(
    target,
    args.roots,
    args.allowAnyPath,
    `Symbolic-link target is outside ${args.boundary}: ${args.filePath}`,
  );
  const targetDecision = evaluatePolicy(args.config, target, args.operation);
  enforcePolicy(args.config, targetDecision);
  if (!targetDecision.symlinks)
    throw new Error(
      `Resolved symbolic-link target is not permitted by the winning path rule: ${target}`,
    );
  return target;
}

async function resolvePath(
  filePath: string,
  roots: string[],
  allowAnyPath: boolean,
  boundary: string,
  operation: PathOperation,
): Promise<string> {
  const config = await currentConfig();
  const resolved = await canonicalCandidate(filePath, roots[0] as string);
  assertWithinBoundary(
    resolved,
    roots,
    allowAnyPath,
    `Path is outside ${boundary}: ${filePath}`,
  );
  const linkDecision = evaluatePolicy(config, resolved, operation);
  enforcePolicy(config, linkDecision);
  const metadata = await lstat(resolved).catch(() => undefined);
  if (!metadata?.isSymbolicLink()) return resolved;
  return resolvedSymlinkTarget({
    allowAnyPath,
    boundary,
    config,
    filePath,
    linkDecision,
    operation,
    resolved,
    roots,
  });
}

export async function resolveWritablePath(
  filePath: string,
  operation: PathOperation = "write",
): Promise<string> {
  const config = await currentConfig();
  return resolvePath(
    filePath,
    await fileOperationRoots(),
    config.safety.allowAnyPath,
    "configured file-operation roots and paths rules",
    operation,
  );
}

export async function resolveWorkspacePath(filePath: string): Promise<string> {
  return resolvePath(
    filePath,
    await fileOperationRoots(),
    false,
    "configured workspace and paths roots",
    "read",
  );
}
export async function rootsForDisplay(): Promise<string[]> {
  return configuredRoots();
}
