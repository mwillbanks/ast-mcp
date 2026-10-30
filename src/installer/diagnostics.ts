import { readFile, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { codexHome } from "../helpers/installer";

type HostTarget = "auto" | "codex" | "claude" | "copilot";
type Scope = "local" | "global";
type Document = Record<string, unknown>;

function record(value: unknown): value is Document {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function document(file: string, kind: "toml" | "json") {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > 1024 * 1024)
      return { status: "unreadable" as const, value: {} as Document };
    const source = await readFile(file, "utf8");
    const value =
      kind === "toml" ? Bun.TOML.parse(source) : Bun.JSONC.parse(source);
    return record(value)
      ? { status: "loaded" as const, value }
      : { status: "invalid" as const, value: {} as Document };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      status:
        code === "ENOENT"
          ? ("missing" as const)
          : code === undefined
            ? ("invalid" as const)
            : ("unreadable" as const),
      value: {} as Document,
    };
  }
}

function policySummary(policy: unknown) {
  if (policy === "never") return { policy: "never", elicitation: "blocked" };
  if (policy === "on-request" || policy === "untrusted")
    return { policy, elicitation: "allowed" };
  if (record(policy) && record(policy.granular)) {
    const enabled = policy.granular.mcp_elicitations;
    return {
      policy: "granular",
      elicitation:
        enabled === true
          ? "allowed"
          : enabled === false
            ? "blocked"
            : "unknown",
    };
  }
  return {
    policy: policy === undefined ? "default" : "unsupported",
    elicitation: "unknown",
  };
}

function profilePolicy(value: Document, profile: string | undefined) {
  if (!profile || !record(value.profiles)) return undefined;
  const entry = value.profiles[profile];
  return record(entry) ? entry.approval_policy : undefined;
}

function selectedProfile(value: unknown): string | undefined {
  return typeof value === "string" && /^[\w.-]{1,100}$/.test(value)
    ? value
    : undefined;
}

