import { Worker } from "node:worker_threads";

import {
  type WorkspaceHandle,
  withWorkspaceContext,
} from "../intelligence/workspace/context.ts";
import { createIntelligenceToolService } from "../tools/intelligence.ts";
import type { IntelligenceToolService } from "../tools/intelligence.ts";

type Input = Parameters<IntelligenceToolService["retrieve"]>[0];
type Work = {
  id: number;
  input: Input & { semantic: false };
  workspace: WorkspaceHandle;
};
type Failure = Pick<Error, "message" | "name"> & {
  code?: unknown;
  details?: unknown;
  retryable?: boolean;
  suggestedNextCall?: string;
};
type Reply = { id: number } & ({ result: unknown } | { error: Failure });

const laneLimit = 4;
const jobsPerLane = 8;
const requestByteLimit = 1024 * 1024;
const resultTextByteLimit = 1024 * 1024;
const utf8Bytes = (value: string) => Buffer.byteLength(value, "utf8");

function unavailable(message: string) {
  return Object.assign(new Error(message), {
    code: "retrieval_worker_unavailable",
    retryable: true,
  });
}

interface RetrievalPort {
  on(event: "message", listener: (work: Work) => Promise<void>): void;
  postMessage(reply: Reply): void;
}

export function runCommittedRetrievalWorker(
  port: RetrievalPort | null,
  service: Pick<
    IntelligenceToolService,
    "retrieve"
  > = createIntelligenceToolService(),
) {
  if (!port) throw new Error("Missing retrieval worker port");
  port.on("message", async ({ id, input, workspace }: Work) => {
    try {
      if (
        workspace.selectedRevision.selector.kind !== "commit" ||
        input.workspaceId !== workspace.workspaceId ||
        input.semantic !== false ||
        input.strictRead
      )
        throw new Error("Invalid committed retrieval worker request");
      const result = await withWorkspaceContext(workspace, () =>
        service.retrieve(input, workspace),
      );
      port.postMessage({ id, result } satisfies Reply);
    } catch (caught) {
      const error =
        caught instanceof Error ? caught : new Error(String(caught));
      const failure: Failure = {
        name: error.name,
        message: error.message,
        code: (error as Partial<Failure>).code,
        details: (error as Partial<Failure>).details,
        retryable: (error as Partial<Failure>).retryable,
        suggestedNextCall: (error as Partial<Failure>).suggestedNextCall,
      };
      try {
        port.postMessage({ id, error: failure } satisfies Reply);
      } catch {
        // Preserve the original error without an uncloneable details object.
        delete failure.details;
        port.postMessage({ id, error: failure } satisfies Reply);
      }
    }
  });
}

interface Pending {
  done: Promise<unknown>;
  reject(error: unknown): void;
  resolve(value: unknown): void;
}

interface WorkerChannel {
  on(event: "message", listener: (reply: Reply) => void): void;
  on(event: "error" | "messageerror", listener: (error: unknown) => void): void;
  once(event: "exit", listener: () => void): void;
  postMessage(message: Work): void;
  terminate(): Promise<number>;
}

interface Lane {
  worker: WorkerChannel;
  pending: Map<number, Pending>;
  failed: boolean;
  exited: Promise<void>;
}

export class CommittedRetrievalLanes {
  readonly #lanes = new Set<Lane>();
  #inline?: Promise<unknown>;
  #closing?: Promise<void>;
  #stopping = false;
  #next = 0;

  constructor(
    private readonly entry: string,
    private readonly workerFactory: (filename: string) => WorkerChannel = (
      filename,
    ) =>
      new Worker(filename, {
        workerData: { kind: "ast-mcp-committed-retrieval" },
      }),
  ) {}

  #create(): Lane {
    const worker = this.workerFactory(this.entry);
    const exit = Promise.withResolvers<void>();
    const lane: Lane = {
      worker,
      pending: new Map(),
      failed: false,
      exited: exit.promise,
    };
    const fail = (error: Error) => {
      lane.failed = true;
      for (const call of lane.pending.values()) call.reject(error);
      lane.pending.clear();
    };
    worker.on("message", (reply: Reply) => {
      const call = lane.pending.get(reply.id);
      if (!call) return;
      lane.pending.delete(reply.id);
      if ("error" in reply)
        call.reject(Object.assign(new Error(reply.error.message), reply.error));
      else call.resolve(reply.result);
    });
    worker.on("messageerror", () => {
      fail(unavailable("Could not deserialize committed retrieval result"));
      // No result can be trusted past a broken channel. Do not replay reads.
      void worker.terminate().catch(() => undefined);
    });
    worker.on("error", (error) => {
      fail(unavailable(error instanceof Error ? error.message : String(error)));
    });
    worker.once("exit", () => {
      fail(unavailable("Committed retrieval worker exited"));
      this.#lanes.delete(lane);
      exit.resolve();
    });
    this.#lanes.add(lane);
    return lane;
  }

  async retrieve(
    input: Input,
    workspace: WorkspaceHandle,
    inline: () => Promise<unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (this.#stopping) throw unavailable("Committed retrieval is closing");
    signal?.throwIfAborted();
    if (!this.#inline) {
      // A single reader uses its existing project graph and starts no thread.
      const active = Promise.resolve().then(inline);
      this.#inline = active;
      try {
        return await active;
      } finally {
        this.#inline = undefined;
      }
    }
    if (
      (input.budget?.maxBytes ?? 0) > resultTextByteLimit ||
      utf8Bytes(JSON.stringify([input, workspace])) > requestByteLimit
    )
      return inline();
    let lane: Lane | undefined;
    for (const candidate of this.#lanes) {
      if (
        !candidate.failed &&
        (!lane || candidate.pending.size < lane.pending.size)
      )
        lane = candidate;
    }
    if (lane?.pending.size !== 0 && this.#lanes.size < laneLimit) {
      try {
        lane = this.#create();
      } catch (error) {
        if (!lane)
          throw unavailable(
            error instanceof Error ? error.message : String(error),
          );
      }
    }
    if (!lane || lane.pending.size >= jobsPerLane)
      throw unavailable("Committed retrieval lanes are busy");
    const id = ++this.#next;
    const { promise: done, resolve, reject } = Promise.withResolvers<unknown>();
    lane.pending.set(id, { done, resolve, reject });
    try {
      lane.worker.postMessage({
        id,
        input: { ...input, semantic: false },
        workspace,
      } satisfies Work);
    } catch (error) {
      lane.pending.delete(id);
      throw error;
    }
    // Like the inline path, allow dispatched storage reads to close their
    // durable pin before settling, even when the caller cancels the request.
    const result = await done;
    signal?.throwIfAborted();
    return result;
  }

  close(): Promise<void> {
    this.#stopping = true;
    this.#closing ??= this.#drain();
    return this.#closing;
  }

  async #drain(): Promise<void> {
    const lanes = [...this.#lanes];
    await Promise.allSettled([
      this.#inline,
      ...lanes.flatMap(({ pending }) =>
        [...pending.values()].map(({ done }) => done),
      ),
    ]);
    await Promise.all(
      lanes.map(async ({ worker, exited }) => {
        await worker.terminate();
        await exited;
      }),
    );
  }
}
