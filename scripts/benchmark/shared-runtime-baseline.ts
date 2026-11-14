import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/client";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/client/stdio";

import { brokerInstallationKey } from "../../src/server/shared-cli.ts";

const sourceRoot = path.resolve(import.meta.dir, "../..");
const layouts = ["same", "mixed"] as const;
const defaultWorkloads = ["read", "write", "indexed"] as const;
const workloads = [...defaultWorkloads, "indexed-contention"] as const;
type Layout = (typeof layouts)[number];
type Workload = (typeof workloads)[number];
type Command = [string, ...string[]];
type FixturePolicy = {
  requireHash?: boolean;
  mutationLock?: boolean;
  format?: boolean;
};
type Observation = {
  code?: string;
  ok: boolean;
  milliseconds: number;
  error?: string;
};
type Measurements = Map<string, Observation[]>;
type Session = {
  client: Client;
  transport: StdioClientTransport;
  root: string;
  committedWorkspace?: string;
};
type ProcessRow = {
  pid: number;
  parent: number;
  rssKiB: number;
  cpuSeconds: number;
  broker: boolean;
};

function positiveInteger(value: string, limit: number) {
  const result = Number(value);
  if (
    !/^\d+$/.test(value) ||
    !Number.isSafeInteger(result) ||
    result < 1 ||
    result > limit
  )
    throw new Error(
      "Expected an integer between 1 and " + limit + ": " + value,
    );
  return result;
}

function select<T extends string>(value: string, supported: readonly T[]) {
  const values = value.split(",");
  if (values.some((item) => !supported.includes(item as T)))
    throw new Error(
      "Expected a comma-separated selection from " + supported.join(","),
    );
  return [...new Set(values)] as T[];
}

function launchCommand(value: string): Command {
  const command: unknown = JSON.parse(value);
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    command.some((item) => typeof item !== "string" || !item) ||
    !path.isAbsolute(command[0])
  )
    throw new Error(
      "--command requires a JSON array beginning with an absolute executable path",
    );
  return command as Command;
}

function booleanOption(name: string, value: string) {
  if (value !== "true" && value !== "false")
    throw new Error(name + " requires true or false");
  return value === "true";
}

function options(args: string[]) {
  let clients = [1, 4, 16];
  let layout: Layout[] = [...layouts];
  let workload: Workload[] = [...defaultWorkloads];
  const fixturePolicy: FixturePolicy = {};
  let rounds = 1;
  let samples = 3;
  let cleanupMs = 2_000;
  let compareCommand: Command | undefined;
  let command: Command = [
    process.execPath,
    path.join(sourceRoot, "bin/ast-mcp.ts"),
    "mcp",
  ];
  for (const arg of args) {
    const equals = arg.indexOf("=");
    const name = arg.slice(0, equals);
    const value = arg.slice(equals + 1);
    if (equals < 0 || !value)
      throw new Error("Expected --option=value: " + arg);
    switch (name) {
      case "--clients":
        clients = [
          ...new Set(value.split(",").map((item) => positiveInteger(item, 16))),
        ];
        break;
      case "--layout":
        layout = select(value, layouts);
        break;
      case "--workloads":
        workload = select(value, workloads);
        break;
      case "--rounds":
        rounds = positiveInteger(value, 100);
        break;
      case "--samples":
        samples = positiveInteger(value, 1000);
        break;
      case "--cleanup-ms":
        cleanupMs = positiveInteger(value, 3_600_000);
        break;
      case "--require-hash":
        fixturePolicy.requireHash = booleanOption(name, value);
        break;
      case "--mutation-lock":
        fixturePolicy.mutationLock = booleanOption(name, value);
        break;
      case "--format":
        fixturePolicy.format = booleanOption(name, value);
        break;
      case "--command":
        command = launchCommand(value);
        break;
      case "--compare-command":
        compareCommand = launchCommand(value);
        break;
      default:
        throw new Error("Unknown option: " + name);
    }
  }
  return {
    cleanupMs,
    clients,
    command,
    compareCommand,
    fixturePolicy,
    layout,
    rounds,
    samples,
    workload,
  };
}

