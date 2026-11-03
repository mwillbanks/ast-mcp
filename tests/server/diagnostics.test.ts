import { beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/client";
import {
  createMcpHandler,
  InMemoryTransport,
  type ServerContext,
} from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

import packageJson from "../../package.json" with { type: "json" };
import { clearConfigCache } from "../../src/config";
import { configRegistry } from "../../src/config/registry";
import {
  approvalDiagnostics,
  clearSessionApprovals,
} from "../../src/runtime/approval";
import { collectDiagnostics } from "../../src/runtime/diagnostics";
import { createServer } from "../../src/server";
import { createMockTime, deferred, type MockTime } from "../support/mock-time";

let time: MockTime;
beforeEach(() => {
  time = createMockTime();
});

async function fixture(timeoutMs = 1000) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-diagnostics-"));
  const external = await mkdtemp(
    path.join(os.tmpdir(), "ast-mcp-diagnostics-external-"),
  );
  await writeFile(path.join(external, "value.txt"), "authorized value");
  await mkdir(path.join(root, ".git"));
  await writeFile(
    path.join(root, "ast-mcp.toml"),
    'version = 2\n[safety]\nfilesystem = "unrestricted"\n[formatting]\nenabled = false\n',
  );
  await writeFile(path.join(root, "value.txt"), "authorized value");
  const old = {
    APPDATA: process.env.APPDATA,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    AST_MCP_PROJECT_ROOT: process.env.AST_MCP_PROJECT_ROOT,
  };
  process.env.APPDATA = root;
  process.env.XDG_CONFIG_HOME = root;
  process.env.AST_MCP_PROJECT_ROOT = root;
  clearConfigCache();
  let fetchCalls = 0;
  const server = createServer(
    {},
    { globalEnabled: async () => false },
    {},
    {
      approvalTimeoutMs: timeoutMs,
      transport: "stdio",
      diagnosticsFetch: (async () => {
        fetchCalls++;
        return Response.json({ version: packageJson.version });
      }) as unknown as typeof fetch,
    },
  );
  return {
    root,
    external,
    server,
    fetchCalls: () => fetchCalls,
    async close() {
      await server.close();
      for (const [key, value] of Object.entries(old)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      clearConfigCache();
      clearSessionApprovals();
      configRegistry.close();
      await rm(root, { recursive: true, force: true });
      await rm(external, { recursive: true, force: true });
    },
  };
}

test("legacy Codex rejection remains diagnosable and probe acceptance never grants filesystem access", async () => {
  const instance = await fixture();
  const client = new Client(
    { name: "codex-cli", version: "test" },
    {
      capabilities: { elicitation: { form: {} }, roots: {} },
      supportedProtocolVersions: ["2025-11-25"],
    },
  );
  let mode = "probe";
  client.setRequestHandler("roots/list", async () => ({
    roots: [{ uri: Bun.pathToFileURL(instance.root).href }],
  }));
  client.setRequestHandler("elicitation/create", async (request) => {
    expect(request.params._meta?.codex_approval_kind).toBe("mcp_tool_call");
    if (mode === "probe")
      return { action: "accept", content: { decision: "allow_once" } };
    if (mode === "accept")
      return { action: "accept", content: { decision: "allow_session" } };
    return { action: "decline" };
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await instance.server.connect(serverTransport);
    await client.connect(clientTransport);
    const probe = await client.callTool({
      name: "approval_probe",
      arguments: {},
    });
    expect(probe.structuredContent).toMatchObject({
      data: { outcome: "accepted" },
    });
    expect(
      approvalDiagnostics(instance.server).sessionGrantPresent,
    ).toBeFalse();
    mode = "decline";
    const read = () =>
      client.callTool({
        name: "file_read",
        arguments: {
          files: [
            {
              filePath: path.join(instance.external, "value.txt"),
              mode: "text",
            },
          ],
        },
      });
    const denied = await read();
    expect(denied.structuredContent).toMatchObject({
      error: {
        code: "approval_denied",
        details: { outcome: "declined", actor: "unknown" },
      },
    });
    const diagnostics = await client.callTool({
      name: "diagnostics",
      arguments: {},
    });
    expect(diagnostics.structuredContent).toMatchObject({
      data: {
        client: {
          name: "codex-cli",
          activeApprovalPolicy: "unknown",
          formElicitation: true,
          capabilities: {
            formElicitation: true,
            urlElicitation: false,
            roots: true,
            sampling: false,
          },
        },
        configuration: {
          filesystem: "unrestricted",
          filesystemSource: "project",
        },
        approval: {
          sessionGrantPresent: false,
          lastOutcome: { outcome: "declined" },
        },
        versionCheck: { status: "current" },
      },
    });
    expect(JSON.stringify(diagnostics)).not.toContain(instance.root);
    expect(instance.fetchCalls()).toBeGreaterThanOrEqual(3);
    mode = "accept";
    expect((await read()).isError).not.toBeTrue();
    expect((await read()).isError).not.toBeTrue();
  } finally {
    await client.close();
    await instance.close();
  }
  expect(approvalDiagnostics(instance.server).lastOutcome).toBeNull();
});

test("legacy probe timeout remains bounded and records sanitized timeout state", async () => {
  const instance = await fixture(30);
  const client = new Client(
    { name: "claude-desktop", version: "test" },
    {
      capabilities: { elicitation: { form: {} } },
      supportedProtocolVersions: ["2025-11-25"],
    },
  );
  const started = deferred<void>();
  client.setRequestHandler("elicitation/create", async (request) => {
    expect(request.params._meta?.codex_approval_kind).toBeUndefined();
    started.resolve();
    return new Promise<never>(() => {});
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await instance.server.connect(serverTransport);
    await client.connect(clientTransport);
    const pending = client.callTool({
      name: "approval_probe",
      arguments: {},
    });
    await started.promise;
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await time.advanceBy(29);
    expect(settled).toBe(false);
    await time.advanceBy(1);
    const probe = await pending;
    expect(probe.isError).toBeTrue();
    expect(approvalDiagnostics(instance.server)).toMatchObject({
      pendingCount: 0,
      sessionGrantPresent: false,
      lastOutcome: { outcome: "timeout" },
    });
    expect(await client.ping()).toEqual({});
  } finally {
    await client.close();
    await instance.close();
  }
});

test("native protocol approvals preserve denial and recover through correlated accepted input", async () => {
  const instance = await fixture();
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  let nextId = 0;
  const pending = new Map<number, (message: any) => void>();
  clientTransport.onmessage = (message) => {
    if ("id" in message && typeof message.id === "number")
      pending.get(message.id)?.(message);
  };
  const request = async (
    name: string,
    args: Record<string, unknown> = {},
    inputResponses?: unknown,
  ) => {
    const id = ++nextId;
    const promise = new Promise<any>((resolve) => pending.set(id, resolve));
    await clientTransport.send({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: {
        name,
        arguments: args,
        ...(inputResponses ? { inputResponses } : {}),
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": {
            name: "grok",
            version: "test",
          },
          "io.modelcontextprotocol/clientCapabilities": {
            elicitation: { form: {} },
          },
        },
      },
    });
    const result = await promise;
    pending.delete(id);
    expect(result.error, JSON.stringify(result)).toBeUndefined();
    return result.result;
  };
  const serving = serveStdio(() => instance.server, {
    transport: serverTransport,
  });
  try {
    await clientTransport.start();
    const args = {
      files: [
        { filePath: path.join(instance.external, "value.txt"), mode: "text" },
      ],
    };
    const first = await request("file_read", args);
    expect(first.inputRequests, JSON.stringify(first)).toBeDefined();
    const key = Object.keys(first.inputRequests)[0]!;
    expect(JSON.stringify(first)).not.toContain("codex_approval_kind");
    const denied = await request("file_read", args, {
      [key]: { action: "decline" },
    });
    expect(denied.structuredContent).toMatchObject({
      error: { code: "approval_denied", details: { outcome: "declined" } },
    });
    const diagnostic = await request("diagnostics");
    expect(diagnostic.structuredContent.data.approval.lastOutcome.outcome).toBe(
      "declined",
    );
    expect(diagnostic.structuredContent.data.recovery.join(" ")).not.toContain(
      "For Codex",
    );
    const second = await request("file_read", args);
    const freshKey = Object.keys(second.inputRequests)[0]!;
    expect(freshKey).not.toBe(key);
    const accepted = await request("file_read", args, {
      [freshKey]: { action: "accept", content: { decision: "allow_session" } },
    });
    expect(accepted.isError).not.toBeTrue();
    expect(JSON.stringify(accepted)).toContain("authorized value");
    expect((await request("file_read", args)).isError).not.toBeTrue();
  } finally {
    await clientTransport.close();
    await serving.close();
    await instance.close();
  }
});

test("diagnostics still checks releases when configuration is malformed", async () => {
  const instance = await fixture();
  const client = new Client({ name: "claude", version: "test" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await writeFile(
      path.join(instance.root, "ast-mcp.toml"),
      "version = [invalid",
    );
    clearConfigCache();
    configRegistry.invalidate();
    await instance.server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({
      name: "diagnostics",
      arguments: {},
    });
    expect(result.structuredContent).toMatchObject({
      data: {
        configuration: { healthy: false, reason: "configuration_unavailable" },
        versionCheck: { status: "current", latestVersion: packageJson.version },
      },
    });
    expect(instance.fetchCalls()).toBe(1);
    expect(JSON.stringify(result)).not.toContain(instance.root);
  } finally {
    await client.close();
    await instance.close();
  }
});

for (const configDecision of ["allow_once", "allow_session"] as const) {
  test(
    configDecision +
      " configuration approval cannot activate unrestricted filesystem access",
    async () => {
      const instance = await fixture();
      const client = new Client(
        { name: "generic-agent", version: "test" },
        {
          capabilities: { elicitation: { form: {} }, roots: {} },
          supportedProtocolVersions: ["2025-11-25"],
        },
      );
      const deniedPath = path.join(instance.external, "denied.txt");
      let phase:
        | "configuration"
        | "decline filesystem"
        | "activate filesystem" = "configuration";
      let approvals = 0;
      client.setRequestHandler("roots/list", async () => ({
        roots: [{ uri: Bun.pathToFileURL(instance.root).href }],
      }));
      client.setRequestHandler("elicitation/create", async () => {
        approvals++;
        if (phase === "configuration")
          return { action: "accept", content: { decision: configDecision } };
        if (phase === "decline filesystem") return { action: "decline" };
        return { action: "accept", content: { decision: "allow_session" } };
      });
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      try {
        await writeFile(deniedPath, "blocked value");
        await writeFile(
          path.join(instance.root, "ast-mcp.toml"),
          [
            "version = 2",
            "[formatting]",
            "enabled = false",
            "[[paths]]",
            'id = "blocked"',
            "path = " + JSON.stringify(deniedPath),
            'policies = { read = "deny", write = "deny", delete = "deny" }',
            "",
          ].join("\n"),
        );
        clearConfigCache();
        configRegistry.invalidate();
        await instance.server.connect(serverTransport);
        await client.connect(clientTransport);
        const edit = await client.callTool({
          name: "config_core",
          arguments: { safety: { filesystem: "unrestricted" } },
        });
        expect(edit.isError, JSON.stringify(edit)).not.toBeTrue();
        expect(approvals).toBe(1);
        const diagnostic = await client.callTool({
          name: "diagnostics",
          arguments: {},
        });
        expect(diagnostic.structuredContent).toMatchObject({
          data: {
            configuration: {
              filesystem: "unrestricted",
              filesystemAuthority: "project",
            },
            approval: { sessionGrantPresent: false },
          },
        });
        phase = "decline filesystem";
        const read = (filePath: string) =>
          client.callTool({
            name: "file_read",
            arguments: { files: [{ filePath, mode: "text" }] },
          });
        const blocked = await read(deniedPath);
        expect(blocked.isError).toBeTrue();
        expect(approvals).toBe(1);
        const rejected = await read(path.join(instance.external, "value.txt"));
        expect(rejected.structuredContent).toMatchObject({
          error: { code: "approval_denied", details: { rule: "filesystem" } },
        });
        expect(approvals).toBe(2);
        phase = "activate filesystem";
        const accepted = await read(path.join(instance.external, "value.txt"));
        expect(accepted.isError, JSON.stringify(accepted)).not.toBeTrue();
        expect(JSON.stringify(accepted)).toContain("authorized value");
        expect(approvals).toBe(3);
        const bypassed = await read(deniedPath);
        expect(bypassed.isError, JSON.stringify(bypassed)).not.toBeTrue();
        expect(JSON.stringify(bypassed)).toContain("blocked value");
        expect(approvals).toBe(3);
        const activated = await client.callTool({
          name: "diagnostics",
          arguments: {},
        });
        expect(activated.structuredContent).toMatchObject({
          data: { approval: { sessionGrantPresent: true } },
        });
        await writeFile(
          path.join(instance.root, "ast-mcp.toml"),
          "version = [invalid",
        );
        const invalid = await configRegistry.reload();
        expect(
          invalid.some(
            (snapshot) => !snapshot.healthy && snapshot.config !== undefined,
          ),
        ).toBeTrue();
        const unavailable = await client.callTool({
          name: "diagnostics",
          arguments: {},
        });
        expect(unavailable.structuredContent).toMatchObject({
          data: {
            configuration: {
              healthy: false,
              generation: null,
              reason: "configuration_unavailable",
            },
            approval: { sessionGrantPresent: false },
            versionCheck: { status: "current" },
          },
        });
        expect(JSON.stringify(unavailable)).not.toContain(instance.root);
        expect(JSON.stringify(unavailable)).not.toContain("version = [invalid");
        expect(approvals).toBe(3);
      } finally {
        await client.close();
        await instance.close();
      }
    },
  );
}

test("modern request-scoped HTTP refuses filesystem approval but permits diagnostics", async () => {
  const instance = await fixture();
  const servers: ReturnType<typeof createServer>[] = [];
  const handler = createMcpHandler(
    () => {
      const server = createServer(
        {},
        { globalEnabled: async () => false },
        { requestScoped: true },
        {
          transport: "http",
          diagnosticsFetch: (async () =>
            Response.json({
              version: packageJson.version,
            })) as unknown as typeof fetch,
        },
      );
      servers.push(server);
      return server;
    },
    { legacy: "reject", responseMode: "json" },
  );
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const response = await handler.fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": "2026-07-28",
          "Mcp-Method": "tools/call",
          "Mcp-Name": name,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name,
            arguments: args,
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientInfo": {
                name: "grok",
                version: "test",
              },
              "io.modelcontextprotocol/clientCapabilities": {
                elicitation: { form: {} },
              },
            },
          },
        }),
      }),
    );
    expect(response.status, await response.clone().text()).toBe(200);
    return ((await response.json()) as any).result;
  };
  try {
    const scoped = await call("file_read", {
      files: [
        { filePath: path.join(instance.root, "value.txt"), mode: "text" },
      ],
    });
    expect(scoped.isError).not.toBeTrue();
    expect(scoped.inputRequests).toBeUndefined();
    expect(scoped.structuredContent).toMatchObject({
      data: { files: [{ content: "authorized value" }] },
    });
    const rejected = await call("file_read", {
      files: [
        { filePath: path.join(instance.external, "value.txt"), mode: "text" },
      ],
    });
    expect(rejected.structuredContent).toMatchObject({
      error: { code: "approval_required" },
    });
    expect(rejected.inputRequests).toBeUndefined();
    const diagnostic = await call("diagnostics");
    expect(diagnostic.structuredContent).toMatchObject({
      data: {
        server: { transport: "http", protocol: "2026-07-28" },
        versionCheck: { status: "current" },
        approval: { sessionGrantPresent: false },
      },
    });
    expect(JSON.stringify(diagnostic)).not.toContain("codex_approval_kind");
    expect(
      servers.every(
        (server) => !approvalDiagnostics(server).sessionGrantPresent,
      ),
    ).toBeTrue();
  } finally {
    await handler.close();
    await Promise.all(servers.map((server) => server.close()));
    await instance.close();
  }
});

