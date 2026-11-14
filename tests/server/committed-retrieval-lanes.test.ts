import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { join } from "node:path";

import type { WorkspaceHandle } from "../../src/intelligence/workspace/context.ts";
import {
  CommittedRetrievalLanes,
  runCommittedRetrievalWorker,
} from "../../src/server/committed-retrieval-lanes.ts";
import { RetrieveInputSchema } from "../../src/tools/intelligence.ts";

class WorkerPeer extends EventEmitter {
  readonly posted: Array<{ id: number }> = [];
  terminated = false;
  postFailure?: Error;
  terminationFailure?: Error;

  postMessage(value: { id: number }): void {
    if (this.postFailure) throw this.postFailure;
    this.posted.push(value);
  }

  reply(index = 0): void {
    this.emit("message", { id: this.posted.at(index)!.id, result: "worker" });
  }

  async terminate(): Promise<number> {
    this.terminated = true;
    this.emit("exit", 0);
    if (this.terminationFailure) throw this.terminationFailure;
    return 0;
  }
}

const workspaceId = "workspace:v1:" + "a".repeat(64);
const workspace = { workspaceId } as WorkspaceHandle;
const input = RetrieveInputSchema.parse({ query: "anchor", workspaceId });

test("keeps sole reads inline and bounds active clone jobs across lanes", async () => {
  const peers: WorkerPeer[] = [];
  const lanes = new CommittedRetrievalLanes("unused", () => {
    const peer = new WorkerPeer();
    peers.push(peer);
    return peer;
  });
  expect(await lanes.retrieve(input, workspace, async () => "inline")).toBe(
    "inline",
  );
  expect(peers).toHaveLength(0);
  const gate = Promise.withResolvers<string>();
  const local = lanes.retrieve(input, workspace, () => gate.promise);
  const work = Array.from({ length: 32 }, () =>
    lanes.retrieve(input, workspace, async () => "unexpected"),
  );
  expect(peers.map((peer) => peer.posted.length)).toEqual([8, 8, 8, 8]);
  await expect(
    lanes.retrieve(input, workspace, async () => "overflow"),
  ).rejects.toMatchObject({ code: "retrieval_worker_unavailable" });
  gate.resolve("inline");
  for (const peer of peers)
    for (let call = 0; call < peer.posted.length; call++) peer.reply(call);
  expect(await local).toBe("inline");
  expect(await Promise.all(work)).toEqual(Array(32).fill("worker"));
  await lanes.close();
  expect(peers.every(({ terminated }) => terminated)).toBeTrue();
});

test("cancellation and closing wait for dispatched worker cleanup", async () => {
  const peer = new WorkerPeer();
  const lanes = new CommittedRetrievalLanes("unused", () => peer);
  const gate = Promise.withResolvers<void>();
  const local = lanes.retrieve(input, workspace, () => gate.promise);
  const controller = new AbortController();
  const remote = lanes.retrieve(
    input,
    workspace,
    async () => "unexpected",
    controller.signal,
  );
  const cancelled = remote.catch((error: unknown) => error);
  controller.abort(new Error("Cancelled by host"));
  const closing = lanes.close();
  await expect(
    lanes.retrieve(input, workspace, async () => "unexpected"),
  ).rejects.toMatchObject({ code: "retrieval_worker_unavailable" });
  expect(peer.terminated).toBeFalse();
  gate.resolve();
  await local;
  expect(peer.terminated).toBeFalse();
  expect(peer.posted).toHaveLength(1);
  peer.reply();
  expect(await cancelled).toEqual(new Error("Cancelled by host"));
  await closing;
  expect(peer.terminated).toBeTrue();
});

test("retains worker error details and retires a failed thread without replay", async () => {
  const peer = new WorkerPeer();
  const lanes = new CommittedRetrievalLanes("unused", () => peer);
  const gate = Promise.withResolvers<void>();
  const local = lanes.retrieve(input, workspace, () => gate.promise);
  const remote = lanes.retrieve(input, workspace, async () => "unexpected");
  peer.emit("message", { id: -1, result: "stale worker reply" });
  const failure = {
    code: "mixed_generation",
    details: { generationId: "missing" },
    message: "Reader pin has expired",
    name: "ReaderPinExpiredError",
    retryable: false,
  };
  peer.emit("message", { id: peer.posted[0]!.id, error: failure });
  await expect(remote).rejects.toMatchObject(failure);
  const interrupted = lanes.retrieve(input, workspace, async () => "replay");
  peer.emit("error", new Error("Native worker failed"));
  peer.emit("exit", 1);
  await expect(interrupted).rejects.toMatchObject({
    code: "retrieval_worker_unavailable",
  });
  expect(peer.posted).toHaveLength(2);
  gate.resolve();
  await local;
  await lanes.close();
});

