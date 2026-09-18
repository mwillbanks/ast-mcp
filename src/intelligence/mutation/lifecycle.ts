import { AsyncLocalStorage } from "node:async_hooks";

import type {
  MutationBatchPlan,
  MutationFileCommit,
  MutationLifecycle,
  MutationRefreshResult,
} from "./types.ts";

const requestLifecycle = new AsyncLocalStorage<MutationLifecycle>();
let lifecycle: MutationLifecycle | null = null;

export function configureMutationLifecycle(
  next: MutationLifecycle | null,
): () => void {
  const previous = lifecycle;
  lifecycle = next;
  return () => {
    if (lifecycle === next) lifecycle = previous;
  };
}

export function activeMutationLifecycle(): MutationLifecycle | null {
  return requestLifecycle.getStore() ?? lifecycle;
}

export function withMutationLifecycle<T>(
  next: MutationLifecycle,
  operation: () => T,
): T {
  return requestLifecycle.run(next, operation);
}

export async function beginMutation(plan: MutationBatchPlan): Promise<void> {
  await activeMutationLifecycle()?.begin(plan);
}

export async function recordMutationCommit(
  operationId: string,
  file: MutationFileCommit,
): Promise<void> {
  await activeMutationLifecycle()?.committed(operationId, file);
}

export async function completeMutation(
  operationId: string,
  files: readonly MutationFileCommit[],
): Promise<MutationRefreshResult | null> {
  return (
    (await activeMutationLifecycle()?.complete(operationId, files)) ?? null
  );
}

export async function failMutation(
  operationId: string,
  error: unknown,
): Promise<void> {
  await activeMutationLifecycle()?.failed(operationId, error);
}

export async function recordMutationRollback(
  operationId: string,
): Promise<void> {
  await activeMutationLifecycle()?.rolledBack(operationId);
}