function cleanEnvironment() {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        !/^(GIT_|AST_MCP_|BUN_OPTIONS$|BUN_BE_BUN$|NODE_OPTIONS$|CLAUDE_PROJECT_DIR$)/i.test(
          entry[0],
        ),
    ),
  );
}

async function git(cwd: string, args: string[]) {
  const child = Bun.spawn(
    [
      "git",
      "-c",
      "core.hooksPath=" + path.join(cwd, ".benchmark-no-hooks"),
      "-c",
      "core.autocrlf=false",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    {
      cwd,
      env: {
        ...cleanEnvironment(),
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: os.devNull,
        GIT_AUTHOR_EMAIL: "benchmark@example.test",
        GIT_AUTHOR_NAME: "Benchmark",
        GIT_COMMITTER_EMAIL: "benchmark@example.test",
        GIT_COMMITTER_NAME: "Benchmark",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [code, output, errors] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error("git " + args[0] + ": " + errors.trim());
  return output.trim();
}

function source(client: number, sample: number) {
  return "export const sample" + client + " = " + sample + ";\n";
}

const policy = [
  "version = 2",
  "[telemetry]",
  "enabled = false",
  "[[paths]]",
  'id = "benchmark"',
  'path = "."',
  'policies = { read = "allow", write = "allow", delete = "allow" }',
  "",
].join("\n");

async function writeGlobalPolicy(configHome: string, config: FixturePolicy) {
  const { requireHash, mutationLock, format } = config;
  if (
    requireHash === undefined &&
    mutationLock === undefined &&
    format === undefined
  )
    return;
  const lines = ["version = 2", "[safety]"];
  if (requireHash !== undefined) lines.push("require_hash = " + requireHash);
  if (mutationLock !== undefined) lines.push("mutation_lock = " + mutationLock);
  if (format !== undefined) lines.push("[formatting]", "enabled = " + format);
  if (format)
    lines.push(
      'fallback = "reject"',
      "[[formatting.formatters]]",
      'id = "benchmark-identity"',
      "command = " + JSON.stringify(process.execPath),
      'args = ["-e", "process.stdout.write(await Bun.stdin.text());"]',
      'extensions = [".ts"]',
      'mode = "stdout"',
    );
  const directory = path.join(configHome, "ast-mcp");
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "ast-mcp.toml"),
    lines.join("\n") + "\n",
  );
}

async function fixture(root: string, checkout: string, clients: number) {
  await mkdir(root);
  await writeFile(path.join(root, "ast-mcp.toml"), policy);
  await writeFile(
    path.join(root, "anchor.ts"),
    "export const " + checkout + "Anchor = 2026;\n",
  );
  await Promise.all(
    Array.from({ length: clients }, (_, index) =>
      writeFile(path.join(root, "sample" + index + ".ts"), source(index, 0)),
    ),
  );
  await git(root, ["init", "-b", "main"]);
  await git(root, ["add", "--all"]);
  await git(root, ["commit", "-qm", "Create benchmark fixture"]);
}

async function prepare(sandbox: string, count: number, layout: Layout) {
  const main = path.join(sandbox, "main");
  await fixture(main, "main", count);
  if (layout === "same") return [{ root: main, symbol: "mainAnchor" }];
  const linked = path.join(sandbox, "linked");
  await git(main, ["worktree", "add", "--detach", "--quiet", linked, "HEAD"]);
  await writeFile(
    path.join(linked, "anchor.ts"),
    "export const linkedAnchor = 2026;\n",
  );
  await git(linked, ["commit", "-qam", "Distinguish linked checkout"]);
  const other = path.join(sandbox, "other");
  await fixture(other, "other", count);
  return [
    { root: main, symbol: "mainAnchor" },
    { root: linked, symbol: "linkedAnchor" },
    { root: other, symbol: "otherAnchor" },
  ];
}

async function timed<T>(
  measurements: Measurements,
  label: string,
  work: () => Promise<T>,
) {
  const started = performance.now();
  const entries = measurements.get(label) ?? [];
  measurements.set(label, entries);
  try {
    const result = await work();
    entries.push({ milliseconds: performance.now() - started, ok: true });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    entries.push({
      code:
        typeof error === "object" &&
        error &&
        "code" in error &&
        typeof error.code === "string"
          ? error.code
          : undefined,
      error: message.slice(0, 1500),
      milliseconds: performance.now() - started,
      ok: false,
    });
    throw error;
  }
}

function summaries(measurements: Measurements) {
  return Object.fromEntries(
    [...measurements].map(([label, entries]) => {
      const durations = entries
        .map((entry) => entry.milliseconds)
        .sort((a, b) => a - b);
      const percentile = (p: number) =>
        durations[Math.ceil(p * durations.length) - 1];
      const failures = entries.filter((entry) => !entry.ok);
      const failureCodes: Record<string, number> = {};
      for (const { code } of failures) {
        const key = code ?? "uncoded";
        failureCodes[key] = (failureCodes[key] ?? 0) + 1;
      }
      const slowestFailureMs = failures.reduce(
        (maximum, entry) => Math.max(maximum, entry.milliseconds),
        0,
      );
      return [
        label,
        {
          attempts: entries.length,
          correct: entries.length - failures.length,
          p50Ms: percentile(0.5),
          p95Ms: percentile(0.95),
          p99Ms: percentile(0.99),
          failureCodes,
          slowestFailureMs: failures.length ? slowestFailureMs : null,
          failures: [...new Set(failures.map((entry) => entry.error))].slice(
            0,
            8,
          ),
        },
      ];
    }),
  );
}

async function tool<T>(
  session: Session,
  measurements: Measurements,
  name: string,
  args: Record<string, unknown>,
  label = name,
) {
  return await timed(measurements, label, async () => {
    const result = await session.client.callTool(
      { name, arguments: args },
      { timeout: 60_000 },
    );
    const content = result.structuredContent as
      | { ok?: boolean; data?: T; error?: { code?: string } }
      | undefined;
    if (result.isError || content?.ok !== true || content.data === undefined)
      throw Object.assign(
        new Error(
          name + ": " + JSON.stringify(content?.error ?? result.content),
        ),
        { code: content?.error?.code },
      );
    return content.data;
  });
}

async function open(
  session: Session,
  measurements: Measurements,
  revision?: { kind: "commit"; oid: string },
  storage?: { kind: "explicit"; path: string },
) {
  const result = await tool<{
    workspace: { workspaceId: string; checkoutRoot: string };
  }>(session, measurements, "workspace_open", {
    directory: session.root,
    revision,
    storage,
  });
  if (result.workspace.checkoutRoot !== session.root)
    throw new Error("workspace_open selected the wrong checkout");
  return result.workspace.workspaceId;
}

function assertSymbol(data: unknown, symbol: string) {
  if (!JSON.stringify(data).includes(JSON.stringify(symbol)))
    throw new Error("Structural read missed " + symbol);
}

async function retrieveEvidence(
  session: Session,
  measurements: Measurements,
  workspaceId: string,
  symbol: string,
  fileName: string,
  expectedValue: number,
  strictRead = false,
) {
  const evidence = await tool<{
    results: Array<{ path: string; text: string }>;
    freshness: { stale: boolean };
  }>(
    session,
    measurements,
    "retrieve",
    {
      workspaceId,
      query: symbol,
      exactSymbols: [symbol],
      semantic: false,
      strictRead,
      // This is an untimed correctness fence after all timed write waves.
      budget: strictRead ? { timeoutMs: 20_000 } : undefined,
    },
    strictRead ? "strictWorkingRetrieval" : "committedRetrieval",
  );
  if (strictRead && evidence.freshness.stale)
    throw new Error("Strict retrieval returned stale evidence");
  const matchingFile = evidence.results.filter(
    (result) => result.path === fileName,
  );
  // Retrieval returns the indexed symbol span, which can omit its export wrapper.
  const assignment = new RegExp(
    "\\b" + symbol + "\\s*=\\s*" + expectedValue + "(?![\\w.])",
  );
  if (!matchingFile.some((result) => assignment.test(result.text)))
    throw new Error(
      "Retrieval missed " +
        symbol +
        " = " +
        expectedValue +
        " in " +
        fileName +
        "; matching spans: " +
        JSON.stringify(
          matchingFile.slice(0, 4).map((result) => result.text.slice(0, 120)),
        ) +
        "; paths: " +
        JSON.stringify(
          [...new Set(evidence.results.map((result) => result.path))].slice(
            0,
            8,
          ),
        ),
    );
}

function indexed(workload: Workload) {
  return workload === "indexed" || workload === "indexed-contention";
}

async function workflow(
  session: Session,
  measurements: Measurements,
  index: number,
  sample: number,
  workload: Workload,
  symbol: string,
  requireHash: boolean | undefined,
) {
  if (workload === "read") {
    const result = await tool(session, measurements, "map", {
      paths: [path.join(session.root, "anchor.ts")],
    });
    assertSymbol(result, symbol);
    return;
  }
  const filePath = path.join(session.root, "sample" + index + ".ts");
  const before = source(index, sample - 1);
  const after = source(index, sample);
  await tool(session, measurements, "file_patch", {
    files: {
      [filePath]: {
        patchStrategy: "aider_block",
        aiderBlocks: [{ search: before.trimEnd(), replace: after.trimEnd() }],
        ...(requireHash === false
          ? {}
          : {
              expectedSha256: createHash("sha256").update(before).digest("hex"),
            }),
      },
    },
  });
  if ((await readFile(filePath, "utf8")) !== after)
    throw new Error("Patch byte oracle mismatch: " + filePath);
  if (!indexed(workload)) return;
  if (!session.committedWorkspace)
    throw new Error("Missing committed retrieval workspace");
  await retrieveEvidence(
    session,
    measurements,
    session.committedWorkspace,
    symbol,
    "anchor.ts",
    2026,
  );
}

function cpuSeconds(raw: string) {
  const fields = raw.split(/[-:]/).map(Number);
  const scales = [1, 60, 3600, 86400];
  return fields
    .reverse()
    .reduce((total, value, index) => total + value * scales[index]!, 0);
}

async function processTable(
  installationKey?: string,
): Promise<ProcessRow[] | undefined> {
  if (process.platform === "win32") return undefined;
  const flags = process.platform === "darwin" ? ["-axww"] : ["-Aww"];
  const child = Bun.spawn(
    ["ps", ...flags, "-o", "pid=,ppid=,rss=,time=,args="],
    {
      stdout: "pipe",
      stderr: "ignore",
    },
  );
  const output = await new Response(child.stdout).text();
  if ((await child.exited) !== 0) return undefined;
  return output
    .trim()
    .split("\n")
    .flatMap((line) => {
      const [pid, parent, rss, time, ...identity] = line.trim().split(/\s+/);
      return pid && parent && rss && time
        ? [
            {
              pid: Number(pid),
              parent: Number(parent),
              rssKiB: Number(rss),
              cpuSeconds: cpuSeconds(time),
              broker:
                installationKey !== undefined &&
                identity.at(-1) === installationKey &&
                identity.at(-2) === "--broker",
            },
          ]
        : [];
    });
}

function sampling(sessions: Session[], installationKey?: string) {
  // Treat a repeating 100 ms ps scan as sampling, not protocol overhead.
  const observed = new Set<number>();
  const bridgeProcessIds = new Set<number>();
  const cpuByPid = new Map<number, number>();
  const brokerProcessIds = new Set<number>();
  let peakRssKiB = 0;
  let peakProcesses = 0;
  let pending: Promise<ProcessRow[] | undefined> | undefined;
  async function snapshot() {
    await pending;
    pending = processTable(installationKey).then((rows) => {
      if (!rows) return undefined;
      for (const { transport } of sessions) {
        if (!transport.pid) continue;
        bridgeProcessIds.add(transport.pid);
        observed.add(transport.pid);
      }
      for (const row of rows) {
        if (!row.broker) continue;
        observed.add(row.pid);
        brokerProcessIds.add(row.pid);
      }
      // Include new descendants and keep tracking them after their parent exits.
      for (let previous = -1; previous !== observed.size;) {
        previous = observed.size;
        for (const row of rows)
          if (observed.has(row.parent)) observed.add(row.pid);
      }
      const live = rows.filter((row) => observed.has(row.pid));
      for (const row of live)
        cpuByPid.set(
          row.pid,
          Math.max(cpuByPid.get(row.pid) ?? 0, row.cpuSeconds),
        );
      peakRssKiB = Math.max(
        peakRssKiB,
        live.reduce((sum, row) => sum + row.rssKiB, 0),
      );
      peakProcesses = Math.max(peakProcesses, live.length);
      return live;
    });
    return await pending;
  }
  let samplerError: unknown;
  const timer = setInterval(() => {
    if (pending) return;
    void snapshot()
      .catch((error: unknown) => {
        samplerError = error;
      })
      .finally(() => {
        pending = undefined;
      });
  }, 100);
  return {
    async finish(cleanupMs: number) {
      clearInterval(timer);
      const started = performance.now();
      const disconnected = await snapshot();
      let retained = disconnected;
      while (retained?.length && performance.now() - started < cleanupMs) {
        await Bun.sleep(
          Math.min(100, Math.max(1, cleanupMs - (performance.now() - started))),
        );
        retained = await snapshot();
      }
      if (samplerError) throw samplerError;
      if (!retained) return null;
      return {
        peakRssKiB,
        peakProcesses,
        brokerProcessIds: [...brokerProcessIds],
        sampledCpuSecondsLowerBound: [...cpuByPid.values()].reduce(
          (sum, value) => sum + value,
          0,
        ),
        cleanupMs: performance.now() - started,
        postDisconnectProcesses: disconnected?.map((row) => ({
          pid: row.pid,
          parent: row.parent,
          rssKiB: row.rssKiB,
          role: brokerProcessIds.has(row.pid)
            ? "broker"
            : bridgeProcessIds.has(row.pid)
              ? "stdio"
              : "worker",
        })),
        postDisconnectRssKiB: disconnected?.reduce(
          (sum, row) => sum + row.rssKiB,
          0,
        ),
        retainedRssKiB: retained.reduce((sum, row) => sum + row.rssKiB, 0),
        remainingProcessIds: retained.map((row) => row.pid),
      };
    },
  };
}

function createSession(
  root: string,
  command: Command,
  env: Record<string, string>,
): Session {
  const [executable, ...args] = command;
  const client = new Client(
    { name: "ast-mcp-shared-runtime-benchmark", version: "1.0.0" },
    { capabilities: { roots: {} } },
  );
  // Advertise the checkout independently of the launch cwd, as a host does.
  client.setRequestHandler("roots/list", () => ({
    roots: [{ uri: Bun.pathToFileURL(root).href }],
  }));
  const transport = new StdioClientTransport({
    command: executable,
    args,
    cwd: root,
    stderr: "pipe",
    env,
  });
  transport.stderr?.on("data", (data) => {
    if (process.env.AST_MCP_BENCHMARK_STDERR === "1")
      process.stderr.write(data);
  });
  return { client, root, transport };
}

function sharedInstallationKey(command: Command, env: Record<string, string>) {
  if (command.at(-2) !== "mcp" || command.at(-1) !== "--shared-stdio")
    return undefined;
  // These benchmark invocations use Bun source/bundle or the native binary directly.
  // Do not infer the underlying native binary from the npm launcher.
  const entry = command.length === 3 ? command[0] : command.at(-3)!;
  if (!path.isAbsolute(entry))
    throw new Error(
      "Shared broker comparisons require the absolute Bun entry path or native binary",
    );
  return brokerInstallationKey(entry, { ...getDefaultEnvironment(), ...env });
}

async function measureCell(
  command: Command,
  clients: number,
  layout: Layout,
  workload: Workload,
  samples: number,
  cleanupMs: number,
  fixturePolicy: FixturePolicy,
) {
  const sandbox = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "ast-mcp-baseline-")),
  );
  const sessions: Session[] = [];
  const measurements: Measurements = new Map();
  const env = {
    ...cleanEnvironment(),
    AST_MCP_BENCHMARK_RUN: crypto.randomUUID(),
    XDG_CONFIG_HOME: path.join(sandbox, "config"),
    XDG_CACHE_HOME: path.join(sandbox, "cache"),
    APPDATA: path.join(sandbox, "config"),
    LOCALAPPDATA: path.join(sandbox, "cache"),
  };
  const installationKey = sharedInstallationKey(command, env);
  const sampler = sampling(sessions, installationKey);
  let error: string | undefined;
  let errorCode: string | undefined;
  let elapsedMs: number | undefined;
  let verifiedElapsedMs: number | undefined;
  let disconnectMs: number | undefined;
  let processMetrics: Awaited<ReturnType<typeof sampler.finish>> = null;
  try {
    await writeGlobalPolicy(env.XDG_CONFIG_HOME, fixturePolicy);
    const roots = await prepare(sandbox, clients, layout);
    // Do not inflate the 1-client case to connect every mixed fixture.
    for (let index = 0; index < clients; index++) {
      const target = roots[index % roots.length]!;
      sessions.push(createSession(target.root, command, env));
    }
    const starts = await Promise.allSettled(
      sessions.map((session) =>
        timed(measurements, "connect", () =>
          session.client.connect(session.transport, { timeout: 15_000 }),
        ),
      ),
    );
    const startup = starts.find((start) => start.status === "rejected");
    if (startup?.status === "rejected") throw startup.reason;
    if (indexed(workload)) {
      for (const root of roots) {
        const peers = sessions
          .entries()
          .filter(([, session]) => session.root === root.root)
          .toArray();
        const first = peers[0]?.[1];
        if (!first) continue;

        const working = await open(first, measurements);
        await tool(first, measurements, "index", {
          action: "build",
          workspaceId: working,
        });

        const oid = await git(root.root, ["rev-parse", "HEAD"]);
        const revision = { kind: "commit", oid } as const;
        for (const [index, session] of peers) {
          const storage =
            workload === "indexed"
              ? {
                  kind: "explicit" as const,
                  path: path.join(sandbox, "retrieval", String(index)),
                }
              : undefined;
          session.committedWorkspace = await open(
            session,
            measurements,
            revision,
            storage,
          );
          if (storage || session === first)
            await tool(session, measurements, "index", {
              action: "build",
              workspaceId: session.committedWorkspace,
            });
        }
      }
    }
    const started = performance.now();
    for (let sample = 1; sample <= samples; sample++) {
      await Promise.allSettled(
        sessions.map((session, index) =>
          timed(measurements, "workflow", () =>
            workflow(
              session,
              measurements,
              index,
              sample,
              workload,
              roots[index % roots.length]!.symbol,
              fixturePolicy.requireHash,
            ),
          ),
        ),
      );
    }
    elapsedMs = performance.now() - started;
    measurements.set(
      "firstWorkflow",
      measurements.get("workflow")!.slice(0, clients),
    );
    if (
      indexed(workload) &&
      measurements.get("file_patch")?.filter((entry) => entry.ok).length ===
        clients * samples
    ) {
      for (const root of roots) {
        const index = sessions.findIndex(
          (session) => session.root === root.root,
        );
        if (index < 0) continue;
        const session = sessions[index]!;
        const working = await open(session, measurements);
        await retrieveEvidence(
          session,
          measurements,
          working,
          "sample" + index,
          "sample" + index + ".ts",
          samples,
          true,
        );
      }
    }
    verifiedElapsedMs = performance.now() - started;
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
    if (
      cause &&
      typeof cause === "object" &&
      "code" in cause &&
      typeof cause.code === "string"
    )
      errorCode = cause.code;
  } finally {
    try {
      const disconnected = performance.now();
      const closed = await Promise.allSettled(
        sessions.map((session) =>
          timed(measurements, "disconnect", () => session.client.close()),
        ),
      );
      disconnectMs = performance.now() - disconnected;
      if (closed.some((result) => result.status === "rejected"))
        error ??= "One or more sessions did not disconnect";
      processMetrics = await sampler.finish(cleanupMs);
      if (
        installationKey &&
        process.platform !== "win32" &&
        processMetrics?.brokerProcessIds.length !== 1
      )
        error ??= "Expected exactly one uniquely attributed shared broker";
      if (processMetrics?.remainingProcessIds.length)
        error ??= "Owned processes outlived the cleanup window";
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  }
  const observed = measurements.get("workflow") ?? [];
  const correct = observed.filter((entry) => entry.ok).length;
  if (
    workload === "indexed-contention" &&
    observed.some(
      (entry) => !entry.ok && entry.code !== "coordinator_unavailable",
    )
  )
    error ??= "Unexpected failure in the indexed contention workload";
  return {
    clients,
    layout,
    workload,
    elapsedMs,
    verifiedElapsedMs,
    disconnectMs,
    error,
    errorCode,
    observational: workload === "indexed-contention",
    valid: !error && correct === clients * samples,
    correctWorkflowsPerSecond:
      elapsedMs === undefined ? null : (correct * 1000) / elapsedMs,
    latency: summaries(measurements),
    processMetrics,
  };
}

