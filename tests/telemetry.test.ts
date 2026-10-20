import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import type { PostHogMCPOptions } from "@posthog/mcp";
import type { EventMessage } from "posthog-node";

import {
  clearConfigCache,
  globalTelemetryEnabled,
  globalConfigPath,
  resolveConfig,
  type ResolvedConfig,
} from "../src/config";
import {
  Telemetry,
  filterTelemetryEvent,
  telemetryFailure,
} from "../src/runtime/telemetry";
import { createServer } from "../src/server";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
  clearConfigCache();
});
async function fixture(
  global?: boolean,
  project?: boolean,
  platform: NodeJS.Platform = process.platform,
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-telemetry-"));
  roots.push(root);
  const cwd = path.join(root, "project");
  const home = path.join(root, "home");
  await mkdir(cwd, { recursive: true });
  const globalFile = globalConfigPath({ home, env: {}, platform });
  await mkdir(path.dirname(globalFile), { recursive: true });
  if (global !== undefined)
    await writeFile(
      globalFile,
      "version = 2\n[telemetry]\nenabled = " + global + "\n",
    );
  if (project !== undefined)
    await writeFile(
      path.join(cwd, "ast-mcp.toml"),
      "version = 2\n[telemetry]\nenabled = " + project + "\n",
    );
  return { root, cwd, home, env: {}, platform };
}
const policy = (enabled = true, globalEnabled = true) =>
  ({ telemetry: { enabled, globalEnabled } }) as ResolvedConfig;
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
test("terminal close blocks delayed loader, startup policy, and transport continuations", async () => {
  for (const stage of ["loader", "startup", "global"] as const) {
    const fake = fakeSdk();
    let resume!: () => void;
    const delay = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let checks = 0;
    const telemetry = new Telemetry({
      shutdownMs: 1,
      globalEnabled: async () => {
        if (stage === "global" && ++checks === 1) await delay;
        return true;
      },
      startupConfig: async () => {
        await delay;
        return policy();
      },
      loadSdk: async () => {
        if (stage === "loader") await delay;
        return fake.loadSdk();
      },
    });
    if (stage === "startup")
      telemetry.reportException(new Error("private fatal"), true);
    else await invoke(telemetry);
    await tick();
    await telemetry.close();
    resume();
    await tick();
    expect(fake.constructed).toBe(0);
    expect(fake.calls).toHaveLength(0);
  }
  const fake = fakeSdk();
  const telemetry = new Telemetry({
    globalEnabled: async () => true,
    loadSdk: fake.loadSdk,
  });
  await invoke(telemetry);
  await telemetry.close();
  const response = await fake.options.fetch!(
    "https://us.i.posthog.com/batch/",
    { method: "POST", headers: {}, body: "{}" },
  );
  expect(response.status).toBe(200);
  expect(fake.shutdown).toBe(1);
});
test("anonymous sessions rotate at 23 hours and remain isolated between controllers", async () => {
  let now = 0;
  const sdk = fakeSdk();
  const telemetry = new Telemetry({
    now: () => now,
    globalEnabled: async () => true,
    loadSdk: sdk.loadSdk,
  });
  const session = () => (sdk.calls.at(-1) as { sessionId: string }).sessionId;
  await invoke(telemetry);
  await tick();
  const first = session();
  now = 23 * 60 * 60 * 1000 - 1;
  await invoke(telemetry);
  await tick();
  expect(session()).toBe(first);
  now++;
  await invoke(telemetry);
  await tick();
  const second = session();
  expect(second).not.toBe(first);
  expect(second).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  const otherSdk = fakeSdk();
  const other = new Telemetry({
    globalEnabled: async () => true,
    loadSdk: otherSdk.loadSdk,
  });
  await invoke(other);
  await tick();
  expect((otherSdk.calls[0] as { sessionId: string }).sessionId).not.toBe(
    second,
  );
  await Promise.all([telemetry.close(), other.close()]);
});
function fakeSdk() {
  let options!: PostHogMCPOptions;
  let loaded = 0;
  let constructed = 0;
  let shutdown = 0;
  const calls: unknown[] = [];
  const events: EventMessage[] = [];
  return {
    get options() {
      return options;
    },
    get loaded() {
      return loaded;
    },
    get constructed() {
      return constructed;
    },
    get shutdown() {
      return shutdown;
    },
    calls,
    events,
    loadSdk: async () => {
      loaded++;
      return (_token: string, supplied: PostHogMCPOptions) => {
        options = supplied;
        constructed++;
        return {
          captureToolCall: (value: unknown) => {
            calls.push(value);
          },
          capture: (value: EventMessage) => {
            events.push(value);
          },
          shutdown: async () => {
            shutdown++;
          },
        };
      };
    },
  };
}
async function invoke(
  telemetry: Telemetry,
  selected = policy(),
  error?: unknown,
) {
  return telemetry.run("file_read", async () => {
    telemetry.select(selected);
    if (error !== undefined) throw error;
    return "preserved";
  });
}
function wireOptions(sdk: ReturnType<typeof fakeSdk>) {
  return sdk.options.fetch!;
}

