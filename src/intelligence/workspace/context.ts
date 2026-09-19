import { AsyncLocalStorage } from "node:async_hooks";

import type { WorkspaceContext } from "../contracts/index.ts";
import { WorkspaceError } from "./errors.ts";
import type { GitWorkspaceIdentity } from "./git.ts";

export interface WorkspaceHandle extends WorkspaceContext {
  git: GitWorkspaceIdentity;
  openedAt: string;
}

const activeWorkspace = new AsyncLocalStorage<WorkspaceHandle>();

export function currentWorkspace(): WorkspaceHandle | undefined {
  return activeWorkspace.getStore();
}

export function withWorkspaceContext<T>(
  workspace: WorkspaceHandle,
  operation: () => T,
): T {
  return activeWorkspace.run(workspace, operation);
}

export function assertWorkspaceWritable(): void {
  const workspace = currentWorkspace();
  if (!workspace || workspace.writeEligibility.eligible) return;
  throw new WorkspaceError(
    "workspace_read_only",
    "The selected revision is read-only",
    {
      revision: workspace.selectedRevision,
      workspaceId: workspace.workspaceId,
      writeEligibility: workspace.writeEligibility,
    },
    false,
    "workspace_open with revision.kind=working",
  );
}
