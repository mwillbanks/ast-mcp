import { statSync } from "node:fs";
import path from "node:path";

const bridgeOption = "--shared-stdio";
const brokerOption = "--broker";

export function brokerInstallationKey(
  entry: string,
  env: NodeJS.ProcessEnv,
): string {
  const stat = statSync(entry, { bigint: true });
  const source = sourceIdentity(entry);
  // The broker inherits the first caller's environment. Never reuse it for
  // callers with different subprocess or policy-related environment values.
  const environment = Object.entries(env)
    .filter(([name]) => !/^(?:PWD|OLDPWD|SHLVL|_|CODEX_THREAD_ID)$/u.test(name))
    .sort(([a], [b]) => a.localeCompare(b));
  return new Bun.CryptoHasher("sha256")
    .update(
      JSON.stringify([
        entry,
        stat.dev.toString(),
        stat.ino.toString(),
        stat.mtimeNs.toString(),
        Bun.version,
        source,
        environment,
      ]),
    )
    .digest("hex");
}

function sourceIdentity(entry: string): string | undefined {
  // Executables and built bundles have a single immutable entry artifact.
  if (!entry.endsWith(".ts")) return undefined;
  const directory = path.resolve(path.dirname(entry), "..");
  const hasher = new Bun.CryptoHasher("sha256");
  const files = [
    ...new Bun.Glob("src/**/*.ts").scanSync({ cwd: directory }),
    "bun.lock",
    "package.json",
  ].sort();
  for (const file of files) {
    const stats = statSync(path.join(directory, file), { bigint: true });
    hasher.update(
      JSON.stringify([
        file,
        String(stats.ino),
        String(stats.mtimeNs),
        String(stats.size),
      ]),
    );
  }
  return hasher.digest("hex");
}

function launchIdentity(): { command: string[]; key: string } {
  const main = Bun.main;
  const executable = process.execPath;
  const embedded =
    main.startsWith("/$bunfs/") || /^[a-z]:\\~BUN\\/iu.test(main);
  const entry = embedded ? executable : main;
  return {
    command: embedded ? [executable] : [executable, "run", main],
    key: brokerInstallationKey(entry, process.env),
  };
}

export async function runSharedCli(args: string[]): Promise<boolean> {
  if (args[0] !== "mcp") return false;
  if (args[1] === bridgeOption && args.length === 2) {
    if (process.platform === "win32" || typeof Bun.ModuleGraph !== "function") {
      await import("../index.ts");
      return true;
    }
    const { runStdioBridge } = await import("./shared-broker/bridge.ts");
    const { command, key } = launchIdentity();
    await runStdioBridge({
      daemonCommand: [...command, "mcp", brokerOption, key],
      installationKey: key,
      launch: { cwd: process.cwd() },
    });
    return true;
  }
  if (args[1] === brokerOption && args.length === 3) {
    const key = args[2]!;
    if (!/^[a-f0-9]{64}$/u.test(key))
      throw new Error("Invalid internal broker identity");
    const [
      { runSharedBroker, standaloneBrokerLifetime },
      { ProjectRuntimes },
      { createServer },
      { createSharedNativeAdmission },
      { stopMutationRefreshes },
      { CommittedRetrievalLanes },
      { currentConfig },
    ] = await Promise.all([
      import("./shared-broker/broker.ts"),
      import("./project-runtimes.ts"),
      import("./index.ts"),
      import("../tools/code-intelligence.ts"),
      import("../intelligence/mutation/experimental-deferred-refresh.ts"),
      import("./committed-retrieval-lanes.ts"),
      import("../config/index.ts"),
    ]);
    if (process.platform === "win32" || typeof Bun.ModuleGraph !== "function")
      throw new Error("Shared stdio is not available on this runtime");
    const runtimes = new ProjectRuntimes(Bun.main);
    const lanes = new CommittedRetrievalLanes(Bun.main);
    const intelligence: typeof runtimes.intelligence = {
      ...runtimes.intelligence,
      async retrieve(input, workspace, signal) {
        const inline = () =>
          runtimes.intelligence.retrieve(input, workspace, signal);
        if (
          workspace.selectedRevision.selector.kind !== "commit" ||
          input.strictRead ||
          (input.semantic ??
            (await currentConfig()).intelligence.retrieval.semantic)
        )
          return inline();
        return lanes.retrieve(input, workspace, inline, signal);
      },
    };
    const nativeAdmission = createSharedNativeAdmission();
    await runSharedBroker({
      installationKey: key,
      lifetime: standaloneBrokerLifetime(),
      stopBackgroundWork: stopMutationRefreshes,
      closeProjectRuntimes: async () => {
        const results = await Promise.allSettled([
          runtimes.close(),
          lanes.close(),
        ]);
        const failed = results.find((result) => result.status === "rejected");
        if (failed) throw failed.reason;
      },
      connectSession: async (transport, launch) => {
        const server = createServer(
          {},
          {},
          { launchCwd: launch.cwd },
          {
            intelligence,
            nativeAdmission,
            transport: "stdio",
          },
        );
        try {
          await server.connect(transport);
          return server;
        } catch (error) {
          await server.close();
          throw error;
        }
      },
    });
    return true;
  }
  return false;
}