describe("telemetry configuration", () => {
  test("defaults enabled, project opt-out, and global ceiling override project enable", async () => {
    for (const [global, project, expected] of [
      [undefined, undefined, true],
      [undefined, false, false],
      [true, false, false],
      [false, true, false],
      [true, true, true],
    ] as const) {
      for (const platform of ["linux", "darwin", "win32"] as const) {
        const options = await fixture(global, project, platform);
        const config = await resolveConfig(options);
        expect(config.telemetry).toEqual({
          enabled: expected,
          globalEnabled: global !== false,
        });
        expect(config.provenance["telemetry.enabled"]).toBe(
          project !== undefined
            ? "project"
            : global !== undefined
              ? "global"
              : "default",
        );
        expect(await globalTelemetryEnabled(options)).toBe(global !== false);
      }
    }
  });
  test("legacy configuration accepts opt-out and invalid telemetry fails closed", async () => {
    const options = await fixture();
    await writeFile(
      path.join(options.cwd, "ast-mcp.toml"),
      "version = 1\n[telemetry]\nenabled = false\n",
    );
    expect((await resolveConfig(options)).telemetry.enabled).toBe(false);
    await writeFile(
      path.join(options.cwd, "ast-mcp.toml"),
      "version = 2\n[telemetry]\nenabled = 'bad'\n",
    );
    await expect(resolveConfig(options)).rejects.toThrow();
    expect(await globalTelemetryEnabled()).toBe(false);
  });
  test("mixed root policies cannot erase a project opt-out", async () => {
    const options = await fixture(true, true);
    const second = path.join(options.root, "second");
    await mkdir(second);
    await writeFile(
      path.join(second, "ast-mcp.toml"),
      "version = 2\n[telemetry]\nenabled = false\n",
    );
    await expect(
      resolveConfig({
        ...options,
        clientRoots: [options.cwd, second],
        requestPaths: [
          path.join(options.cwd, "a.ts"),
          path.join(second, "b.ts"),
        ],
      }),
    ).rejects.toThrow("conflicting");
  });
});

test("committed deletions report cleanup outcomes without changing results or transmitting details", async () => {
  const sdk = fakeSdk();
  const telemetry = new Telemetry({
    loadSdk: sdk.loadSdk,
    globalEnabled: async () => true,
  });
  telemetry.register("file_delete");
  const codes = [
    "EACCES",
    "EPERM",
    "lock_deadline",
    "lock_fenced",
    "cleanup_failed",
    "private@example.invalid",
  ];
  for (const code of codes) {
    const result = {
      files: { "/private/source.ts": { deleted: true } },
      cleanup: {
        status: code === "lock_deadline" ? "deferred" : "failed",
        code,
        message: "private message",
      },
    };
    expect(
      await telemetry.run("file_delete", async () => {
        telemetry.select(policy());
        return result;
      }),
    ).toBe(result);
  }
  await tick();
  await telemetry.close();
  expect(sdk.calls).toHaveLength(codes.length);
  expect(sdk.events).toHaveLength(2);
  for (const call of sdk.calls.slice(0, 4))
    expect(
      (call as { properties: { outcome: string } }).properties.outcome,
    ).toBe("operational_error");
  for (const call of sdk.calls.slice(4))
    expect(
      (call as { properties: { outcome: string } }).properties.outcome,
    ).toBe("unexpected_error");
  expect(JSON.stringify([sdk.calls, sdk.events])).not.toContain("/private");
  expect(JSON.stringify([sdk.calls, sdk.events])).not.toContain(
    "private message",
  );
  expect(JSON.stringify([sdk.calls, sdk.events])).not.toContain(
    "private@example.invalid",
  );
});

