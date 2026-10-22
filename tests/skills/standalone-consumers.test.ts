import { expect, spyOn, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import * as runtimeHooks from "../../src/hooks/managed";
import * as runtimeBinaries from "../../src/runtime/binary-resolution";
import * as exportedBinaries from "../../templates/skills/ast-mcp/scripts/binary-resolution";
import * as exportedHooks from "../../templates/skills/ast-mcp/scripts/managed-hook";

for (const [surface, binaries] of [
  ["runtime", runtimeBinaries],
  ["exported skill", exportedBinaries],
] as const) {
  test(`${surface} resolves installed aliases and preserves Windows command safety`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-export-alias-"));
    const previous = process.env.PATHEXT;
    try {
      const bin = path.join(root, "node_modules/.bin");
      await mkdir(bin, { recursive: true });
      const alias = path.join(bin, "ast-mcp");
      await writeFile(alias, "#!/bin/sh\nexit 0\n");
      if (process.platform !== "win32") {
        await chmod(alias, 0o755);
        expect(binaries.resolveLocalBinaryAlias("ast-mcp", root, "linux")).toBe(
          alias,
        );
        expect(
          binaries.resolveGlobalBinaryAlias("ast-mcp", {
            globalBinDirectories: ["", bin],
            platform: "linux",
          }),
        ).toBe(alias);
        expect(binaries.isExecutable(root, "linux")).toBeFalse();
        expect(
          binaries.isExecutable(path.join(root, "missing"), "linux"),
        ).toBeFalse();
        await chmod(alias, 0o644);
        expect(
          binaries.resolveLocalBinaryAlias("ast-mcp", root, "linux"),
        ).toBeUndefined();
      }
      expect(binaries.isExecutable(alias, "win32")).toBeTrue();
      process.env.PATHEXT = "EXE;.CMD;.CMD";
      const cmd = path.join(bin, "ast-mcp.CMD");
      await writeFile(cmd, "@exit /b 0\r\n");
      expect(binaries.executableNames("ast-mcp", "win32")).toEqual([
        "ast-mcp.EXE",
        "ast-mcp.CMD",
        "ast-mcp",
      ]);
      expect(binaries.resolveLocalBinaryAlias("ast-mcp", root, "win32")).toBe(
        cmd,
      );
      const invocation = binaries.commandForPlatform(
        "C:\\Program Files\\ast-mcp.CMD",
        ["mcp", "folder with spaces"],
        "win32",
        "cmd.exe",
      );
      expect(invocation).toEqual({
        command: "cmd.exe",
        args: [
          "/d",
          "/v:off",
          "/s",
          "/c",
          'call "C:\\Program Files\\ast-mcp.CMD" mcp "folder with spaces"',
        ],
        windowsVerbatimArguments: true,
      });
      for (const argument of [
        'bad"quote',
        "%USERPROFILE%",
        "!expand!",
        "new\nline",
        "bad^escape",
        "nul\0byte",
      ])
        expect(() =>
          binaries.commandForPlatform("ast-mcp.cmd", [argument], "win32"),
        ).toThrow("cannot contain");
      expect(binaries.commandForPlatform(alias, ["mcp"], "linux")).toEqual({
        command: alias,
        args: ["mcp"],
      });
    } finally {
      if (previous === undefined) delete process.env.PATHEXT;
      else process.env.PATHEXT = previous;
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`${surface} resolves known aliases before probing managers and retains manager fallback`, async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-known-alias-"));
    const name = "ast-mcp-fixture";
    const extension = process.platform === "win32" ? ".CMD" : "";
    const known = path.join(home, ".bun/bin", name + extension);
    const manager = path.join(home, "manager", name + extension);
    const previous = process.env.PATHEXT;
    const spawn = spyOn(Bun, "spawnSync").mockImplementation(() => {
      throw new Error("manager must not run for a known alias");
    });
    try {
      process.env.PATHEXT = ".CMD";
      for (const alias of [known, manager]) {
        await mkdir(path.dirname(alias), { recursive: true });
        await writeFile(alias, "#!/bin/sh\nexit 0\n");
        await chmod(alias, 0o755);
      }
      expect(binaries.resolveGlobalBinaryAlias(name, { home })).toBe(known);
      expect(spawn).not.toHaveBeenCalled();
      await rm(known);
      spawn.mockImplementation(((args: string[]) => ({
        exitCode: args.join(" ") === "bun pm bin -g" ? 0 : 1,
        stdout: Buffer.from(path.dirname(manager)),
      })) as never);
      expect(binaries.resolveGlobalBinaryAlias(name, { home })).toBe(manager);
      expect(spawn).toHaveBeenCalledTimes(5);
    } finally {
      spawn.mockRestore();
      if (previous === undefined) delete process.env.PATHEXT;
      else process.env.PATHEXT = previous;
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`${surface} bounds stalled manager discovery and continues after timeout`, () => {
    const execute = Bun.spawnSync;
    let calls = 0;
    const base = path.resolve(os.tmpdir(), "ast-mcp-stalled-manager");
    const spawn = spyOn(Bun, "spawnSync").mockImplementation(((
      args: string[],
      options: NonNullable<Parameters<typeof Bun.spawnSync>[1]>,
    ) => {
      calls++;
      expect(options).toMatchObject({
        stdin: "ignore",
        timeout: 1000,
        killSignal: "SIGKILL",
        maxBuffer: 65536,
      });
      if (calls === 1)
        return execute(
          [process.execPath, "-e", "setInterval(() => {}, 1000)"],
          options,
        );
      return {
        exitCode: args[0] === "pnpm" ? 0 : 1,
        stdout: Buffer.from(base),
      };
    }) as never);
    try {
      const started = performance.now();
      expect(
        binaries.globalBinDirectories(
          "ast-mcp-fixture",
          process.platform,
          base,
        ),
      ).toContain(base);
      expect(calls).toBe(5);
      expect(performance.now() - started).toBeLessThan(5000);
    } finally {
      spawn.mockRestore();
    }
  });

  test(`${surface} discovers manager-specific global installations without installing packages`, () => {
    const previous = {
      BUN_INSTALL: process.env.BUN_INSTALL,
      PNPM_HOME: process.env.PNPM_HOME,
      npm_config_prefix: process.env.npm_config_prefix,
    };
    const base = path.resolve(os.tmpdir(), "ast-mcp-manager-contract");
    const responses: Record<string, string> = {
      "yarn bin ast-mcp": path.join(base, "yarn-bin/ast-mcp"),
      "bun pm bin -g": path.join(base, "bun-global"),
      "pnpm bin -g": path.join(base, "pnpm-global"),
      "yarn global bin": path.join(base, "yarn-global"),
      "npm prefix -g": path.join(base, "npm-global"),
    };
    const spawn = spyOn(Bun, "spawnSync").mockImplementation(((
      args: string[],
    ) => ({
      exitCode: responses[args.join(" ")] === undefined ? 1 : 0,
      stdout: Buffer.from(responses[args.join(" ")] ?? ""),
    })) as never);
    process.env.BUN_INSTALL = path.join(base, "bun-env");
    process.env.PNPM_HOME = path.join(base, "pnpm-env");
    process.env.npm_config_prefix = path.join(base, "npm-env");
    try {
      const directories = binaries.globalBinDirectories(
        "ast-mcp",
        "linux",
        base,
      );
      for (const relative of [
        "yarn-bin",
        "bun-env/bin",
        "pnpm-env",
        "npm-env/bin",
        ".bun/bin",
        ".bun/install/global/node_modules/.bin",
        "bun-global",
        "pnpm-global",
        "yarn-global",
        "npm-global/bin",
      ])
        expect(directories).toContain(path.join(base, relative));
      expect(binaries.globalBinDirectories("ast-mcp", "win32", base)).toContain(
        path.join(base, "npm-global"),
      );
      expect(
        binaries.resolveGlobalBinaryAlias("missing", {
          home: base,
          platform: "linux",
        }),
      ).toBeUndefined();
      spawn.mockImplementation(() => {
        throw new Error("manager unavailable");
      });
      expect(binaries.globalBinDirectories("ast-mcp", "linux", base)).toContain(
        path.join(base, ".bun/bin"),
      );
    } finally {
      spawn.mockRestore();
      for (const [name, value] of Object.entries(previous))
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
  });
}

for (const [surface, hooks] of [
  ["runtime", runtimeHooks],
  ["exported skill", exportedHooks],
] as const) {
  test(`${surface} recognizes managed hook entries without claiming unrelated commands`, () => {
    const command = '"/opt/AST MCP/ast-mcp.js" hook';
    expect(hooks.managedAstMcpHookEntry(command)).toBe(
      "/opt/AST MCP/ast-mcp.js",
    );
    expect(
      hooks.managedAstMcpHookEntry('bun run "/opt/AST MCP/ast-mcp.ts" hook'),
    ).toBe("/opt/AST MCP/ast-mcp.ts");
    expect(
      hooks.managedAstMcpHookEntry(
        '"C:\\\\bun.exe" "C:\\\\tools\\\\ast-mcp.cmd" hook',
      ),
    ).toBe("C:\\tools\\ast-mcp.cmd");
    for (const value of [
      undefined,
      123,
      "123 hook",
      "echo unrelated hook",
      "ast-mcp update",
    ])
      expect(hooks.managedAstMcpHookEntry(value)).toBeUndefined();
    expect(
      hooks.isManagedHook({ type: "command", command }, "preToolUse", command),
    ).toBeTrue();
    expect(
      hooks.isManagedHook(
        { type: "command", command: "ast-mcp hook" },
        "preToolUse",
        command,
      ),
    ).toBeTrue();
    expect(
      hooks.isManagedHook(
        {
          hooks: [
            null,
            "bad",
            { type: "command", command: "bun ast-mcp hook" },
          ],
        },
        "PreToolUse",
        command,
      ),
    ).toBeTrue();
    for (const value of [
      null,
      "invalid",
      { type: "prompt", command },
      { hooks: [{ type: "command", command: "other hook" }] },
      {},
    ])
      expect(hooks.isManagedHook(value, "PreToolUse", command)).toBeFalse();
    expect(
      hooks.isManagedHook({ type: "prompt", command }, "preToolUse", command),
    ).toBeFalse();
  });
}
