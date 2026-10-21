import { afterEach, expect, test } from "bun:test";

import {
  authorizeRequestedDecision,
  clearSessionApprovals,
  InputRequiredSignal,
  withApprovalContext,
} from "../src/runtime/approval";

afterEach(() => clearSessionApprovals());
const decision = {
  canonicalPath: "/requested",
  operation: "write" as const,
  policy: "request" as const,
  reason: "Host approval required",
  ruleId: "requested-path",
  source: "project" as const,
  specificity: 1,
  symlinks: false,
};
const server = { server: { getClientCapabilities: () => undefined } } as never;
function context(inputResponses?: unknown) {
  return {
    mcpReq: {
      envelope: {
        "io.modelcontextprotocol/clientCapabilities": { elicitation: {} },
      },
      inputResponses,
    },
  } as never;
}

test("modern stdio approvals use request capabilities and retain trusted connection grants", async () => {
  let responseKey = "";
  try {
    await withApprovalContext(
      { server, context: context(), tool: "file_write" },
      async () => authorizeRequestedDecision(decision, 1),
    );
  } catch (error) {
    expect(error).toBeInstanceOf(InputRequiredSignal);
    responseKey = Object.keys(
      (error as InputRequiredSignal).result.inputRequests!,
    )[0]!;
  }
  expect(responseKey).not.toBe("");
  expect(
    await withApprovalContext(
      {
        server,
        context: context({
          [responseKey]: {
            action: "accept",
            content: { decision: "allow_session" },
          },
        }),
        tool: "file_write",
      },
      async () => authorizeRequestedDecision(decision, 1),
    ),
  ).toBeTrue();
  expect(
    await withApprovalContext(
      { server, context: context(), tool: "file_write" },
      async () => authorizeRequestedDecision(decision, 1),
    ),
  ).toBeTrue();

  for (const selected of [
    decision,
    { ...decision, ruleId: "filesystem:effective-config" },
  ]) {
    for (const response of [
      undefined,
      {
        [responseKey]: {
          action: "accept",
          content: { decision: "allow_session" },
        },
      },
    ]) {
      await expect(
        withApprovalContext(
          {
            server,
            context: context(response),
            requestScoped: true,
            tool: "file_write",
          },
          async () => authorizeRequestedDecision(selected, 1),
        ),
      ).rejects.toMatchObject({ code: "approval_required" });
    }
  }
});