describe("telemetry isolation and lifecycle", () => {
  test("disabled and unresolved policy never import SDK or send network", async () => {
    const sdk = fakeSdk();
    let network = 0;
    const telemetry = new Telemetry({
      loadSdk: sdk.loadSdk,
      globalEnabled: async () => true,
      fetch: async () => {
        network++;
        return new Response();
      },
    });
    telemetry.select(policy());
    telemetry.reportException(new Error("unknown project"));
    expect(await telemetry.run("file_read", async () => 42)).toBe(42);
    expect(await invoke(telemetry, policy(false))).toBe("preserved");
    expect(await invoke(telemetry, policy(true, false))).toBe("preserved");
    await telemetry.close();
    expect(sdk.loaded).toBe(0);
    expect(network).toBe(0);
    const globalOff = new Telemetry({
      loadSdk: sdk.loadSdk,
      globalEnabled: async () => false,
    });
    await invoke(globalOff);
    await globalOff.close();
    expect(sdk.loaded).toBe(0);
  });
  test("registered tools, expected errors, unknown names, and fatal events remain bounded", async () => {
    const sdk = fakeSdk();
    const telemetry = new Telemetry({
      loadSdk: sdk.loadSdk,
      globalEnabled: async () => true,
    });
    telemetry.register("file_read");
    expect(await invoke(telemetry)).toBe("preserved");
    const expected = Object.assign(new Error("/secret/file.ts"), {
      code: "stale_hash",
    });
    await expect(invoke(telemetry, policy(), expected)).rejects.toBe(expected);
    const unexpected = Object.assign(new Error("token and source"), {
      code: "secret@example.org",
      cause: new Error("secret cause"),
    });
    unexpected.stack =
      "Error: secret\n at fn (/outside/private/file.ts:1:2)\n bad frame\n" +
      Array.from(
        { length: 25 },
        (_, n) =>
          " at fn (" + path.resolve("src/server.ts") + ":" + (n + 1) + ":2)",
      ).join("\n");
    await expect(invoke(telemetry, policy(), unexpected)).rejects.toBe(
      unexpected,
    );
    await telemetry.run("private-user-tool-name", async () => {
      telemetry.select(policy());
      telemetry.reportException({ name: "PrivateName", stack: "bad" });
    });
    await tick();
    await telemetry.close();
    await telemetry.close();
    expect(sdk.constructed).toBe(1);
    expect(sdk.shutdown).toBe(1);
    expect(sdk.calls).toHaveLength(5);
    expect(sdk.events).toHaveLength(2);
    expect(JSON.stringify(sdk.calls)).not.toContain("secret");
    expect(JSON.stringify(sdk.events)).not.toContain("/outside");
    expect((sdk.calls[1] as { properties: unknown }).properties).toEqual({
      outcome: "operational_error",
      error_code: "stale_hash",
    });
    expect((sdk.calls[4] as { toolName: string }).toolName).toBe("unknown");
    const stack = (
      sdk.events[0]!.properties!.$exception_list as Array<{
        stacktrace: { frames: unknown[] };
      }>
    )[0]!.stacktrace.frames;
    expect(stack).toHaveLength(20);
    expect(sdk.options.enableExceptionAutocapture).toBe(false);
    expect(sdk.options.enableLocalEvaluation).toBe(false);
    expect(sdk.options.captureModel).toBe(false);
    expect(sdk.options.enableConversationId).toBe(false);
    await invoke(telemetry);
    expect(sdk.calls).toHaveLength(5);
  });
  test("concurrent project scopes do not leak opt-out or sessions", async () => {
    const sdk = fakeSdk();
    const telemetry = new Telemetry({
      loadSdk: sdk.loadSdk,
      globalEnabled: async () => true,
    });
    await Promise.all([
      telemetry.run("file_read", async () => {
        telemetry.select(policy(false));
        await tick();
      }),
      invoke(telemetry),
    ]);
    await telemetry.close();
    expect(sdk.calls).toHaveLength(1);
  });
  test("queue saturation and broken loader never affect tool results", async () => {
    let release!: (
      value: Awaited<ReturnType<ReturnType<typeof fakeSdk>["loadSdk"]>>,
    ) => void;
    const sdk = fakeSdk();
    const pending = new Promise<Awaited<ReturnType<typeof sdk.loadSdk>>>(
      (resolve) => {
        release = resolve;
      },
    );
    const telemetry = new Telemetry({
      maxPending: 1,
      globalEnabled: async () => true,
      loadSdk: () => pending,
    });
    for (let n = 0; n < 10; n++)
      expect(await invoke(telemetry)).toBe("preserved");
    release(await sdk.loadSdk());
    await telemetry.close();
    expect(sdk.calls).toHaveLength(1);
    const broken = new Telemetry({
      loadSdk: async () => {
        throw new Error("SDK unavailable");
      },
      globalEnabled: async () => true,
    });
    expect(await invoke(broken)).toBe("preserved");
    await broken.close();
    const rejecting = new Telemetry({
      globalEnabled: async () => {
        throw new Error("config unavailable");
      },
    });
    expect(await invoke(rejecting)).toBe("preserved");
    await rejecting.close();
  });
  test("global changes stop initialization before import and before constructor", async () => {
    for (const disabledAt of [2, 3, 4]) {
      const sdk = fakeSdk();
      let calls = 0;
      const telemetry = new Telemetry({
        loadSdk: sdk.loadSdk,
        globalEnabled: async () => ++calls < disabledAt,
      });
      await invoke(telemetry);
      await telemetry.close();
      expect(sdk.calls).toHaveLength(0);
    }
  });
  test("hanging SDK shutdown respects deadline and shutdown rejection is isolated", async () => {
    for (const hanging of [true, false]) {
      const telemetry = new Telemetry({
        shutdownMs: 15,
        globalEnabled: async () => true,
        loadSdk: async () => () => ({
          captureToolCall() {},
          capture() {},
          shutdown: () =>
            hanging
              ? new Promise(() => {})
              : Promise.reject(new Error("unavailable")),
        }),
      });
      await invoke(telemetry);
      const start = performance.now();
      await telemetry.close();
      expect(performance.now() - start).toBeLessThan(200);
    }
  });
  test("malicious throwable getters cannot replace original operation error", async () => {
    const sdk = fakeSdk();
    const telemetry = new Telemetry({
      loadSdk: sdk.loadSdk,
      globalEnabled: async () => true,
    });
    const error = Object.defineProperty({}, "code", {
      get() {
        throw new Error("getter");
      },
    });
    await expect(invoke(telemetry, policy(), error)).rejects.toBe(error);
    await telemetry.close();
    expect(sdk.calls).toHaveLength(0);
    expect(telemetryFailure(null).code).toBe("unexpected_error");
    expect(telemetryFailure({ name: "AbortError" }).outcome).toBe(
      "operational_error",
    );
    expect(telemetryFailure({ code: "secret", name: "Error" }).code).toBe(
      "unexpected_error",
    );
  });
});

