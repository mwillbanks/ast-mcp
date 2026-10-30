import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolveConfig } from "../../src/config";
import {
  approvalDiagnostics,
  approvalSessionId,
  authorizeRequestedDecision,
  clearSessionApprovals,
  grantUnrestrictedFilesystem,
  InputRequiredSignal,
  unrestrictedFilesystemAuthorized,
  withApprovalContext,
} from "../../src/runtime/approval";
import { hermeticConfig } from "../support/hermetic-config";

const servers = new Map<string, object>();
afterEach(() => {
  clearSessionApprovals();
  servers.clear();
});

function scope(sessionId: string, inputResponses?: unknown) {
  if (!servers.has(sessionId))
    servers.set(sessionId, {
      server: { getClientCapabilities: () => ({ elicitation: {} }) },
    });
  return {
    context: { sessionId, mcpReq: { inputResponses } },
    server: servers.get(sessionId),
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
    ).rejects.toMatchObject({
      code: "approval_response_invalid",
      retryable: true,
    });
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

test("persistent approvals preserve customized rules and merge only canonical generated rules", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "ast-mcp-approval-ownership-"),
  );
  const previous = {
    APPDATA: process.env.APPDATA,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  };
  process.env.APPDATA = root;
  process.env.XDG_CONFIG_HOME = root;
  const file = path.join(root, "ast-mcp/ast-mcp.toml");
  const target = path.join(root, "data.txt");
  const generatedId = (operation: string) =>
    `approval-${createHash("sha256").update(`${operation}\u0000${target}`).digest("hex").slice(0, 16)}`;
  const rule = (id: string, policies: string, suffix = "") =>
    [
      "[[paths]]",
      `id = ${JSON.stringify(id)}`,
      `path = ${JSON.stringify(target)}`,
      `policies = { ${policies} }`,
      "follow_symlinks = false",
      'includes = ["**/*"]',
      "excludes = []",
      suffix,
    ]
      .filter(Boolean)
      .join("\n") + "\n";
  let generation = 0;
  const approve = async (operation: "read" | "write" | "delete") => {
    const decision = {
      canonicalPath: target,
      operation,
      policy: "request" as const,
      reason: "test",
      ruleId: "project-rule",
      source: "project" as const,
      specificity: 1,
      symlinks: false,
    };
    const current = ++generation;
    let key = "";
    try {
      await withApprovalContext(scope("ownership"), async () =>
        authorizeRequestedDecision(decision, current),
      );
    } catch (error) {
      expect(error).toBeInstanceOf(InputRequiredSignal);
      key = Object.keys(
        (error as InputRequiredSignal).result.inputRequests!,
      )[0]!;
    }
    expect(key).not.toBe("");
    return withApprovalContext(
      scope("ownership", {
        [key]: { action: "accept", content: { decision: "always_allow" } },
      }),
      async () => authorizeRequestedDecision(decision, current),
    );
  };
  try {
    await mkdir(path.dirname(file), { recursive: true });
    const customizations = [
      rule(
        "approval-team",
        'read = "allow", write = "request", delete = "request"',
      ),
      rule(
        generatedId("read"),
        'read = "allow", write = "deny", delete = "request"',
      ),
      rule(
        generatedId("read"),
        'read = "allow", write = "deny", delete = "deny"',
      ).replace('includes = ["**/*"]', 'includes = ["*.txt"]'),
      rule(
        generatedId("read"),
        'read = "allow", write = "deny", delete = "deny"',
        "priority = 1",
      ),
    ];
    for (const customized of customizations) {
      const original = "version = 2\n\n" + customized;
      await writeFile(file, original);
      await expect(approve("write")).rejects.toMatchObject({
        code: "approval_persistence_conflict",
        retryable: true,
      });
      expect(await readFile(file, "utf8")).toBe(original);
      expect(
        approvalDiagnostics(
          servers.get("ownership") as never,
          { sessionId: "ownership" } as never,
        ).sessionGrantPresent,
      ).toBeFalse();
      expect(await Bun.file(file + ".approval.lock").exists()).toBeFalse();
      clearSessionApprovals();
    }
    const decoy =
      [
        "[[paths]]",
        'id = "team-rule"',
        `path = ${JSON.stringify(path.join(root, "other.txt"))}`,
        `# id = "${generatedId("read")}"`,
        'policies = { read = "request", write = "deny", delete = "request" }',
      ].join("\n") + "\n";
    await writeFile(
      file,
      "version = 2\n\n" +
        rule(
          generatedId("read"),
          'read = "allow", write = "deny", delete = "deny"',
        ) +
        "\n" +
        decoy,
    );
    expect(await approve("write")).toBeTrue();
    const merged = await readFile(file, "utf8");
    expect(merged.endsWith(decoy)).toBeTrue();
    const parsed = Bun.TOML.parse(merged) as {
      paths: { id: string; policies: Record<string, string> }[];
    };
    expect(parsed.paths).toHaveLength(2);
    expect(parsed.paths[0]!.policies).toEqual({
      read: "allow",
      write: "allow",
      delete: "deny",
    });
    expect(parsed.paths[1]!.policies).toEqual({
      read: "request",
      write: "deny",
      delete: "request",
    });
    clearSessionApprovals();
    expect(await approve("read")).toBeTrue();
    expect(await readFile(file, "utf8")).toBe(merged);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