async function projectConfiguration(root: string) {
  const candidates: string[] = [];
  let directory = root;
  let boundaryFound = false;
  for (let depth = 0; depth < 64; depth++) {
    candidates.push(directory);
    if (
      await stat(path.join(directory, ".git")).then(
        () => true,
        () => false,
      )
    ) {
      boundaryFound = true;
      break;
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  const layers = await Promise.all(
    (boundaryFound ? candidates.reverse() : [root]).map((candidate) =>
      document(path.join(candidate, ".codex/config.toml"), "toml"),
    ),
  );
  const invalid = layers.find(
    (layer) => layer.status === "invalid" || layer.status === "unreadable",
  );
  const loaded = layers.filter((layer) => layer.status === "loaded");
  return {
    status:
      invalid?.status ??
      (loaded.length ? ("loaded" as const) : ("missing" as const)),
    value: Object.assign({}, ...loaded.map((layer) => layer.value)) as Document,
    count: loaded.length,
  };
}

export async function inspectCodexConfiguration(options: {
  root: string;
  scope: Scope;
  home?: string;
  env?: NodeJS.ProcessEnv;
  profile?: string;
}) {
  const home = options.home ?? os.homedir();
  const env = options.env ?? process.env;
  const global = await document(
    path.join(codexHome(home, env), "config.toml"),
    "toml",
  );
  const project =
    options.scope === "local"
      ? await projectConfiguration(options.root)
      : { status: "not-selected" as const, value: {} as Document, count: 0 };
  // Modern Codex loads named global profile files below trusted project overrides.
  // Older hosts used inline profiles; report both interpretations when they differ.
  const profile = options.profile ?? selectedProfile(global.value.profile);
  const profileFile = profile
    ? await document(
        path.join(codexHome(home, env), `${profile}.config.toml`),
        "toml",
      )
    : { status: "not-selected" as const, value: {} as Document };
  const projects = record(global.value.projects) ? global.value.projects : {};
  const trustKey = Object.keys(projects)
    .filter((candidate) => {
      const relative = path.relative(candidate, options.root);
      return (
        relative === "" ||
        (!relative.startsWith(`..${path.sep}`) &&
          relative !== ".." &&
          !path.isAbsolute(relative))
      );
    })
    .sort((first, second) => second.length - first.length)[0];
  const trustedEntry = trustKey ? projects[trustKey] : undefined;
  const trust = record(trustedEntry) ? trustedEntry.trust_level : undefined;
  const projectPolicy = project.value.approval_policy;
  const projectTrustUnknown = project.count > 0 && trust !== "trusted";
  const modernPolicy =
    projectPolicy ??
    profileFile.value.approval_policy ??
    global.value.approval_policy;
  const profileProject = profilePolicy(project.value, profile);
  const profileGlobal = profilePolicy(global.value, profile);
  const legacyPolicy =
    profileProject ??
    profileGlobal ??
    projectPolicy ??
    global.value.approval_policy;
  const legacyAmbiguous =
    profileFile.status !== "loaded" &&
    (profileProject !== undefined || profileGlobal !== undefined) &&
    JSON.stringify(policySummary(legacyPolicy)) !==
      JSON.stringify(policySummary(modernPolicy));
  const source =
    projectPolicy !== undefined
      ? "project"
      : profileFile.value.approval_policy !== undefined
        ? "profile-file"
        : global.value.approval_policy !== undefined
          ? "global"
          : "default";
  const invalid = [global.status, project.status, profileFile.status].some(
    (status) => status === "invalid" || status === "unreadable",
  );
  const summary =
    invalid || legacyAmbiguous || projectTrustUnknown || trust === "untrusted"
      ? { policy: "unknown", elicitation: "unknown" }
      : policySummary(modernPolicy);
  return {
    target: "codex",
    layers: {
      global: global.status,
      project: project.status,
      projectLayerCount: project.count,
      profileFile: profileFile.status,
      customHome: Boolean(env.CODEX_HOME),
      legacyInlineProfiles:
        profileProject !== undefined || profileGlobal !== undefined,
    },
    selectedProfile: profile ?? "unknown",
    disk: {
      ...summary,
      source:
        invalid || projectTrustUnknown
          ? "unknown"
          : legacyAmbiguous
            ? "host-version-dependent"
            : source,
      trust: trust === "trusted" || trust === "untrusted" ? trust : "unknown",
      modernCandidate: policySummary(modernPolicy),
      legacyCandidate: policySummary(legacyPolicy),
    },
    session: {
      approvalPolicy: "unknown",
      backendVersion: "unknown",
      overrides: "unknown",
      readiness: "unknown",
    },
    guidance: [
      "Disk configuration does not establish the running session policy.",
      "Codex Desktop Full access can override disk settings with approval_policy=never.",
      "CLI approval flags can override disk policy. Modern named profile files load below trusted project overrides.",
      "Project profile declarations are ignored by modern Codex; older inline-profile behavior can differ.",
      "Use a session policy that permits MCP elicitation, reconnect when required, and answer the real approval form.",
      "Per-tool approval settings do not authorize the separate AST-MCP filesystem challenge.",
    ],
  };
}

async function inspectJsonHost(
  target: "claude" | "copilot",
  root: string,
  scope: Scope,
  home: string,
) {
  const file =
    target === "claude"
      ? scope === "global"
        ? path.join(home, ".claude.json")
        : path.join(root, ".mcp.json")
      : scope === "global"
        ? path.join(home, ".copilot/mcp-config.json")
        : path.join(root, ".github/mcp.json");
  const loaded = await document(file, "json");
  const servers = record(loaded.value.mcpServers)
    ? loaded.value.mcpServers
    : {};
  const configured = record(servers["ast-mcp"]);
  return {
    target,
    configuration: loaded.status,
    astMcpConfigured: configured,
    session: {
      approvalPolicy: "unknown",
      backendVersion: "unknown",
      readiness: "unknown",
    },
    guidance: [
      "Use live MCP diagnostics to inspect negotiated capabilities and approval outcomes.",
    ],
  };
}

async function packageVersion(file: string): Promise<string> {
  const result = await document(file, "json");
  return result.value.name === "@mwillbanks/ast-mcp" &&
    typeof result.value.version === "string" &&
    /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/.test(result.value.version)
    ? result.value.version
    : "unknown";
}

async function globalPackageVersion() {
  const binary = Bun.which("ast-mcp");
  if (!binary) return "unknown";
  try {
    let directory = path.dirname(await realpath(binary));
    for (let depth = 0; depth < 4; depth++) {
      const version = await packageVersion(
        path.join(directory, "package.json"),
      );
      if (version !== "unknown") return version;
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  } catch {}
  return "unknown";
}

async function upgradeGuidance(root: string, scope: Scope, target: HostTarget) {
  const project = await document(path.join(root, "package.json"), "json");
  let manager =
    typeof project.value.packageManager === "string"
      ? /^(bun|npm|pnpm|yarn)@/.exec(project.value.packageManager)?.[1]
      : undefined;
  if (scope === "global") {
    const binary = (Bun.which("ast-mcp") ?? "").replaceAll("\\", "/");
    manager = binary.includes("/.bun/")
      ? "bun"
      : binary.includes("/pnpm/")
        ? "pnpm"
        : binary.includes("/npm/")
          ? "npm"
          : undefined;
  } else if (!manager) {
    const locks = [
      ["bun", "bun.lock"],
      ["bun", "bun.lockb"],
      ["pnpm", "pnpm-lock.yaml"],
      ["yarn", "yarn.lock"],
      ["npm", "package-lock.json"],
    ] as const;
    const present = await Promise.all(
      locks.map(
        async ([name, file]) =>
          await stat(path.join(root, file)).then(
            () => name,
            () => undefined,
          ),
      ),
    );
    const managers = new Set(present.filter(Boolean));
    if (managers.size === 1) manager = [...managers][0];
  }
  const local: Record<string, string> = {
    bun: "bun add --dev @mwillbanks/ast-mcp@latest",
    npm: "npm install --save-dev @mwillbanks/ast-mcp@latest",
    pnpm: "pnpm add --save-dev @mwillbanks/ast-mcp@latest",
    yarn: "yarn add --dev @mwillbanks/ast-mcp@latest",
  };
  const global: Record<string, string> = {
    bun: "bun add --global @mwillbanks/ast-mcp@latest",
    npm: "npm install --global @mwillbanks/ast-mcp@latest",
    pnpm: "pnpm add --global @mwillbanks/ast-mcp@latest",
  };
  return {
    manager: manager ?? "unknown",
    command: manager
      ? ((scope === "global" ? global : local)[manager] ?? "unknown")
      : "unknown",
    refreshCommand: `${scope === "local" ? "./node_modules/.bin/ast-mcp" : "ast-mcp"} update --scope ${scope} --target ${target === "auto" ? "all" : target}`,
    automatic: false,
    steps: [
      "Use the existing installation package manager and scope. Consult the installation skill reference when the manager is unknown.",
      "After an authorized package upgrade, refresh managed host configuration, reconnect the MCP server, and rerun live diagnostics.",
      "A newer shell executable does not establish that the connected server restarted.",
    ],
  };
}

export async function inspectHostConfiguration(options: {
  root: string;
  scope: Scope;
  target: HostTarget;
  profile?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
}) {
  const home = options.home ?? os.homedir();
  const requested =
    options.target === "auto"
      ? (["codex", "claude", "copilot"] as const)
      : [options.target];
  const hosts = await Promise.all(
    requested.map((target) =>
      target === "codex"
        ? inspectCodexConfiguration({ ...options, home })
        : inspectJsonHost(target, options.root, options.scope, home),
    ),
  );
  return {
    scope: options.scope,
    requestedTarget: options.target,
    hosts,
    upgrade: await upgradeGuidance(options.root, options.scope, options.target),
    installedPackages: {
      projectVersion: await packageVersion(
        path.join(
          options.root,
          "node_modules/@mwillbanks/ast-mcp/package.json",
        ),
      ),
      pathExecutableVersion: await globalPackageVersion(),
      connectedServerVersion: "unknown",
      desktopBackendVersion: "unknown",
    },
    guidance: [
      "The CLI process, PATH executable, project package, and connected MCP server can run different versions. Run MCP diagnostics for the connected server.",
    ],
  };
}