describe("transmission allowlist", () => {
  test("drops nonanalytics events and sanitizes all SDK and user-controlled fields", () => {
    const known = new Set(["file_read"]);
    expect(
      filterTelemetryEvent(
        { event: "$identify", properties: { outcome: "success" } },
        "session",
        known,
      ),
    ).toBeNull();
    expect(
      filterTelemetryEvent({ event: "$mcp_tool_call" }, "session", known),
    ).toBeNull();
    expect(
      filterTelemetryEvent(
        { event: "$exception", properties: { outcome: "operational_error" } },
        "session",
        known,
      ),
    ).toBeNull();
    const input = {
      outcome: "unexpected_error",
      error_code: "secret",
      $mcp_tool_name: "/private",
      $mcp_duration_ms: Infinity,
      $ip: "1.2.3.4",
      $host: "secret",
      $exception_list: [
        {
          type: "PrivateName",
          value: "secret",
          cause: "secret",
          stacktrace: {
            frames: [
              { filename: "/private/a.ts", lineno: 1, colno: 2 },
              { filename: "ast-mcp/src/../private.ts", lineno: 1, colno: 2 },
              {
                filename: "ast-mcp/src/server.ts",
                lineno: 2,
                colno: 3,
                context_line: "SECRET",
                function: "SECRET function",
              },
              null,
            ],
          },
        },
      ],
    };
    const filtered = filterTelemetryEvent(
      { event: "$exception", distinctId: "user-id", properties: input },
      "session",
      known,
    )!;
    expect(filtered.distinctId).toBe("session");
    expect(filtered.properties!.$mcp_tool_name).toBe("unknown");
    expect(filtered.properties!.$mcp_duration_ms).toBe(0);
    expect(filtered.properties!.$process_person_profile).toBe(false);
    expect(filtered.properties!.$geoip_disable).toBe(true);
    expect(filtered.properties!.$exception_list).toMatchObject([
      {
        stacktrace: {
          frames: [{ function: "<anonymous>", platform: "node:javascript" }],
        },
      },
    ]);
    expect(JSON.stringify(filtered)).not.toContain("secret");
    expect(JSON.stringify(filtered)).not.toContain("SECRET");
    expect(JSON.stringify(filtered)).not.toContain("private");
    expect(
      filterTelemetryEvent(
        {
          event: "$exception",
          properties: {
            outcome: "unexpected_error",
            error_code: "unexpected_error",
          },
        },
        "session",
        known,
      )!.properties!.$exception_list,
    ).toBeDefined();
    expect(
      filterTelemetryEvent(
        {
          event: "$mcp_tool_call",
          properties: {
            outcome: "success",
            $mcp_tool_name: "file_read",
            $mcp_duration_ms: -10,
          },
        },
        "session",
        known,
      )!.properties!.$mcp_duration_ms,
    ).toBe(0);
  });
  test("final transport rejects SDK flags, malformed bodies, and global disable before flush", async () => {
    const sdk = fakeSdk();
    let enabled = true;
    let networks = 0;
    const telemetry = new Telemetry({
      loadSdk: sdk.loadSdk,
      globalEnabled: async () => enabled,
      fetch: async () => {
        networks++;
        return new Response("{}");
      },
    });
    await invoke(telemetry);
    await tick();
    const send = wireOptions(sdk);
    for (const [url, body] of [
      ["https://us.i.posthog.com/flags/", "{}"],
      ["https://evil.invalid/batch/", "{}"],
      ["https://us.i.posthog.com/batch/", "bad"],
      ["https://us.i.posthog.com/batch/", "{}"],
      [
        "https://us.i.posthog.com/batch/",
        JSON.stringify({ batch: Array.from({ length: 129 }, () => ({})) }),
      ],
      [
        "https://us.i.posthog.com/batch/",
        JSON.stringify({ batch: [{ event: "$identify" }] }),
      ],
    ])
      await send(url!, { method: "POST", headers: {}, body: body! });
    await send("https://us.i.posthog.com/batch/", {
      method: "POST",
      headers: {},
      body: undefined,
    });
    expect(networks).toBe(0);
    const body = JSON.stringify({
      batch: [{ event: "$mcp_tool_call", properties: { outcome: "success" } }],
    });
    enabled = false;
    await send("https://us.i.posthog.com/batch/", {
      method: "POST",
      headers: {},
      body,
    });
    expect(networks).toBe(0);
    enabled = true;
    await send("https://us.i.posthog.com/batch/", {
      method: "POST",
      headers: {},
      body,
    });
    expect(networks).toBe(1);
    await telemetry.close();
  });
  test("actual SDK serialized requests contain only permitted anonymous operational fields", async () => {
    const packets: Array<{
      url: string;
      body: {
        batch: Array<{
          event: string;
          distinct_id: string;
          properties: Record<string, unknown>;
        }>;
      };
    }> = [];
    const telemetry = new Telemetry({
      globalEnabled: async () => true,
      fetch: async (url, options) => {
        packets.push({
          url: String(url),
          body: JSON.parse(options!.body as string),
        });
        return new Response('{"status":1}');
      },
    });
    telemetry.register("file_read");
    await invoke(telemetry);
    await expect(
      invoke(
        telemetry,
        policy(),
        Object.assign(new Error("/secret/source.ts"), { code: "stale_hash" }),
      ),
    ).rejects.toThrow();
    const error = new TypeError(
      "TOKEN source args response client@example.org",
    );
    error.stack =
      "TypeError: TOKEN\n at private (" +
      path.resolve("src/server.ts") +
      ":3:4)\n at private (/secret/source.ts:1:2)";
    await expect(invoke(telemetry, policy(), error)).rejects.toThrow();
    await telemetry.close();
    const events = packets.flatMap((packet) => packet.body.batch);
    expect(
      events.filter((event) => event.event === "$mcp_tool_call"),
    ).toHaveLength(3);
    expect(events.filter((event) => event.event === "$exception")).toHaveLength(
      1,
    );
    expect(
      packets.every(
        (packet) => packet.url === "https://us.i.posthog.com/batch/",
      ),
    ).toBe(true);
    for (const event of events) {
      expect(event.distinct_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(event.properties.$session_id).toBe(event.distinct_id);
      expect(event.properties.$session_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(event.properties.$process_person_profile).toBe(false);
      expect(event.properties.$geoip_disable).toBe(true);
      expect(event.properties.$mcp_server_build).toBe("source");
      expect(
        Object.keys(event.properties).every((key) =>
          [
            "$mcp_error_type",
            "$mcp_source",
            "$mcp_tool_name",
            "$mcp_duration_ms",
            "$mcp_is_error",
            "$mcp_server_name",
            "$mcp_server_version",
            "$mcp_server_build",
            "$session_id",
            "$process_person_profile",
            "$geoip_disable",
            "outcome",
            "error_code",
            "$exception_level",
            "$exception_list",
          ].includes(key),
        ),
      ).toBe(true);
    }
    expect(
      events.find((event) => event.event === "$exception")!.properties
        .$exception_list,
    ).toMatchObject([
      {
        stacktrace: {
          frames: [
            {
              filename: "ast-mcp/src/server.ts",
              function: "<anonymous>",
              platform: "node:javascript",
              lineno: 3,
              colno: 4,
            },
          ],
        },
      },
    ]);
    expect(JSON.stringify(packets)).not.toContain("private");
    expect(JSON.stringify(packets)).not.toContain("TOKEN");
    expect(JSON.stringify(packets)).not.toContain("/secret");
    expect(JSON.stringify(packets)).not.toContain("client@example.org");
  });
  test("analytics outages do not fail tools or extend shutdown indefinitely", async () => {
    const telemetry = new Telemetry({
      globalEnabled: async () => true,
      requestTimeoutMs: 15,
      shutdownMs: 50,
      fetch: async () => {
        throw new Error("offline");
      },
    });
    expect(await invoke(telemetry)).toBe("preserved");
    const start = performance.now();
    await telemetry.close();
    expect(performance.now() - start).toBeLessThan(200);
  });
});

test("real MCP tool discovery preserves schemas and disabled traffic stays offline", async () => {
  const sdk = fakeSdk();
  const server = createServer({}, { loadSdk: sdk.loadSdk });
  const client = new Client({
    name: "identifying-private-client",
    version: "private",
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const tools = await client.listTools();
  const read = tools.tools.find((tool) => tool.name === "file_read")!;
  expect(JSON.stringify(read.inputSchema)).not.toContain("conversation_id");
  expect(JSON.stringify(read.inputSchema)).not.toContain("llm_model");
  const result = await client.callTool({
    name: "config_status",
    arguments: {},
  });
  expect(result.isError).not.toBe(true);
  await client.close();
  await server.close();
  expect(sdk.loaded).toBe(0);
});
