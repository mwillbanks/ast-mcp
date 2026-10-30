import { afterEach, expect, test } from "bun:test";

import type { McpServer, ServerContext } from "@modelcontextprotocol/server";

import {
  approvalDiagnostics,
  authorizeRequestedDecision,
  clearSessionApprovals,
  InputRequiredSignal,
  recordApprovalTransportFailure,
  runApprovalProbe,
  supportsApprovalForm,
  withApprovalContext,
} from "../../src/runtime/approval";
import { codexApprovalMetadata } from "../../src/runtime/hosts/codex";
import registerDiagnosticTools from "../../src/tools/diagnostics";

afterEach(() => clearSessionApprovals());

const decision = {
  canonicalPath: "/private/repository/secret",
  operation: "write" as const,
  policy: "request" as const,
  source: "project" as const,
  reason: "private policy /private/repository/secret",
  ruleId: "path-rule",
  specificity: 1,
  symlinks: false,
};

function server(name = "generic-agent", elicitation: unknown = { form: {} }) {
  return {
    server: {
      getClientCapabilities: () =>
        elicitation === undefined ? {} : { elicitation },
      getClientVersion: () => ({ name, version: "1" }),
    },
  } as unknown as McpServer;
}

function context(sessionId = "same", inputResponses?: unknown) {
  return { sessionId, mcpReq: { inputResponses } } as ServerContext;
}

function authorize(
  instance: McpServer,
  ctx = context(),
  selected = decision,
  generation = 1,
) {
  return withApprovalContext(
    { server: instance, context: ctx, tool: "file_write" },
    async () => authorizeRequestedDecision(selected, generation),
  );
}

async function challenge(
  instance: McpServer,
  ctx = context(),
  selected = decision,
  generation = 1,
) {
  try {
    await authorize(instance, ctx, selected, generation);
    throw new Error("expected approval challenge");
  } catch (error) {
    expect(error).toBeInstanceOf(InputRequiredSignal);
    const result = (error as InputRequiredSignal).result;
    return { key: Object.keys(result.inputRequests!)[0]!, result };
  }
}

test("form capability checks retain legacy declarations and reject URL-only or malformed forms", () => {
  expect(supportsApprovalForm({ elicitation: {} })).toBeTrue();
  expect(supportsApprovalForm({ elicitation: { form: {} } })).toBeTrue();
  for (const capabilities of [
    undefined,
    {},
    { elicitation: { url: {} } },
    { elicitation: false },
    { elicitation: { form: null } },
    { elicitation: { form: [] } },
  ])
    expect(supportsApprovalForm(capabilities)).toBeFalse();
});

test("Codex metadata remains isolated from other hosts", async () => {
  for (const name of ["claude", "claude-desktop", "grok", "generic-agent"]) {
    expect(codexApprovalMetadata({ name })).toBeUndefined();
    const pending = await challenge(server(name));
    expect(JSON.stringify(pending.result)).not.toContain("codex_approval_kind");
  }
  for (const name of ["codex", "codex-cli", "Codex Desktop", "openai-codex"]) {
    expect(codexApprovalMetadata({ name })).toMatchObject({
      codex_approval_kind: "mcp_tool_call",
    });
  }
  const pending = await challenge(server("codex-cli"));
  expect(JSON.stringify(pending.result)).toContain("codex_approval_kind");
});

test("decline, explicit denial, cancellation and malformed responses remain distinct and sanitized", async () => {
  for (const [response, outcome, code, retryable] of [
    [{ action: "decline" }, "declined", "approval_denied", false],
    [
      { action: "accept", content: { decision: "deny" } },
      "denied",
      "approval_denied",
      false,
    ],
    [{ action: "cancel" }, "cancelled", "approval_cancelled", true],
    [
      { action: "accept", content: { decision: "invalid" } },
      "malformed",
      "approval_response_invalid",
      true,
    ],
  ] as const) {
    const instance = server();
    const pending = await challenge(instance);
    let failure: unknown;
    try {
      await authorize(instance, context("same", { [pending.key]: response }));
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code,
      retryable,
      details: {
        outcome,
        actor: "unknown",
        source: "project",
        policy: "request",
      },
    });
    expect(String(failure)).not.toContain("User denied");
    expect(JSON.stringify(failure)).not.toContain("/private/repository");
    expect(approvalDiagnostics(instance, context())).toMatchObject({
      pendingCount: 0,
      sessionGrantPresent: false,
      lastOutcome: { outcome },
    });
    const fresh = await challenge(instance);
    expect(fresh.key).not.toBe(pending.key);
  }
});

