import type { BigIntStats } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";

import { canonicalizePathSync, pathWithin } from "../../runtime/path-utils.ts";
import {
  createRepositoryId,
  createWorkspaceId,
  INTELLIGENCE_SCHEMA_VERSION,
  type ResolvedRevision,
  type RevisionSelector,
  RevisionSelectorSchema,
  type StorageDomain,
  type StoragePlacement,
  StoragePlacementSchema,
  WorkspaceContextSchema,
} from "../contracts/index.ts";
import type { WorkspaceHandle } from "./context.ts";
import { WorkspaceError } from "./errors.ts";
import {
  discoverGitWorkspace,
  type GitWorkspaceIdentity,
  gitDirtyOverlayId,
  gitWorkingState,
  resolveRevision,
} from "./git.ts";
import {
  findExistingNestedStorageDomain,
  legacyStorageDomain,
  resolveStorageDomain,
  selectExistingStorageDomain,
  type StorageResolutionOptions,
} from "./storage.ts";

interface WorkspaceRootOptions extends StorageResolutionOptions {
  configurationGeneration: number;
  storage?: StoragePlacement;
}

export type WorkspaceOpenOptions = {
  directory: string;
  projectRoot?: string;
  revision?: RevisionSelector;
} & (
  | WorkspaceRootOptions
  | (StorageResolutionOptions & {
      resolveRoot(
        root: string,
        directory: string,
      ): Promise<WorkspaceRootOptions>;
    })
);

export interface WorkspaceRequest {
  revision?: RevisionSelector;
  workspaceId?: string;
}

export interface WorkspaceExpectations {
  configurationGeneration?: number;
  revisionId?: string;
  storageDomainId?: string;
}

interface WorkspaceRecord {
  checkoutDevice: bigint;
  checkoutInode: bigint;
  openingDirectory: string;
  workspace: WorkspaceHandle;
}

function requestCoordinates(args: unknown): WorkspaceRequest {
  if (!args || typeof args !== "object") return {};
  const value = args as Record<string, unknown>;
  return {
    revision:
      value.revision === undefined
        ? undefined
        : RevisionSelectorSchema.parse(value.revision),
    workspaceId:
      typeof value.workspaceId === "string" ? value.workspaceId : undefined,
  };
}

async function existingRealpath(target: string): Promise<string | undefined> {
  try {
    return await realpath(target);
  } catch {
    return undefined;
  }
}

async function canonicalDirectory(directory: string): Promise<string> {
  if (!path.isAbsolute(directory)) {
    throw new WorkspaceError(
      "workspace_mismatch",
      "workspace_open requires an absolute directory",
      { directory },
    );
  }
  const canonical = await existingRealpath(directory);
  if (!canonical || !(await stat(canonical)).isDirectory()) {
    throw new WorkspaceError(
      "workspace_not_found",
      "Workspace directory does not exist",
      {
        directory,
      },
    );
  }
  return canonical;
}

async function canonicalRoots(roots: string[]): Promise<string[]> {
  return [
    ...new Set(
      await Promise.all(
        roots.map(async (root) => {
          const value = root.startsWith("file:")
            ? Bun.fileURLToPath(root)
            : root;
          return (await existingRealpath(value)) ?? path.resolve(value);
        }),
      ),
    ),
  ];
}

function containingAdvertisedRoot(
  roots: string[],
  candidate: string,
): string | undefined {
  const canonical = canonicalizePathSync(candidate);
  return roots
    .filter(
      (root) => pathWithin(root, candidate) || pathWithin(root, canonical),
    )
    .sort((left, right) => right.length - left.length)[0];
}

function matchedRoots(roots: string[], requestPaths: string[]): string[] {
  return [
    ...new Set(
      requestPaths
        .filter(path.isAbsolute)
        .map((item) => containingAdvertisedRoot(roots, path.resolve(item)))
        .filter((item): item is string => Boolean(item)),
    ),
  ];
}

export class WorkspaceRegistry {
  readonly #workspaces = new Map<string, WorkspaceRecord>();

