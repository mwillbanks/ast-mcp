import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolveConfig } from "../../src/config";
import {
  approvalSessionId,
  authorizeRequestedDecision,
  clearSessionApprovals,
  grantUnrestrictedFilesystem,
  InputRequiredSignal,
  unrestrictedFilesystemAuthorized,
  withApprovalContext,
} from "../../src/runtime/approval";
import { hermeticConfig } from "../support/hermetic-config";

afterEach(() => clearSessionApprovals());

function scope(sessionId: string, inputResponses?: unknown) {
  return {
    context: { sessionId, mcpReq: { inputResponses } },
    server: { server: { getClientCapabilities: () => ({ elicitation: {} }) } },
    tool: "file_write",
  } as never;
}

test("persistent approval refuses legacy global configuration and removes its lock", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "ast-mcp-approval-legacy-"),
  );
  const previous = {
    APPDATA: process.env.APPDATA,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  };
  process.env.APPDATA = root;
  process.env.XDG_CONFIG_HOME = root;
  const file = path.join(root, "ast-mcp/ast-mcp.toml");
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "version = 1\n");
    const decision = {
      canonicalPath: path.join(root, "data.txt"),
      operation: "write" as const,
      policy: "request" as const,
      reason: "test",
      ruleId: "test",
      source: "project" as const,
      specificity: 1,
      symlinks: false,
    };
    let key = "";
    try {
      await withApprovalContext(scope("legacy"), async () =>
        authorizeRequestedDecision(decision, 1),
      );
    } catch (error) {
      expect(error).toBeInstanceOf(InputRequiredSignal);
      key = Object.keys(
        (error as InputRequiredSignal).result.inputRequests!,
      )[0]!;
    }
    expect(key).not.toBe("");
    await expect(
      withApprovalContext(
        scope("legacy", {
          [key]: { action: "accept", content: { decision: "always_allow" } },
        }),
        async () => authorizeRequestedDecision(decision, 1),
      ),
    ).rejects.toMatchObject({
      code: "approval_persistence_required",
      retryable: true,
    });
    expect(await readFile(file, "utf8")).toBe("version = 1\n");
    expect(await Bun.file(file + ".approval.lock").exists()).toBeFalse();

    await expect(
      withApprovalContext(
        scope("legacy", {
          [key]: { action: "accept", content: { decision: "invalid" } },
        }),
        async () => authorizeRequestedDecision(decision, 1),
      ),
    ).rejects.toBeInstanceOf(InputRequiredSignal);
    clearSessionApprovals("legacy");
    await expect(
      withApprovalContext(
        scope("legacy", {
          [key]: { action: "accept", content: { decision: "allow_once" } },
        }),
        async () => authorizeRequestedDecision(decision, 1),
      ),
    ).rejects.toBeInstanceOf(InputRequiredSignal);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("session clearing revokes only its own unrestricted filesystem grants", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "ast-mcp-filesystem-grants-"),
  );
  try {
    const restricted = await resolveConfig(hermeticConfig(root));
    const config = {
      ...restricted,
      safety: { ...restricted.safety, filesystem: "unrestricted" as const },
      provenance: {
        ...restricted.provenance,
        "safety.filesystem": "project" as const,
      },
    };
    expect(approvalSessionId()).toBe("local");
    expect(unrestrictedFilesystemAuthorized(restricted)).toBeFalse();
    const first = scope("first");
    const second = scope("second");
    for (const active of [first, second]) {
      await withApprovalContext(active, async () => {
        grantUnrestrictedFilesystem(config);
        expect(unrestrictedFilesystemAuthorized(config)).toBeTrue();
      });
    }
    clearSessionApprovals("first");
    await withApprovalContext(first, async () =>
      expect(unrestrictedFilesystemAuthorized(config)).toBeFalse(),
    );
    await withApprovalContext(second, async () =>
      expect(unrestrictedFilesystemAuthorized(config)).toBeTrue(),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