async function main() {
  const config = options(Bun.argv.slice(2));
  const results: Array<
    Awaited<ReturnType<typeof measureCell>> & { round: number; variant: string }
  > = [];
  const base = await git(sourceRoot, ["rev-parse", "HEAD"]);
  const variants = [{ variant: "baseline", command: config.command }];
  if (config.compareCommand)
    variants.push({ variant: "candidate", command: config.compareCommand });
  for (let round = 1; round <= config.rounds; round++) {
    const sequence = round % 2 === 1 ? variants : [...variants].reverse();
    for (const clients of config.clients) {
      for (const layout of config.layout) {
        for (const workload of config.workload) {
          for (const { command, variant } of sequence) {
            const cell = await measureCell(
              command,
              clients,
              layout,
              workload,
              config.samples,
              config.cleanupMs,
              config.fixturePolicy,
            );
            results.push({ ...cell, round, variant });
            process.stderr.write(
              [variant, round, clients, layout, workload].join("/") +
                ": " +
                (cell.valid
                  ? "valid"
                  : cell.observational && !cell.error
                    ? "observed failure"
                    : "invalid") +
                "\n",
            );
          }
        }
      }
    }
  }
  console.log(
    JSON.stringify(
      {
        base,
        bun: Bun.version,
        platform: process.platform,
        arch: process.arch,
        host: { cpus: os.availableParallelism(), memoryBytes: os.totalmem() },
        methodology: {
          fixtures:
            "Fresh committed TypeScript checkouts per cell; mixed rotates main, linked, independent.",
          memory:
            "Sampled summed process-tree RSS, not unique memory. Short-lived descendants may escape sampling.",
          cpu: "Sampled child CPU lower bound; null process metrics indicate unavailable process sampling.",
          verifiedElapsedMs:
            "Wall clock from timed work through the final exact-byte check, including all strict working reads.",
          timing:
            "Start and join clients together per wave. Percentiles include failed attempts. Indexed workloads verify changed working evidence after quiescence, outside workflow timing, with a fixed 20 s tool budget.",
          formatting:
            "Enabled samples spawn a Bun pass-through formatter and keep the same byte oracle.",
          indexedDomains:
            "Indexed overlap uses immutable anchors in per-client explicit stores. Indexed-contention uses the working storage domain and reports rejected calls without marking them as success.",
        },
        config,
        results,
      },
      null,
      2,
    ),
  );
  if (
    results.some((cell) => cell.error || (!cell.observational && !cell.valid))
  )
    process.exitCode = 1;
}

if (import.meta.main) await main();