test("session grants reject replay across server, session, generation and expired challenges", async () => {
  const instance = server();
  const pending = await challenge(instance);
  const accept = {
    [pending.key]: { action: "accept", content: { decision: "allow_session" } },
  };
  await expect(
    authorize(instance, context("other", accept)),
  ).rejects.toBeInstanceOf(InputRequiredSignal);
  await expect(
    authorize(server(), context("same", accept)),
  ).rejects.toBeInstanceOf(InputRequiredSignal);
  expect(await authorize(instance, context("same", accept))).toBeTrue();
  expect(await authorize(instance)).toBeTrue();
  await expect(
    authorize(instance, context(), decision, 2),
  ).rejects.toBeInstanceOf(InputRequiredSignal);
  clearSessionApprovals("same", instance);
  await expect(
    authorize(instance, context("same", accept)),
  ).rejects.toBeInstanceOf(InputRequiredSignal);
});

test("one timeout cannot clear another session's identical prompt", async () => {
  const instance = server();
  const first = await challenge(instance, context("first"));
  const second = await challenge(instance, context("second"));
  recordApprovalTransportFailure(
    instance,
    first.key,
    Object.assign(new Error("timeout"), { name: "TimeoutError" }),
  );
  expect(approvalDiagnostics(instance, context("first"))).toMatchObject({
    pendingCount: 0,
    lastOutcome: { outcome: "timeout" },
  });
  expect(approvalDiagnostics(instance, context("second"))).toMatchObject({
    pendingCount: 1,
    lastOutcome: null,
  });
  expect(
    await authorize(
      instance,
      context("second", {
        [second.key]: {
          action: "accept",
          content: { decision: "allow_session" },
        },
      }),
    ),
  ).toBeTrue();
});

test("an expired native challenge cannot replay acceptance", async () => {
  const instance = server();
  const pending = await challenge(instance);
  const originalNow = Date.now;
  Date.now = () => originalNow() + 300_001;
  try {
    expect(approvalDiagnostics(instance, context())).toMatchObject({
      pendingCount: 0,
      lastOutcome: { outcome: "timeout" },
    });
    await expect(
      authorize(
        instance,
        context("same", {
          [pending.key]: {
            action: "accept",
            content: { decision: "allow_session" },
          },
        }),
      ),
    ).rejects.toBeInstanceOf(InputRequiredSignal);
  } finally {
    Date.now = originalNow;
  }
});

test("probe acceptance never creates a grant and each subsequent probe requires fresh input", async () => {
  const instance = server();
  const invoke = (ctx: ServerContext) =>
    withApprovalContext(
      { server: instance, context: ctx, tool: "approval_probe" },
      async () => runApprovalProbe(),
    );
  let responseKey = "";
  try {
    await invoke(context());
  } catch (error) {
    expect(error).toBeInstanceOf(InputRequiredSignal);
    responseKey = Object.keys(
      (error as InputRequiredSignal).result.inputRequests!,
    )[0]!;
  }
  expect(
    await invoke(
      context("same", {
        [responseKey]: {
          action: "accept",
          content: { decision: "allow_once" },
        },
      }),
    ),
  ).toEqual({ outcome: "accepted" });
  expect(
    approvalDiagnostics(instance, context()).sessionGrantPresent,
  ).toBeFalse();
  await expect(invoke(context())).rejects.toBeInstanceOf(InputRequiredSignal);
  clearSessionApprovals(undefined, instance);
  expect(approvalDiagnostics(instance, context())).toMatchObject({
    pendingCount: 0,
    sessionGrantPresent: false,
    lastOutcome: null,
  });
});

test("slow registry checks cannot consume a resumed probe challenge", async () => {
  const instance = server("codex-cli");
  const handlers = new Map<
    string,
    (args: object, ctx: ServerContext) => Promise<any>
  >();
  instance.registerTool = ((name: string, _schema: unknown, handler: any) => {
    handlers.set(name, handler);
  }) as typeof instance.registerTool;
  const releases: Array<() => void> = [];
  registerDiagnosticTools(instance, {
    fetch: (async () =>
      new Promise<Response>((resolve) => {
        releases.push(() => resolve(Response.json({ version: "0.0.1" })));
      })) as unknown as typeof fetch,
  });
  const handler = handlers.get("approval_probe")!;
  const first = await handler({}, context());
  const key = Object.keys(first.inputRequests)[0]!;
  const resumed = handler(
    {},
    context("same", {
      [key]: { action: "accept", content: { decision: "allow_once" } },
    }),
  );
  expect(approvalDiagnostics(instance, context())).toMatchObject({
    pendingCount: 0,
    sessionGrantPresent: false,
    lastOutcome: { outcome: "accepted" },
  });
  const now = Date.now;
  Date.now = () => now() + 6000;
  try {
    for (const resolve of releases) resolve();
    expect(await resumed).toMatchObject({
      structuredContent: { data: { outcome: "accepted" } },
    });
  } finally {
    Date.now = now;
    for (const resolve of releases) resolve();
  }
});