  constructor(
    private readonly statCheckout: (
      target: string,
      options: { bigint: true },
    ) => Promise<BigIntStats> = stat,
  ) {}
  async #selectStorage(
    git: GitWorkspaceIdentity,
    placement: StoragePlacement,
    options: StorageResolutionOptions & WorkspaceRootOptions,
    repositoryId: string,
    selectedRevision: ResolvedRevision,
    dirtyOverlay: (domain: StorageDomain) => Promise<string | null>,
  ): Promise<StorageDomain> {
    const preferred = resolveStorageDomain(
      git.repositoryRoot,
      placement,
      options,
      git.checkoutRoot,
    );
    const legacy = legacyStorageDomain(git.repositoryRoot, placement, options);
    if (!legacy || legacy.domainId === preferred.domainId)
      return Promise.resolve(preferred);

    return selectExistingStorageDomain(
      preferred,
      legacy,
      git.checkoutRoot,
      async (domain) =>
        createWorkspaceId({
          canonicalCheckoutRoot: git.checkoutRoot,
          configurationGeneration: options.configurationGeneration,
          dirtyOverlayId: await dirtyOverlay(domain),
          repositoryId,
          revisionId: selectedRevision.revisionId,
          storageDomainId: domain.domainId,
        }),
      git.isGit
        ? undefined
        : { repositoryId, revisionId: selectedRevision.revisionId },
    );
  }

  async get(
    workspaceId: string,
    expectations: WorkspaceExpectations = {},
  ): Promise<WorkspaceHandle> {
    const record = this.#workspaces.get(workspaceId);
    if (!record) {
      throw new WorkspaceError(
        "workspace_not_found",
        "Unknown workspaceId for this server session",
        { workspaceId },
        true,
        "workspace_open",
      );
    }
    return this.#revalidate(record, expectations);
  }

  workspaceIds(): string[] {
    return [...this.#workspaces.keys()];
  }

  openingDirectory(workspaceId: string): string | undefined {
    return this.#workspaces.get(workspaceId)?.openingDirectory;
  }

  async list(): Promise<WorkspaceHandle[]> {
    return Promise.all(
      [...this.#workspaces.values()].map((record) => this.#revalidate(record)),
    );
  }

  async #revalidate(
    record: WorkspaceRecord,
    expectations: WorkspaceExpectations = {},
  ): Promise<WorkspaceHandle> {
    const workspace = record.workspace;
    const canonical = await existingRealpath(workspace.checkoutRoot);
    if (!canonical) {
      throw new WorkspaceError(
        "workspace_not_found",
        "The selected workspace checkout no longer exists",
        {
          checkoutRoot: workspace.checkoutRoot,
          workspaceId: workspace.workspaceId,
        },
        true,
        "workspace_open",
      );
    }
    const metadata = await this.statCheckout(canonical, { bigint: true }).catch(
      () => undefined,
    );
    if (!metadata?.isDirectory()) {
      throw new WorkspaceError(
        "workspace_not_found",
        "The selected workspace checkout is no longer a directory",
        {
          checkoutRoot: workspace.checkoutRoot,
          workspaceId: workspace.workspaceId,
        },
        true,
        "workspace_open",
      );
    }
    const git = await discoverGitWorkspace(canonical, {
      readHead: workspace.selectedRevision.selector.kind === "working",
    });
    const repositoryId = createRepositoryId({
      canonicalGitCommonDirectory: git.commonGitDirectory ?? git.repositoryRoot,
    });
    const revision = await resolveRevision(
      git,
      repositoryId,
      workspace.selectedRevision.selector,
    );
    const storageDomain = workspace.storageDomain;
    const dirtyOverlayId =
      revision.selector.kind === "working"
        ? await gitDirtyOverlayId(
            git,
            repositoryId,
            revision.revisionId,
            storageDomain.storagePath,
          )
        : null;
    const mismatches = {
      checkoutIdentity:
        canonical !== workspace.checkoutRoot ||
        metadata.dev !== record.checkoutDevice ||
        metadata.ino !== record.checkoutInode,
      checkoutRoot: git.checkoutRoot !== workspace.checkoutRoot,
      commonGitDirectory:
        git.commonGitDirectory !== workspace.git.commonGitDirectory,
      configurationGeneration:
        expectations.configurationGeneration !== undefined &&
        expectations.configurationGeneration !==
          workspace.configurationGeneration,
      dirtyOverlayId: dirtyOverlayId !== workspace.dirtyOverlayId,
      gitDirectory: git.gitDirectory !== workspace.git.gitDirectory,
      repositoryId: repositoryId !== workspace.repositoryId,
      repositoryRoot: git.repositoryRoot !== workspace.repositoryRoot,
      revisionId:
        revision.revisionId !== workspace.selectedRevision.revisionId ||
        (expectations.revisionId !== undefined &&
          expectations.revisionId !== workspace.selectedRevision.revisionId),
      storageDomainId:
        storageDomain.domainId !== workspace.storageDomain.domainId ||
        (expectations.storageDomainId !== undefined &&
          expectations.storageDomainId !== workspace.storageDomain.domainId),
    };
    const drift = Object.entries(mismatches)
      .filter(([, mismatch]) => mismatch)
      .map(([coordinate]) => coordinate);
    if (drift.length) {
      throw new WorkspaceError(
        "workspace_mismatch",
        "The selected workspace identity changed after it was opened",
        { drift, workspaceId: workspace.workspaceId },
        true,
        "workspace_open",
      );
    }
    return workspace;
  }

  async open(options: WorkspaceOpenOptions): Promise<WorkspaceHandle> {
    const openingDirectory = options.directory;
    const directory = await canonicalDirectory(openingDirectory);
    let git = await discoverGitWorkspace(directory);
    const resolveRoot = (root: string) =>
      "resolveRoot" in options ? options.resolveRoot(root, directory) : options;
    let resolved: WorkspaceRootOptions | undefined;
    let retained: StorageDomain | undefined;
    if (!git.isGit && options.projectRoot) {
      const project = await canonicalDirectory(options.projectRoot);
      if (project !== directory && pathWithin(project, directory)) {
        const parent = await discoverGitWorkspace(project);
        if (!parent.isGit) {
          resolved = await resolveRoot(directory);
          const originalPlacement = resolved.storage ?? { kind: "global" };
          const current = resolveStorageDomain(directory, originalPlacement, {
            ...options,
            ...resolved,
          });
          const legacy = legacyStorageDomain(directory, originalPlacement, {
            ...options,
            ...resolved,
          });
          const domains =
            legacy && legacy.domainId !== current.domainId
              ? [legacy, current]
              : [current];
          const repositoryId = createRepositoryId({
            canonicalGitCommonDirectory: directory,
          });
          const revision = await resolveRevision(
            git,
            repositoryId,
            options.revision,
          );
          retained = await findExistingNestedStorageDomain(
            domains,
            directory,
            { repositoryId, revisionId: revision.revisionId },
            (domain) =>
              createWorkspaceId({
                canonicalCheckoutRoot: directory,
                configurationGeneration: resolved!.configurationGeneration,
                dirtyOverlayId: null,
                repositoryId,
                revisionId: revision.revisionId,
                storageDomainId: domain.domainId,
              }),
          );
          if (!retained) {
            git = parent;
            resolved = undefined;
          }
        }
      }
    }
    if (git.isGit && git.checkoutRoot !== directory)
      throw new WorkspaceError(
        "workspace_mismatch",
        "Git workspaces must open at the checkout root",
        { checkoutRoot: git.checkoutRoot, directory },
        true,
        "workspace_open with the checkout root",
      );
    resolved ??= await resolveRoot(git.checkoutRoot);
    const repositoryId = createRepositoryId({
      canonicalGitCommonDirectory: git.commonGitDirectory ?? git.repositoryRoot,
    });
    const selectedRevision = await resolveRevision(
      git,
      repositoryId,
      options.revision,
    );
    const placement = StoragePlacementSchema.parse(
      resolved.storage ?? { kind: "global" },
    );
    const overlays = new Map<string, Promise<string | null>>();
    const dirtyOverlay = (domain: StorageDomain) => {
      // Local storage inside the reserved directory is already excluded.
      const includedStorage =
        pathWithin(git.checkoutRoot, domain.storagePath) &&
        !pathWithin(path.join(git.checkoutRoot, ".ast-mcp"), domain.storagePath)
          ? domain.storagePath
          : undefined;
      const cached = overlays.get(includedStorage ?? "");
      if (cached) return cached;
      const overlay =
        selectedRevision.selector.kind === "working"
          ? gitDirtyOverlayId(
              git,
              repositoryId,
              selectedRevision.revisionId,
              includedStorage,
            )
          : Promise.resolve(null);
      overlays.set(includedStorage ?? "", overlay);
      return overlay;
    };
    const storageDomain =
      retained ??
      (await this.#selectStorage(
        git,
        placement,
        { ...options, ...resolved },
        repositoryId,
        selectedRevision,
        dirtyOverlay,
      ));
    const dirtyOverlayId = await dirtyOverlay(storageDomain);
    const coordinates = {
      canonicalCheckoutRoot: git.checkoutRoot,
      configurationGeneration: resolved.configurationGeneration,
      dirtyOverlayId,
      repositoryId,
      revisionId: selectedRevision.revisionId,
      storageDomainId: storageDomain.domainId,
    };
    const context = WorkspaceContextSchema.parse({
      canonicalRootAnchor: git.repositoryRoot,
      checkoutRoot: git.checkoutRoot,
      configurationGeneration: resolved.configurationGeneration,
      dirtyOverlayId,
      repositoryId,
      repositoryRoot: git.repositoryRoot,
      schemaVersion: INTELLIGENCE_SCHEMA_VERSION,
      selectedRevision,
      storageDomain,
      workspaceId: createWorkspaceId(coordinates),
      writeEligibility: selectedRevision.readOnly
        ? { eligible: false, reason: "historical-revision" }
        : { eligible: true },
    });
    const workspace: WorkspaceHandle = {
      ...context,
      git,
      openedAt: new Date().toISOString(),
    };
    const metadata = await this.statCheckout(workspace.checkoutRoot, {
      bigint: true,
    });
    this.#workspaces.set(workspace.workspaceId, {
      checkoutDevice: metadata.dev,
      checkoutInode: metadata.ino,
      openingDirectory:
        directory === git.checkoutRoot ? openingDirectory : git.checkoutRoot,
      workspace,
    });
    return workspace;
  }

  async selectDirectory(
    clientRoots: string[],
    requestPaths: string[],
  ): Promise<string | undefined> {
    const roots = await canonicalRoots(clientRoots);
    if (roots.length === 0) return undefined;
    const absolute = requestPaths
      .filter(path.isAbsolute)
      .map((item) => path.resolve(item));
    const matches = matchedRoots(roots, requestPaths);
    if (
      absolute.some((candidate) => !containingAdvertisedRoot(roots, candidate))
    )
      throw new WorkspaceError(
        "workspace_mismatch",
        "Absolute request paths do not belong to an advertised root",
        { requestPaths, roots },
      );
    if (matches.length > 1) {
      throw new WorkspaceError(
        "workspace_ambiguous",
        "Request paths span multiple advertised roots",
        { matches, requestPaths },
        true,
        "workspace_open",
      );
    }
    if (matches.length === 1) return matches[0];
    if (roots.length === 1) return roots[0];
    throw new WorkspaceError(
      "workspace_ambiguous",
      "Relative paths require workspaceId when multiple roots are advertised",
      { roots },
      true,
      "workspace_open",
    );
  }

  validateRequestPaths(
    workspace: WorkspaceHandle,
    requestPaths: string[],
  ): void {
    const mismatches = requestPaths
      .filter(path.isAbsolute)
      .map((item) => path.resolve(item))
      .filter((item) => {
        const canonical = canonicalizePathSync(item);
        return (
          !pathWithin(workspace.checkoutRoot, item) &&
          !pathWithin(workspace.checkoutRoot, canonical)
        );
      });
    if (mismatches.length) {
      throw new WorkspaceError(
        "workspace_mismatch",
        "Absolute paths must belong to the selected workspace",
        { mismatches, workspaceId: workspace.workspaceId },
      );
    }
  }

  request(args: unknown): WorkspaceRequest {
    return requestCoordinates(args);
  }

  async status(workspaceId?: string) {
    const selected = workspaceId ? await this.get(workspaceId) : undefined;
    const workspaces = selected ? [selected] : await this.list();
    const described = await Promise.all(
      workspaces.map(async (workspace) => ({
        ...workspace,
        workingState: await gitWorkingState(
          workspace.git,
          workspace.storageDomain.storagePath,
        ),
      })),
    );
    return {
      selected: selected ? described[0] : null,
      workspaces: described,
    };
  }
}
