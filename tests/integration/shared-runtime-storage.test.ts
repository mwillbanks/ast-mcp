import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { captureResolutionOptions } from "../../src/config/identity.ts";
import {
  createIdentity,
  createWorkspaceId,
} from "../../src/intelligence/contracts/index.ts";
import {
  markRefreshPending,
  readRefreshStateForCheckout,
} from "../../src/intelligence/mutation/experimental-deferred-refresh.ts";
import { refreshMutationIntelligence } from "../../src/intelligence/mutation/freshness.ts";
import { mutationTransactionLockPath } from "../../src/intelligence/mutation/service.ts";
import { LanceIntelligenceStore } from "../../src/intelligence/storage/store.ts";
import {
  legacyStorageDomain,
  resolveStorageDomain,
  WorkspaceRegistry,
} from "../../src/intelligence/workspace/index.ts";
import { sha256 } from "../../src/runtime/hash.ts";

async function fixture<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "ast-mcp-runtime-storage-")),
  );
  try {
    return await run(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

function git(root: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: root,
    env: {
      ...process.env,
      GIT_AUTHOR_EMAIL: "ast-mcp@example.com",
      GIT_AUTHOR_NAME: "ast-mcp",
      GIT_COMMITTER_EMAIL: "ast-mcp@example.com",
      GIT_COMMITTER_NAME: "ast-mcp",
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  if (!result.success) throw new Error(result.stderr.toString());
}

test("new worktrees have separate local storage and ignore reserved checkout state", async () => {
  await fixture(async (root) => {
    const repository = path.join(root, "primary");
    const linked = path.join(root, "linked");
    await mkdir(repository);
    git(repository, "init", "-b", "main");
    git(repository, "commit", "--allow-empty", "-m", "empty");
    git(repository, "worktree", "add", "-b", "linked", linked);

    const registry = new WorkspaceRegistry();
    const open = (directory: string) =>
      registry.open({
        configurationGeneration: 1,
        directory,
        storage: { kind: "local" },
      });
    const primary = await open(repository);
    const primaryStore = await LanceIntelligenceStore.open(
      primary.storageDomain,
    );
    await primaryStore.shutdownCoordinator();
    const secondary = await open(linked);
    expect(secondary.repositoryId).toBe(primary.repositoryId);
    expect(secondary.canonicalRootAnchor).toBe(primary.checkoutRoot);
    expect(secondary.storageDomain.domainId).not.toBe(
      primary.storageDomain.domainId,
    );
    expect(secondary.storageDomain.storagePath).toBe(
      path.join(secondary.checkoutRoot, ".ast-mcp", "intelligence"),
    );

    const packs = path.join(
      secondary.checkoutRoot,
      ".ast-mcp",
      "language-packs",
    );
    await mkdir(packs, { recursive: true });
    await writeFile(path.join(packs, "not-source.ts"), "export {};");
    const clean = await registry.status(secondary.workspaceId);
    expect(clean.selected?.workingState.dirty).toBe(false);
    await writeFile(
      path.join(secondary.checkoutRoot, "source.ts"),
      "export {};",
    );
    await expect(registry.get(secondary.workspaceId)).rejects.toMatchObject({
      code: "workspace_mismatch",
      details: { drift: ["dirtyOverlayId"] },
    });
  });
});

test("legacy storage treats empty cache roots as unset", () => {
  const launchCwd = path.resolve("launch");
  const home = path.resolve("host-home");
  const placement = { kind: "global" } as const;
  for (const platform of ["linux", "win32"] as const) {
    const options = captureResolutionOptions({
      env: { LOCALAPPDATA: "", XDG_CACHE_HOME: "" },
      home,
      launchCwd,
      platform,
    });
    expect(
      legacyStorageDomain(launchCwd, placement, options)?.storagePath,
    ).toBe(path.join(home, ".cache", "ast-mcp", "intelligence"));
  }
  const windows = captureResolutionOptions({
    env: { LOCALAPPDATA: "local", XDG_CACHE_HOME: "" },
    home,
    launchCwd,
    platform: "win32",
  });
  expect(legacyStorageDomain(launchCwd, placement, windows)?.storagePath).toBe(
    path.join(launchCwd, "local", "ast-mcp", "intelligence"),
  );
});

test("global storage selects matching publications, not neighboring stores", async () => {
  await fixture(async (root) => {
    const directory = path.join(root, "repository");
    const neighbor = path.join(root, "neighbor");
    const home = path.join(root, "home");
    const options = {
      configurationGeneration: 1,
      directory,
      env: {
        XDG_CACHE_HOME: path.join(home, "cache"),
        XDG_CONFIG_HOME: path.join(home, "config"),
      },
      home,
      platform: "linux" as const,
    };
    await mkdir(directory);
    await mkdir(neighbor);
    const preferred = resolveStorageDomain(
      directory,
      { kind: "global" },
      options,
    );
    const legacy = legacyStorageDomain(directory, { kind: "global" }, options)!;
    await mkdir(legacy.storagePath, { recursive: true });

    const registry = new WorkspaceRegistry();
    const fresh = await registry.open(options);
    expect(fresh.storageDomain).toEqual(preferred);
    const nearby = await registry.open({ ...options, directory: neighbor });
    const publish = async (
      workspace: typeof fresh,
      domain: typeof preferred,
    ) => {
      const workspaceId = createWorkspaceId({
        canonicalCheckoutRoot: workspace.checkoutRoot,
        configurationGeneration: options.configurationGeneration,
        dirtyOverlayId: null,
        repositoryId: workspace.repositoryId,
        revisionId: workspace.selectedRevision.revisionId,
        storageDomainId: domain.domainId,
      });
      const store = await LanceIntelligenceStore.open(domain);
      try {
        await store.publish({
          manifestArtifactId: createIdentity("revision-manifest", {
            workspaceId,
          }),
          revisionId: workspace.selectedRevision.revisionId,
          workspaceId,
        });
      } finally {
        await store.shutdownCoordinator();
      }
    };

    await publish(nearby, legacy);
    expect((await registry.open(options)).storageDomain).toEqual(preferred);
    await publish(nearby, preferred);
    await publish(fresh, legacy);
    expect((await registry.open(options)).storageDomain).toEqual(legacy);
    await publish(fresh, preferred);
    expect((await registry.open(options)).storageDomain).toEqual(preferred);
  });
});

test("an interrupted unindexed legacy write keeps its recovery domain", async () => {
  await fixture(async (root) => {
    const directory = path.join(root, "repository");
    await mkdir(directory);
    const options = {
      configurationGeneration: 1,
      directory,
      env: { XDG_CACHE_HOME: path.join(root, "cache") },
      home: root,
    };
    const legacy = legacyStorageDomain(directory, { kind: "global" }, options)!;
    const registry = new WorkspaceRegistry();
    expect((await registry.open(options)).storageDomain).not.toEqual(legacy);
    const durableKey = await mutationTransactionLockPath(directory);
    try {
      await markRefreshPending(
        durableKey,
        ["value.ts"],
        sha256("legacy-config"),
        sha256(legacy.domainId),
        { indexRefresh: false, inFlight: true, journal: "sqlite-v1" },
      );
      expect(await readRefreshStateForCheckout(directory)).toMatchObject({
        inFlight: true,
        storageScope: sha256(legacy.domainId),
      });
      const upgraded = await registry.open(options);
      expect(upgraded.storageDomain).toEqual(legacy);
    } finally {
      await rm(durableKey + ".refresh.json", { force: true });
    }
  });
});

test("nested non-Git checkouts retain publications but do not adopt a neighbor's", async () => {
  await fixture(async (root) => {
    const projectRoot = path.join(root, "project");
    const directory = path.join(projectRoot, "legacy");
    const neighbor = path.join(projectRoot, "neighbor");
    await mkdir(directory, { recursive: true });
    await mkdir(neighbor);
    await writeFile(
      path.join(directory, "value.ts"),
      "export const value = 1;\n",
    );
    const options = {
      configurationGeneration: 1,
      env: {
        XDG_CACHE_HOME: path.join(root, "cache"),
        XDG_CONFIG_HOME: path.join(root, "config"),
      },
      home: root,
    };
    const legacy = legacyStorageDomain(directory, { kind: "global" }, options)!;
    const original = await new WorkspaceRegistry().open({
      ...options,
      directory,
    });
    const store = await LanceIntelligenceStore.open(legacy);
    try {
      const published = await refreshMutationIntelligence({
        store,
        workspace: {
          ...original,
          storageDomain: legacy,
          workspaceId: createWorkspaceId({
            canonicalCheckoutRoot: directory,
            configurationGeneration: options.configurationGeneration,
            dirtyOverlayId: null,
            repositoryId: original.repositoryId,
            revisionId: original.selectedRevision.revisionId,
            storageDomainId: legacy.domainId,
          }),
        },
      });
      expect(published.generationId).toStartWith("generation:v1:");
    } finally {
      await store.shutdownCoordinator();
    }

    const registry = new WorkspaceRegistry();
    const upgraded = await registry.open({
      ...options,
      configurationGeneration: 2,
      directory,
      projectRoot,
    });
    expect(upgraded.checkoutRoot).toBe(directory);
    expect(upgraded.repositoryId).toBe(original.repositoryId);
    expect(upgraded.storageDomain).toEqual(legacy);
    const fresh = await registry.open({
      ...options,
      directory: neighbor,
      projectRoot,
    });
    expect(fresh.checkoutRoot).toBe(projectRoot);
  });
});

test("nested non-Git pending recovery keeps old parent placement and checkout", async () => {
  await fixture(async (root) => {
    const projectRoot = path.join(root, "project");
    const directory = path.join(projectRoot, "nested");
    await mkdir(directory, { recursive: true });
    const storage = { kind: "parent", levels: 1 } as const;
    const legacy = resolveStorageDomain(directory, storage);
    const options = {
      configurationGeneration: 1,
      directory,
      projectRoot,
      storage,
    };
    const registry = new WorkspaceRegistry();
    expect((await registry.open(options)).checkoutRoot).toBe(projectRoot);

    const durableKey = await mutationTransactionLockPath(directory);
    try {
      await markRefreshPending(
        durableKey,
        ["value.ts"],
        sha256("legacy-config"),
        sha256(legacy.domainId),
        {
          indexRefresh: false,
          inFlight: true,
          journal: "sqlite-v1",
        },
      );
      const upgraded = await registry.open(options);
      expect(upgraded.checkoutRoot).toBe(directory);
      expect(upgraded.storageDomain).toEqual(legacy);
      expect((await registry.get(upgraded.workspaceId)).checkoutRoot).toBe(
        directory,
      );
    } finally {
      await rm(durableKey + ".refresh.json", { force: true });
    }
  });
});

test("a miss for one linked worktree overlay does not pin its storage domain", async () => {
  await fixture(async (root) => {
    const repository = path.join(root, "primary");
    const linked = path.join(root, "linked");
    await mkdir(repository);
    git(repository, "init", "-b", "main");
    git(repository, "commit", "--allow-empty", "-m", "empty");
    git(repository, "worktree", "add", "-b", "linked", linked);
    const registry = new WorkspaceRegistry();
    const options = { directory: linked, configurationGeneration: 1 };
    const local = { kind: "local" } as const;
    const legacy = legacyStorageDomain(repository, local, {})!;
    const store = await LanceIntelligenceStore.open(legacy);
    try {
      const first = await registry.open({ ...options, storage: local });
      expect(first.storageDomain.domainId).not.toBe(legacy.domainId);
      const preferred = await LanceIntelligenceStore.open(first.storageDomain);
      try {
        await preferred.publish({
          manifestArtifactId: createIdentity("revision-manifest", {
            workspaceId: first.workspaceId,
          }),
          revisionId: first.selectedRevision.revisionId,
          workspaceId: first.workspaceId,
        });
      } finally {
        await preferred.shutdownCoordinator();
      }

      await writeFile(
        path.join(linked, "value.ts"),
        "export const value = 1;\n",
      );
      const working = await registry.open({ ...options, storage: local });
      const originalWorkspaceId = createWorkspaceId({
        canonicalCheckoutRoot: linked,
        configurationGeneration: options.configurationGeneration,
        dirtyOverlayId: working.dirtyOverlayId,
        repositoryId: working.repositoryId,
        revisionId: working.selectedRevision.revisionId,
        storageDomainId: legacy.domainId,
      });
      await store.publish({
        manifestArtifactId: createIdentity("revision-manifest", {
          workspaceId: originalWorkspaceId,
        }),
        revisionId: working.selectedRevision.revisionId,
        workspaceId: originalWorkspaceId,
      });
      const upgraded = await registry.open({ ...options, storage: local });
      expect(upgraded.workspaceId).toBe(originalWorkspaceId);
      expect(upgraded.storageDomain).toEqual(legacy);

      await rm(path.join(linked, "value.ts"));
      const restored = await registry.open({ ...options, storage: local });
      expect(restored.workspaceId).toBe(first.workspaceId);
      expect(restored.storageDomain).toEqual(first.storageDomain);
    } finally {
      await store.shutdownCoordinator();
    }
  });
});
