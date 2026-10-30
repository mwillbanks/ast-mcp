import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { install, uninstall, update } from "../../src/installer";

const created: string[] = [];
const oldCodexHome = process.env.CODEX_HOME;
afterEach(async () => {
  if (oldCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = oldCodexHome;
  await Promise.all(
    created.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-host-preserve-"));
  created.push(root);
  const home = path.join(root, "home");
  await mkdir(home);
  process.env.CODEX_HOME = path.join(home, ".codex");
  return { root, home, scope: "local" as const, verifyLaunch: async () => {} };
}

test("JSON host refresh and uninstall preserve user server settings across transports", async () => {
  for (const target of ["claude", "copilot"] as const) {
    const options = await fixture();
    const file = path.join(
      options.root,
      target === "claude" ? ".mcp.json" : ".github/mcp.json",
    );
    await mkdir(path.dirname(file), { recursive: true });
    const custom = {
      env: { CUSTOM: "unique-env-secret" },
      headers: { Authorization: "unique-header-secret" },
      timeout: 45000,
      tools: ["file_read"],
      disabledTools: ["file_delete"],
    };
    await writeFile(
      file,
      JSON.stringify({
        mcpServers: {
          "ast-mcp": { command: "old", args: ["old"], ...custom },
          other: { command: "keep" },
        },
      }),
    );
    await install({ ...options, targets: [target], transport: "http" });
    let server = JSON.parse(await readFile(file, "utf8")).mcpServers["ast-mcp"];
    expect(server).toMatchObject(custom);
    expect(server.command).toBeUndefined();
    const receiptFile = file + ".ast-mcp.json";
    const receiptText = await readFile(receiptFile, "utf8");
    expect(receiptText).not.toContain("unique-env-secret");
    expect(receiptText).not.toContain("unique-header-secret");
    if (process.platform !== "win32") {
      expect((await stat(receiptFile)).mode & 0o777).toBe(0o600);
      await chmod(receiptFile, 0o640);
    }
    await update({ ...options, targets: [target], transport: "stdio" });
    server = JSON.parse(await readFile(file, "utf8")).mcpServers["ast-mcp"];
    expect(server).toMatchObject(custom);
    expect(server.url).toBeUndefined();
    if (process.platform !== "win32")
      expect((await stat(receiptFile)).mode & 0o777).toBe(0o600);
    await uninstall({ ...options, targets: [target] });
    const value = JSON.parse(await readFile(file, "utf8"));
    expect(value.mcpServers["ast-mcp"]).toEqual({
      command: "old",
      args: ["old"],
      ...custom,
    });
    expect(value.mcpServers.other).toEqual({ command: "keep" });
  }
});

test("custom legacy hook scripts survive refresh, uninstall and malformed settings", async () => {
  for (const target of ["codex", "claude", "copilot"] as const) {
    const options = await fixture();
    const base = path.join(
      options.root,
      target === "codex"
        ? ".codex"
        : target === "claude"
          ? ".claude"
          : ".github",
    );
    const script = path.join(base, "hooks/ast-mcp.ts");
    const settings = path.join(
      base,
      target === "codex"
        ? "hooks.json"
        : target === "claude"
          ? "settings.json"
          : "hooks/ast-mcp.json",
    );
    await mkdir(path.dirname(script), { recursive: true });
    await writeFile(script, "// customized user hook\n");
    await writeFile(settings, "invalid {");
    await expect(install({ ...options, targets: [target] })).rejects.toThrow();
    expect(await readFile(script, "utf8")).toBe("// customized user hook\n");
    const legacyCommand = `bun ${JSON.stringify(script)}`;
    const event = target === "copilot" ? "preToolUse" : "PreToolUse";
    await writeFile(
      settings,
      JSON.stringify({
        hooks: {
          [event]:
            target === "copilot"
              ? [{ type: "command", command: legacyCommand }]
              : [{ hooks: [{ type: "command", command: legacyCommand }] }],
        },
      }),
    );
    await install({ ...options, targets: [target] });
    const configured = JSON.parse(await readFile(settings, "utf8"));
    if (target !== "copilot") {
      configured.hooks[event]
        .at(-1)
        .hooks.push({ type: "command", command: "echo custom-child" });
      await writeFile(settings, JSON.stringify(configured));
    }
    await update({ ...options, targets: [target] });
    await uninstall({ ...options, targets: [target] });
    expect(await readFile(settings, "utf8")).toContain(
      JSON.stringify(legacyCommand).slice(1, -1),
    );
    if (target !== "copilot")
      expect(await readFile(settings, "utf8")).toContain("custom-child");
    expect(await readFile(script, "utf8")).toBe("// customized user hook\n");
  }
});

test("global selected modern profiles restore owned policy after profile switches", async () => {
  const options = await fixture();
  const base = process.env.CODEX_HOME!;
  const bin = path.join(options.home, "bin");
  await mkdir(base, { recursive: true });
  await mkdir(bin);
  const executable = path.join(
    bin,
    process.platform === "win32" ? "ast-mcp.cmd" : "ast-mcp",
  );
  await writeFile(executable, "");
  await chmod(executable, 0o755);
  const config = path.join(base, "config.toml");
  await writeFile(config, 'profile = "safe"\n');
  const safe = path.join(base, "safe.config.toml");
  const other = path.join(base, "other.config.toml");
  await writeFile(
    safe,
    'model = "keep"\n[approval_policy.granular]\nrules = false\nmcp_elicitations = false\n',
  );
  await writeFile(other, 'approval_policy = "never"\n');
  const global = {
    ...options,
    scope: "global" as const,
    targets: ["codex"] as ["codex"],
    globalBinDirectories: [bin],
  };
  await install(global);
  expect(
    (Bun.TOML.parse(await readFile(safe, "utf8")) as any).approval_policy
      .granular.mcp_elicitations,
  ).toBeTrue();
  await writeFile(
    safe,
    (await readFile(safe, "utf8")).replace(
      'model = "keep"',
      'model = "user-edit"',
    ),
  );
  await writeFile(
    config,
    (await readFile(config, "utf8")).replace(
      'profile = "safe"',
      'profile = "other"',
    ),
  );
  await update(global);
  expect(
    (Bun.TOML.parse(await readFile(other, "utf8")) as any).approval_policy
      .granular.mcp_elicitations,
  ).toBeTrue();
  await uninstall(global);
  const restored = Bun.TOML.parse(await readFile(safe, "utf8")) as any;
  expect(restored.approval_policy).toEqual({
    granular: { rules: false, mcp_elicitations: false },
  });
  expect(restored.model).toBe("user-edit");
  expect(
    (Bun.TOML.parse(await readFile(other, "utf8")) as any).approval_policy,
  ).toBe("never");
  expect(await readFile(config, "utf8")).not.toContain("ast-mcp:profile-file");
});

test("local and global base policies restore after installer roundtrips", async () => {
  for (const scope of ["local", "global"] as const) {
    const options = await fixture();
    const base =
      scope === "local"
        ? path.join(options.root, ".codex")
        : process.env.CODEX_HOME!;
    await mkdir(base, { recursive: true });
    const config = path.join(base, "config.toml");
    const original =
      'approval_policy = "never"\n[profiles.safe]\nmodel = "keep"\napproval_policy = "never"\n';
    await writeFile(config, original);
    const bin = path.join(options.home, "bin");
    await mkdir(bin);
    const binary = path.join(
      bin,
      process.platform === "win32" ? "ast-mcp.cmd" : "ast-mcp",
    );
    await writeFile(binary, "");
    await chmod(binary, 0o755);
    const installation = {
      ...options,
      scope,
      targets: ["codex"] as ["codex"],
      globalBinDirectories: [bin],
    };
    await install(installation);
    await update(installation);
    await uninstall(installation);
    expect(Bun.TOML.parse(await readFile(config, "utf8"))).toEqual(
      Bun.TOML.parse(original),
    );
  }
});

test("Copilot tools edits survive update and uninstall with a complete launch", async () => {
  const options = await fixture();
  const installation = { ...options, targets: ["copilot"] as ["copilot"] };
  await install(installation);
  const file = path.join(options.root, ".github/mcp.json");
  const value = JSON.parse(await readFile(file, "utf8"));
  value.mcpServers["ast-mcp"].tools = ["file_read"];
  await writeFile(file, JSON.stringify(value));
  await update(installation);
  await uninstall(installation);
  const retained = JSON.parse(await readFile(file, "utf8")).mcpServers[
    "ast-mcp"
  ];
  expect(retained.tools).toEqual(["file_read"]);
  expect(typeof retained.command).toBe("string");
  expect(retained.command.length).toBeGreaterThan(0);
});

test("Copilot tools deletion stays absent across updates and transport transitions", async () => {
  for (const initialTransport of ["stdio", "http"] as const) {
    const options = await fixture();
    const file = path.join(options.root, ".github/mcp.json");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      JSON.stringify({
        mcpServers: {
          "ast-mcp": {
            command: "original",
            args: ["custom"],
            tools: ["file_read"],
          },
        },
      }),
    );
    const installation = { ...options, targets: ["copilot"] as ["copilot"] };
    await install({ ...installation, transport: initialTransport });
    const value = JSON.parse(await readFile(file, "utf8"));
    delete value.mcpServers["ast-mcp"].tools;
    await writeFile(file, JSON.stringify(value));
    for (const transport of [
      initialTransport === "stdio" ? "http" : "stdio",
      initialTransport,
    ] as const) {
      await update({ ...installation, transport });
      expect(
        Object.hasOwn(
          JSON.parse(await readFile(file, "utf8")).mcpServers["ast-mcp"],
          "tools",
        ),
      ).toBeFalse();
    }
    await uninstall(installation);
    expect(
      JSON.parse(await readFile(file, "utf8")).mcpServers["ast-mcp"],
    ).toEqual({ command: "original", args: ["custom"] });
  }
});

test("customized hook registrations retain fields after update and uninstall", async () => {
  for (const target of ["codex", "claude", "copilot"] as const) {
    const options = await fixture();
    const installation = { ...options, targets: [target] };
    await install(installation);
    const base = path.join(
      options.root,
      target === "codex"
        ? ".codex"
        : target === "claude"
          ? ".claude"
          : ".github",
    );
    const file = path.join(
      base,
      target === "codex"
        ? "hooks.json"
        : target === "claude"
          ? "settings.json"
          : "hooks/ast-mcp.json",
    );
    const event = target === "copilot" ? "preToolUse" : "PreToolUse";
    const document = JSON.parse(await readFile(file, "utf8"));
    const registration = document.hooks[event][0];
    registration.matcher = "custom-matcher";
    registration.metadata = { user: "keep" };
    if (target === "copilot") registration.timeoutSec = 45;
    else {
      registration.hooks[0].timeout = 45;
      registration.hooks[0].metadata = { child: "keep" };
    }
    await writeFile(file, JSON.stringify(document));
    await update(installation);
    let actual = JSON.parse(await readFile(file, "utf8")).hooks[event];
    expect(actual).toHaveLength(1);
    expect(actual[0]).toEqual(registration);
    await uninstall(installation);
    actual = JSON.parse(await readFile(file, "utf8")).hooks[event];
    expect(actual).toHaveLength(1);
    expect(actual[0]).toEqual(registration);
  }
});
test("imported Copilot entries without tools keep their absence", async () => {
  const options = await fixture();
  const file = path.join(options.root, ".github/mcp.json");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    JSON.stringify({ mcpServers: { "ast-mcp": { command: "original" } } }),
  );
  const installation = { ...options, targets: ["copilot"] as ["copilot"] };
  await install(installation);
  expect(
    JSON.parse(await readFile(file, "utf8")).mcpServers["ast-mcp"].tools,
  ).toBeUndefined();
  await update(installation);
  expect(
    JSON.parse(await readFile(file, "utf8")).mcpServers["ast-mcp"].tools,
  ).toBeUndefined();
  await uninstall(installation);
  expect(
    JSON.parse(await readFile(file, "utf8")).mcpServers["ast-mcp"],
  ).toEqual({ command: "original" });
});

test("duplicate untouched factory registrations collapse without dropping customized entries", async () => {
  for (const target of ["codex", "copilot"] as const) {
    const options = await fixture();
    const installation = { ...options, targets: [target] };
    await install(installation);
    const file = path.join(
      options.root,
      target === "codex" ? ".codex/hooks.json" : ".github/hooks/ast-mcp.json",
    );
    const event = target === "codex" ? "PreToolUse" : "preToolUse";
    const document = JSON.parse(await readFile(file, "utf8"));
    document.hooks[event].push(structuredClone(document.hooks[event][0]));
    await writeFile(file, JSON.stringify(document));
    await update(installation);
    expect(JSON.parse(await readFile(file, "utf8")).hooks[event]).toHaveLength(
      1,
    );
    await uninstall(installation);
    expect(JSON.parse(await readFile(file, "utf8")).hooks).toBeUndefined();
  }
});

test("unknown ast-named hook paths never acquire installer ownership", async () => {
  for (const target of ["codex", "claude", "copilot"] as const) {
    const options = await fixture();
    const base = path.join(
      options.root,
      target === "codex"
        ? ".codex"
        : target === "claude"
          ? ".claude"
          : ".github",
    );
    const file = path.join(
      base,
      target === "codex"
        ? "hooks.json"
        : target === "claude"
          ? "settings.json"
          : "hooks/ast-mcp.json",
    );
    await mkdir(path.dirname(file), { recursive: true });
    const event = target === "copilot" ? "preToolUse" : "PreToolUse";
    const command = 'bun "/custom/hooks/ast-mcp.ts" hook';
    const registration =
      target === "copilot"
        ? { type: "command", command }
        : { matcher: ".*", hooks: [{ type: "command", command }] };
    await writeFile(
      file,
      JSON.stringify({ hooks: { [event]: [registration] } }),
    );
    const installation = { ...options, targets: [target] };
    await install(installation);
    await update(installation);
    let hooks = JSON.parse(await readFile(file, "utf8")).hooks[event];
    expect(hooks).toHaveLength(2);
    expect(hooks[0]).toEqual(registration);
    await uninstall(installation);
    hooks = JSON.parse(await readFile(file, "utf8")).hooks[event];
    expect(hooks).toEqual([registration]);
  }
});
test("explicit hook factory field deletion survives refresh and uninstall", async () => {
  for (const target of ["codex", "copilot"] as const) {
    const options = await fixture();
    const installation = { ...options, targets: [target] };
    await install(installation);
    const file = path.join(
      options.root,
      target === "codex" ? ".codex/hooks.json" : ".github/hooks/ast-mcp.json",
    );
    const event = target === "codex" ? "PreToolUse" : "preToolUse";
    const document = JSON.parse(await readFile(file, "utf8"));
    delete document.hooks[event][0].matcher;
    if (target === "copilot") delete document.hooks[event][0].timeoutSec;
    else delete document.hooks[event][0].hooks[0].timeout;
    await writeFile(file, JSON.stringify(document));
    await update(installation);
    expect(JSON.parse(await readFile(file, "utf8")).hooks[event]).toEqual(
      document.hooks[event],
    );
    await uninstall(installation);
    expect(JSON.parse(await readFile(file, "utf8")).hooks[event]).toEqual(
      document.hooks[event],
    );
  }
});
test("exact legacy factory registrations migrate and remain removable", async () => {
  for (const target of ["codex", "copilot"] as const) {
    const options = await fixture();
    const file = path.join(
      options.root,
      target === "codex" ? ".codex/hooks.json" : ".github/hooks/ast-mcp.json",
    );
    await mkdir(path.dirname(file), { recursive: true });
    const event = target === "codex" ? "PreToolUse" : "preToolUse";
    const command = 'bun "/legacy/ast-mcp.ts" hook';
    const registration =
      target === "copilot"
        ? {
            command,
            matcher: "bash|powershell|edit|create",
            timeoutSec: 10,
            type: "command",
          }
        : {
            matcher: ".*",
            hooks: [
              {
                command,
                statusMessage: "Enforcing ast-mcp writes",
                timeout: 10,
                type: "command",
              },
            ],
          };
    await writeFile(
      file,
      JSON.stringify({ hooks: { [event]: [registration] } }),
    );
    const installation = { ...options, targets: [target] };
    await install(installation);
    const hooks = JSON.parse(await readFile(file, "utf8")).hooks[event];
    expect(hooks).toHaveLength(1);
    expect(
      target === "copilot" ? hooks[0].command : hooks[0].hooks[0].command,
    ).not.toBe(command);
    await uninstall(installation);
    expect(JSON.parse(await readFile(file, "utf8")).hooks).toBeUndefined();
  }
});

test("unrecognized sidecars block refresh and survive uninstall without mutation", async () => {
  for (const target of ["claude", "copilot"] as const) {
    for (const receipt of [
      '{"notes":"unrelated user data"}\n',
      '{"version":99,"before":null,"installed":{"command":"managed"}}\n',
      '{"before":{"command":42},"installed":{"command":"managed"}}\n',
      "not JSON\n",
    ]) {
      const options = await fixture();
      const file = path.join(
        options.root,
        target === "claude" ? ".mcp.json" : ".github/mcp.json",
      );
      await mkdir(path.dirname(file), { recursive: true });
      const original =
        '{ "mcpServers": { "ast-mcp": { "command": "original" } } }\n';
      await writeFile(file, original);
      const sidecar = file + ".ast-mcp.json";
      await writeFile(sidecar, receipt);
      if (process.platform !== "win32") await chmod(sidecar, 0o640);
      const mode = (await stat(sidecar)).mode;
      const installation = { ...options, targets: [target] };
      await expect(update(installation)).rejects.toThrow(
        "not owned by ast-mcp",
      );
      expect(await readFile(file, "utf8")).toBe(original);
      expect(await readFile(sidecar, "utf8")).toBe(receipt);
      expect((await stat(sidecar)).mode).toBe(mode);
      await uninstall(installation);
      expect(await readFile(file, "utf8")).toBe(original);
      expect(await readFile(sidecar, "utf8")).toBe(receipt);
      expect((await stat(sidecar)).mode).toBe(mode);
    }
  }
});
test("VS Code sidecar collision is rejected before Copilot configuration changes", async () => {
  const options = await fixture();
  const primary = path.join(options.root, ".github/mcp.json");
  const vscode = path.join(options.root, ".vscode/mcp.json");
  await mkdir(path.dirname(primary), { recursive: true });
  await mkdir(path.dirname(vscode), { recursive: true });
  const original = '{"mcpServers":{"ast-mcp":{"command":"original"}}}\n';
  await writeFile(primary, original);
  await writeFile(vscode + ".ast-mcp.json", '{"user":"keep"}\n');
  await expect(update({ ...options, targets: ["copilot"] })).rejects.toThrow(
    "not owned by ast-mcp",
  );
  expect(await readFile(primary, "utf8")).toBe(original);
  expect(await readFile(vscode + ".ast-mcp.json", "utf8")).toBe(
    '{"user":"keep"}\n',
  );
});
