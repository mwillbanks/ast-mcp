import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createRepositoryId,
  createRevisionId,
  createStorageDomainId,
  createWorkspaceId,
} from "../src/intelligence/contracts/index.ts";
import { refreshMutationIntelligence } from "../src/intelligence/mutation/freshness.ts";
import { LanceIntelligenceStore } from "../src/intelligence/storage/store.ts";
import {
  type WorkspaceHandle,
  withWorkspaceContext,
} from "../src/intelligence/workspace/index.ts";

const roots: string[] = [];

async function temporary(): Promise<string> {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "ast-mcp-resolution-identity-")),
  );
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

function workspace(
  checkoutRoot: string,
  commonGitDirectory: string,
  storagePath: string,
  commitOid: string,
): WorkspaceHandle {
  const placement = { kind: "explicit" as const, path: storagePath };
  const storageDomainId = createStorageDomainId({
    engine: "lancedb",
    placement,
    pool: "shared",
    storagePath,
  });
  const repositoryId = createRepositoryId({
    canonicalGitCommonDirectory: commonGitDirectory,
  });
  const selector = { kind: "working" as const };
  const revisionId = createRevisionId({
    repositoryId,
    resolvedCommitOid: commitOid,
    selector,
  });
  const workspaceId = createWorkspaceId({
    canonicalCheckoutRoot: checkoutRoot,
    configurationGeneration: 1,
    dirtyOverlayId: null,
    repositoryId,
    revisionId,
    storageDomainId,
  });
  return {
    canonicalRootAnchor: checkoutRoot,
    checkoutRoot,
    configurationGeneration: 1,
    dirtyOverlayId: null,
    git: {
      branch: "main",
      checkoutRoot,
      commonGitDirectory,
      gitDirectory: commonGitDirectory,
      headOid: commitOid,
      isGit: false,
      isLinkedWorktree: false,
      repositoryRoot: checkoutRoot,
    },
    openedAt: "2026-09-11T00:00:00.000Z",
    repositoryId,
    repositoryRoot: checkoutRoot,
    schemaVersion: "ast-mcp.intelligence.v1",
    selectedRevision: {
      readOnly: false,
      resolvedCommitOid: commitOid,
      revisionId,
      selector,
    },
    storageDomain: {
      domainId: storageDomainId,
      engine: "lancedb",
      placement,
      pool: "shared",
      schemaVersion: "ast-mcp.intelligence.v1",
      storagePath,
    },
    workspaceId,
    writeEligibility: { eligible: true },
  };
}

test("keeps resolved artifacts immutable across repositories and revisions", async () => {
  const root = await temporary();
  const firstRoot = path.join(root, "first");
  const secondRoot = path.join(root, "second");
  const storagePath = path.join(root, "shared-index");
  const firstGit = path.join(firstRoot, ".git");
  const secondGit = path.join(secondRoot, ".git");
  await Promise.all([
    mkdir(firstGit, { recursive: true }),
    mkdir(secondGit, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(firstRoot, "shared.ts"), "export const shared = 1;\n"),
    writeFile(path.join(secondRoot, "shared.ts"), "export const shared = 1;\n"),
  ]);

  const firstRevision = workspace(
    firstRoot,
    firstGit,
    storagePath,
    "a".repeat(40),
  );
  const secondRepository = workspace(
    secondRoot,
    secondGit,
    storagePath,
    "a".repeat(40),
  );
  const secondRevision = workspace(
    firstRoot,
    firstGit,
    storagePath,
    "b".repeat(40),
  );
  const store = await LanceIntelligenceStore.open(firstRevision.storageDomain);
  try {
    await withWorkspaceContext(firstRevision, () =>
      refreshMutationIntelligence({ store, workspace: firstRevision }),
    );
    const initialGraphMembershipIds = (await store.rows("revision_membership"))
      .filter(
        (row) =>
          row.revision_id === firstRevision.selectedRevision.revisionId &&
          row.entity_kind === "node",
      )
      .map((row) => String(row.entity_id))
      .sort();
    expect(initialGraphMembershipIds.length).toBeGreaterThan(0);

    await withWorkspaceContext(secondRepository, () =>
      refreshMutationIntelligence({ store, workspace: secondRepository }),
    );
    await writeFile(
      path.join(firstRoot, "unrelated.ts"),
      "export const unrelated = 2;\n",
    );
    await withWorkspaceContext(secondRevision, () =>
      refreshMutationIntelligence({ store, workspace: secondRevision }),
    );

    const manifests = await store.rows("revision_manifests");
    expect(manifests).toHaveLength(3);
    const manifestEntries = manifests.map((manifest) => {
      const payload = JSON.parse(String(manifest.payload_json)) as {
        entries: Array<{
          path: string;
          resolvedRelationshipsArtifactId: string | null;
        }>;
      };
      return payload.entries;
    });
    const relationshipArtifactIds = manifestEntries.map(
      (entries) =>
        entries.find((entry) => entry.path === "shared.ts")
          ?.resolvedRelationshipsArtifactId,
    );
    expect(relationshipArtifactIds.every(Boolean)).toBeTrue();
    expect(relationshipArtifactIds[0]).toBe(relationshipArtifactIds[2]);
    expect(relationshipArtifactIds[0]).not.toBe(relationshipArtifactIds[1]);

    const secondRevisionGraphMembershipIds = new Set(
      (await store.rows("revision_membership"))
        .filter(
          (row) =>
            row.revision_id === secondRevision.selectedRevision.revisionId &&
            row.entity_kind === "node",
        )
        .map((row) => String(row.entity_id)),
    );
    expect(
      initialGraphMembershipIds.every((id) =>
        secondRevisionGraphMembershipIds.has(id),
      ),
    ).toBeTrue();

    const referencedIds = new Set(
      manifestEntries
        .flat()
        .map((entry) => entry.resolvedRelationshipsArtifactId)
        .filter((id): id is string => Boolean(id)),
    );
    const storedIds = new Set(
      (await store.rows("relationships")).map((row) => String(row.artifact_id)),
    );
    expect(storedIds).toEqual(referencedIds);
  } finally {
    await store.shutdownCoordinator();
  }
});