test("diagnostics sanitize malformed and URL-only negotiated capabilities", async () => {
  const instance = await fixture();
  try {
    const config = await configRegistry.get({ cwd: instance.root });
    for (const [capabilities, expected] of [
      [
        { elicitation: { url: {} }, roots: [], sampling: {} },
        {
          formElicitation: false,
          urlElicitation: true,
          roots: false,
          sampling: true,
        },
      ],
      [
        { elicitation: { url: null }, roots: "private", sampling: [] },
        {
          formElicitation: false,
          urlElicitation: false,
          roots: false,
          sampling: false,
        },
      ],
      [
        { elicitation: { url: [] }, roots: {}, sampling: "private" },
        {
          formElicitation: false,
          urlElicitation: false,
          roots: true,
          sampling: false,
        },
      ],
      [
        { elicitation: { url: "private" } },
        {
          formElicitation: false,
          urlElicitation: false,
          roots: false,
          sampling: false,
        },
      ],
      [
        { elicitation: [] },
        {
          formElicitation: false,
          urlElicitation: false,
          roots: false,
          sampling: false,
        },
      ],
    ] as const) {
      const result = await collectDiagnostics({
        config,
        context: {
          http: {},
          mcpReq: {
            envelope: {
              "io.modelcontextprotocol/clientCapabilities": capabilities,
              "io.modelcontextprotocol/clientInfo": {
                name: "/private/agent",
                version: "/private/version",
              },
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            },
          },
        } as unknown as ServerContext,
        fetch: (async () =>
          Response.json({
            version: packageJson.version,
          })) as unknown as typeof fetch,
      });
      expect(result.client).toMatchObject({
        name: "unknown",
        version: "unknown",
        capabilities: expected,
      });
      expect(result.server.transport).toBe("http");
      expect(result.versionCheck.status).toBe("current");
      expect(JSON.stringify(result)).not.toContain("/private");
    }
  } finally {
    await instance.close();
  }
});