test("worker verifies immutable lexical scope and preserves error payloads", async () => {
  type Port = NonNullable<Parameters<typeof runCommittedRetrievalWorker>[0]>;
  type Work = Parameters<Parameters<Port["on"]>[1]>[0];
  type Reply = Parameters<Port["postMessage"]>[0];
  const replies: Reply[] = [];
  let handle!: (message: Work) => Promise<void>;
  const selected = {
    ...workspace,
    selectedRevision: { selector: { kind: "commit" } },
  } as WorkspaceHandle;
  const work = {
    id: 3,
    input: { ...input, semantic: false as const },
    workspace: selected,
  };
  let fail = false;
  const failure = Object.assign(new Error("Pin mismatch"), {
    code: "mixed_generation",
    details: () => "uncloneable",
    retryable: false,
    suggestedNextCall: "workspace_open",
  });
  const service = {
    async retrieve(_input: typeof input, workspace: WorkspaceHandle) {
      if (fail) throw failure;
      return { workspaceId: workspace.workspaceId };
    },
  };
  const port: Port = {
    on(_event, listener) {
      handle = listener;
    },
    postMessage(reply) {
      if ("error" in reply && typeof reply.error.details === "function")
        throw new Error("Uncloneable error details");
      replies.push(reply);
    },
  };
  runCommittedRetrievalWorker(port);
  runCommittedRetrievalWorker(port, service);
  await handle(work);
  await handle({ ...work, input: { ...work.input, strictRead: true } });
  fail = true;
  await handle(work);
  expect(replies).toEqual([
    { id: 3, result: { workspaceId } },
    {
      id: 3,
      error: {
        code: undefined,
        details: undefined,
        message: "Invalid committed retrieval worker request",
        name: "Error",
        retryable: undefined,
        suggestedNextCall: undefined,
      },
    },
    {
      id: 3,
      error: {
        code: "mixed_generation",
        message: "Pin mismatch",
        name: "Error",
        retryable: false,
        suggestedNextCall: "workspace_open",
      },
    },
  ]);
  expect(() => runCommittedRetrievalWorker(null, service)).toThrow(
    "Missing retrieval worker port",
  );
});

test("oversized requests stay inline and synchronous post failure is not replayed", async () => {
  const peer = new WorkerPeer();
  const lanes = new CommittedRetrievalLanes("unused", () => peer);
  const gate = Promise.withResolvers<void>();
  const local = lanes.retrieve(input, workspace, () => gate.promise);
  const large = RetrieveInputSchema.parse({
    ...input,
    budget: { maxBytes: 2_000_000 },
  });
  expect(await lanes.retrieve(large, workspace, async () => "inline")).toBe(
    "inline",
  );
  expect(peer.posted).toHaveLength(0);
  peer.postFailure = new Error("Could not post");
  await expect(
    lanes.retrieve(input, workspace, async () => "unexpected"),
  ).rejects.toThrow("Could not post");
  peer.postFailure = undefined;
  const remote = lanes.retrieve(input, workspace, async () => "unexpected");
  peer.reply();
  expect(await remote).toBe("worker");
  gate.resolve();
  await local;
  await lanes.close();
});

test("a broken worker channel rejects pending reads and cannot replay them", async () => {
  const peer = new WorkerPeer();
  const lanes = new CommittedRetrievalLanes("unused", () => peer);
  const gate = Promise.withResolvers<void>();
  const local = lanes.retrieve(input, workspace, () => gate.promise);
  const remote = lanes.retrieve(input, workspace, async () => "unexpected");
  peer.terminationFailure = new Error("Worker had already stopped");
  peer.emit("messageerror", new Error("Message failed"));
  await expect(remote).rejects.toMatchObject({
    code: "retrieval_worker_unavailable",
    message: "Could not deserialize committed retrieval result",
  });
  expect(peer.posted).toHaveLength(1);
  expect(peer.terminated).toBeTrue();
  gate.resolve();
  await local;
  await lanes.close();
});

test("worker construction failure is reported before any dispatch", async () => {
  const lanes = new CommittedRetrievalLanes("unused", () => {
    throw new Error("Worker is unavailable");
  });
  const gate = Promise.withResolvers<void>();
  const local = lanes.retrieve(input, workspace, () => gate.promise);
  await expect(
    lanes.retrieve(input, workspace, async () => "unexpected"),
  ).rejects.toMatchObject({
    code: "retrieval_worker_unavailable",
    message: "Worker is unavailable",
  });
  gate.resolve();
  await local;
  await lanes.close();
});

test("the real worker constructor reports an unavailable entry", async () => {
  const lanes = new CommittedRetrievalLanes(
    join(import.meta.dir, "missing-committed-retrieval-entry.ts"),
  );
  const gate = Promise.withResolvers<void>();
  const local = lanes.retrieve(input, workspace, () => gate.promise);
  try {
    await expect(
      lanes.retrieve(input, workspace, async () => "unexpected"),
    ).rejects.toMatchObject({ code: "retrieval_worker_unavailable" });
  } finally {
    gate.resolve();
    await local;
    await lanes.close();
  }
});
