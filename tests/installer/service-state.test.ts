import { afterEach, expect, test } from "bun:test";
import { renameSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createServicePlan,
  installService,
  removeService,
} from "../../src/installer/service";
import {
  captureServiceState,
  queryServiceCommand,
  launchdTarget,
  type ServiceStateQuery,
} from "../../src/installer/service-state";
import {
  assertInstallerRestored,
  withInstallerFileTransaction,
  writeInstallerFile,
} from "../../src/installer/transaction";
import { httpEndpoint } from "../../src/installer/transport";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const reply = (stdout: string, exitCode = 0, stderr = "") => ({
  stdout,
  exitCode,
  stderr,
});
const linuxQuery =
  (enabled: boolean, active: boolean): ServiceStateQuery =>
  async () =>
    reply(
      "LoadState=loaded\nActiveState=" +
        (active ? "active" : "inactive") +
        "\nUnitFileState=" +
        (enabled ? "enabled" : "disabled") +
        "\n",
    );
const absentQuery: ServiceStateQuery = async () =>
  reply("LoadState=not-found\nActiveState=inactive\nUnitFileState=\n");
const darwinQuery =
  (loaded: boolean, disabled = false, running = true): ServiceStateQuery =>
  async (command) =>
    command[1] === "print-disabled"
      ? reply(
          'disabled services = {\n"' +
            launchdTarget("ast-mcp").label +
            '" => ' +
            disabled +
            "\n}",
        )
      : loaded
        ? reply("state = " + (running ? "running" : "waiting"))
        : reply("", 113, "Could not find service");
async function fixture(
  platform: "linux" | "darwin",
  stateQuery: ServiceStateQuery,
  existed = true,
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ast-service-state-"));
  roots.push(root);
  const commands: string[][] = [];
  const options = {
    root,
    home: root,
    platform,
    scope: "global" as const,
    cliEntry: process.execPath,
    endpoint: httpEndpoint("127.0.0.1", 4567),
    stateQuery,
    runner: async (command: string[]) => {
      commands.push(command);
    },
  };
  const plan = createServicePlan(options);
  if (existed) {
    await mkdir(path.dirname(plan.file), { recursive: true });
    await writeFile(plan.file, "original");
  }
  return { root, options, plan, commands };
}

test("Linux snapshots separate enabled state from runtime state", async () => {
  for (const enabled of [false, true])
    for (const active of [false, true])
      expect(
        await captureServiceState(
          "linux",
          "ast-mcp",
          linuxQuery(enabled, active),
        ),
      ).toEqual({ platform: "linux", loaded: true, enabled, active });
  expect(await captureServiceState("linux", "ast-mcp", absentQuery)).toEqual({
    platform: "linux",
    loaded: false,
    enabled: false,
    active: false,
  });
});
test("unknown Linux manager states are rejected rather than treated as absent", async () => {
  for (const response of [
    reply("", 1),
    reply(""),
    reply("LoadState=not-found\nActiveState=inactive"),
    reply("LoadState=not-found\nLoadState=not-found\nActiveState=inactive"),
    reply(
      "LoadState=loaded\nActiveState=active\nUnitFileState=enabled=unexpected",
    ),
    reply("LoadState=masked\nActiveState=inactive\nUnitFileState=masked"),
    reply("LoadState=loaded\nActiveState=activating\nUnitFileState=enabled"),
    reply("LoadState=loaded\nActiveState=inactive\nUnitFileState=static"),
  ])
    await expect(
      captureServiceState("linux", "ast-mcp", async () => response),
    ).rejects.toThrow("Cannot safely restore");
});
test("Darwin snapshots distinguish running, unloaded, disabled and unsupported stopped jobs", async () => {
  expect(
    await captureServiceState("darwin", "ast-mcp", darwinQuery(true)),
  ).toEqual({
    platform: "darwin",
    loaded: true,
    disabled: false,
    running: true,
  });
  for (const disabled of [false, true])
    expect(
      await captureServiceState(
        "darwin",
        "ast-mcp",
        darwinQuery(false, disabled),
      ),
    ).toEqual({ platform: "darwin", loaded: false, disabled, running: false });
  for (const query of [
    darwinQuery(true, false, false),
    darwinQuery(true, true),
    async () => reply("", 1),
    async () => reply("unrecognized"),
  ])
    await expect(
      captureServiceState("darwin", "ast-mcp", query),
    ).rejects.toThrow("Cannot safely restore");
  await expect(
    captureServiceState("darwin", "ast-mcp", async (command) =>
      command[1] === "print-disabled"
        ? reply("disabled services = {}")
        : reply("", 1, "permission denied"),
    ),
  ).rejects.toThrow("Cannot safely restore");
});
test("Linux rollback restores each enabled/active combination without enable --now", async () => {
  for (const enabled of [false, true])
    for (const active of [false, true])
      for (const operation of [installService, removeService]) {
        const { options, plan, commands } = await fixture(
          "linux",
          linuxQuery(enabled, active),
        );
        await expect(
          withInstallerFileTransaction(async () => {
            await operation(options);
            commands.length = 0;
            throw new Error("later failure");
          }),
        ).rejects.toThrow("later failure");
        expect(await readFile(plan.file, "utf8")).toBe("original");
        const unit = plan.id + ".service";
        expect(commands).toEqual([
          ["systemctl", "--user", "stop", unit],
          ["systemctl", "--user", "daemon-reload"],
          ["systemctl", "--user", enabled ? "enable" : "disable", unit],
          ...(active ? [["systemctl", "--user", "start", unit]] : []),
        ]);
      }
});
test("Darwin rollback never enables unloaded disabled jobs or invents loaded jobs from existing files", async () => {
  for (const existed of [false, true])
    for (const disabled of [false, true]) {
      const { options, plan, commands } = await fixture(
        "darwin",
        darwinQuery(false, disabled),
        existed,
      );
      await expect(
        withInstallerFileTransaction(async () => {
          await installService(options);
          commands.length = 0;
          throw new Error("later failure");
        }),
      ).rejects.toThrow("later failure");
      expect(commands).toEqual(plan.removeCommands);
      if (existed) expect(await readFile(plan.file, "utf8")).toBe("original");
    }
});
test("Darwin loaded stopped jobs and unknown queries fail before file or command mutation", async () => {
  for (const stateQuery of [
    darwinQuery(true, false, false),
    async () => {
      throw new Error("query unavailable");
    },
  ]) {
    const { options, commands, plan } = await fixture("darwin", stateQuery);
    await expect(installService(options)).rejects.toThrow();
    expect(commands).toEqual([]);
    expect(await readFile(plan.file, "utf8")).toBe("original");
  }
  const { options, commands } = await fixture("linux", absentQuery);
  await expect(
    // @ts-expect-error Exercise the JavaScript runtime guard for an invalid runner/query pair.
    installService({ ...options, stateQuery: undefined }),
  ).rejects.toThrow("requires a read-only");
  expect(commands).toEqual([]);
});
test("unrelated rollback conflicts do not suppress safe service compensation", async () => {
  for (const existed of [false, true]) {
    const { options, commands, plan, root } = await fixture(
      "linux",
      existed ? linuxQuery(false, false) : absentQuery,
      existed,
    );
    const host = path.join(root, "host.json");
    await writeFile(host, "original host");
    await expect(
      withInstallerFileTransaction(async () => {
        await installService(options);
        commands.length = 0;
        await writeInstallerFile(host, "installed host");
        await writeFile(host, "user host edit");
        throw new Error("later failure");
      }),
    ).rejects.toThrow("rollback was incomplete");
    expect(commands.some((command) => command.includes("stop"))).toBe(true);
    expect(commands.some((command) => command.includes("start"))).toBe(false);
    expect(await readFile(host, "utf8")).toBe("user host edit");
    if (existed) expect(await readFile(plan.file, "utf8")).toBe("original");
    else
      await expect(readFile(plan.file)).rejects.toMatchObject({
        code: "ENOENT",
      });
  }
});
test("a service-file conflict refuses its compensation while unrelated callbacks still run", async () => {
  const { options, commands, plan } = await fixture(
    "linux",
    linuxQuery(false, false),
  );
  await expect(
    withInstallerFileTransaction(async () => {
      await installService(options);
      commands.length = 0;
      await writeFile(plan.file, "user plan");
      throw new Error("later failure");
    }),
  ).rejects.toThrow("rollback was incomplete");
  expect(commands).toEqual([]);
  expect(await readFile(plan.file, "utf8")).toBe("user plan");
});
test("read-only state subprocesses capture outcomes and terminate within the deadline", async () => {
  expect(
    await queryServiceCommand([
      process.execPath,
      "-e",
      'process.stdout.write("state");process.stderr.write("diagnostic");process.exit(3)',
    ]),
  ).toEqual(reply("state", 3, "diagnostic"));
  await expect(
    queryServiceCommand(
      [process.execPath, "-e", "setInterval(()=>{},1000)"],
      50,
    ),
  ).rejects.toThrow("timed out");
});
test.skipIf(process.platform === "win32")(
  "read-only state subprocess signal termination is not absence",
  async () => {
    await expect(
      queryServiceCommand([
        process.execPath,
        "-e",
        'process.kill(process.pid,"SIGTERM")',
      ]),
    ).rejects.toThrow("interrupted");
  },
);

test("missing Linux units require recognized output and an expected exit code", async () => {
  const output = "LoadState=not-found\nActiveState=inactive\nUnitFileState=\n";
  expect(
    await captureServiceState("linux", "ast-mcp", async () => reply(output, 4)),
  ).toEqual({
    platform: "linux",
    loaded: false,
    enabled: false,
    active: false,
  });
  for (const response of [
    reply(output, 1),
    reply("", 4),
    reply(
      "LoadState=not-found\nActiveState=inactive\nUnitFileState=enabled",
      4,
    ),
  ])
    await expect(
      captureServiceState("linux", "ast-mcp", async () => response),
    ).rejects.toThrow("Cannot safely restore");
});
test("Darwin override formats are parsed strictly and absence requires code113", async () => {
  for (const value of ["disabled", "enabled", "true", "false"]) {
    const state = await captureServiceState(
      "darwin",
      "ast-mcp",
      async (command) =>
        command[1] === "print-disabled"
          ? reply(
              'disabled services = {\n"other" => enabled\n"com.mwillbanks.ast-mcp" => ' +
                value +
                "\n}",
            )
          : reply("", 113, "Could not find specified service"),
    );
    expect(state).toMatchObject({
      loaded: false,
      disabled: ["true", "disabled"].includes(value),
    });
  }
  for (const output of [
    'disabled services = { "com.mwillbanks.ast-mcp" => unknown }',
    'disabled services = { "com.mwillbanks.ast-mcp" => true "com.mwillbanks.ast-mcp" => false }',
  ])
    await expect(
      captureServiceState("darwin", "ast-mcp", async () => reply(output)),
    ).rejects.toThrow("Cannot safely restore");
  await expect(
    captureServiceState("darwin", "ast-mcp", async (command) =>
      command[1] === "print-disabled"
        ? reply("disabled services = {}")
        : reply("", 1, "Could not find service"),
    ),
  ).rejects.toThrow("Cannot safely restore");
});
test("fresh-unit rollback verifies manager absence when stop or disable reports a missing unit", async () => {
  const { options, commands, plan } = await fixture(
    "linux",
    absentQuery,
    false,
  );
  let failed = false;
  options.runner = async (command) => {
    commands.push(command);
    if (!failed && command.includes("daemon-reload")) {
      failed = true;
      throw new Error("initial reload failed");
    }
    if (command.includes("stop") || command.includes("disable"))
      throw new Error("unit not loaded");
  };
  await expect(installService(options)).rejects.toThrow(
    "initial reload failed",
  );
  expect(
    commands.filter((command) => command.includes("disable")),
  ).toHaveLength(1);
  await expect(readFile(plan.file)).rejects.toMatchObject({ code: "ENOENT" });
});
test("unknown manager errors during compensation remain recovery failures", async () => {
  const { options, commands } = await fixture("linux", absentQuery, false);
  let snapshot = true;
  options.stateQuery = async (command) => {
    if (snapshot) {
      snapshot = false;
      return absentQuery(command);
    }
    throw new Error("manager unavailable");
  };
  options.runner = async (command) => {
    commands.push(command);
    throw new Error("manager failed");
  };
  await expect(installService(options)).rejects.toThrow(
    "rollback was incomplete",
  );
});
test("failed service-file restoration blocks restart even when installed bytes remain unchanged", async () => {
  const { options, commands, plan } = await fixture(
    "linux",
    linuxQuery(true, true),
  );
  let rollback = false;
  await expect(
    withInstallerFileTransaction(
      async () => {
        await installService(options);
        commands.length = 0;
        rollback = true;
        throw new Error("later failure");
      },
      {
        rename: (from, to) => {
          if (rollback && String(to) === plan.file)
            throw new Error("restore failed");
          renameSync(from, to);
        },
      },
    ),
  ).rejects.toThrow("rollback was incomplete");
  expect(commands).toEqual([]);
  expect(await readFile(plan.file, "utf8")).toBe(plan.content);
});
test("loaded services without an original managed file fail before commands", async () => {
  for (const platform of ["linux", "darwin"] as const) {
    const { options, commands } = await fixture(
      platform,
      platform === "linux" ? linuxQuery(true, true) : darwinQuery(true),
      false,
    );
    await expect(installService(options)).rejects.toThrow(
      "without its original",
    );
    expect(commands).toEqual([]);
  }
});
test("restored-dependency assertions require a captured original transaction state", async () => {
  expect(() => assertInstallerRestored("missing")).toThrow(
    "active transaction",
  );
  await expect(
    withInstallerFileTransaction(async () => {
      assertInstallerRestored("missing");
    }),
  ).rejects.toThrow("original file state");
});
test("state subprocess spawn and excessive output failures cannot imply service absence", async () => {
  await expect(
    queryServiceCommand(["/ast-mcp-nonexistent-query-executable"]),
  ).rejects.toThrow();
  await expect(
    queryServiceCommand([
      process.execPath,
      "-e",
      'process.stdout.write("x".repeat(17*1024*1024));setInterval(()=>{},1000)',
    ]),
  ).rejects.toThrow("output exceeded");
});

test("Darwin compensation verifies absence instead of suppressing bootout errors", async () => {
  for (const loaded of [false, true]) {
    const { options, commands } = await fixture(
      "darwin",
      darwinQuery(loaded),
      loaded,
    );
    await expect(
      withInstallerFileTransaction(async () => {
        await installService(options);
        commands.length = 0;
        options.runner = async (command) => {
          commands.push(command);
          throw new Error("bootout failed");
        };
        throw new Error("later failure");
      }),
    ).rejects.toThrow(loaded ? "rollback was incomplete" : "later failure");
    expect(commands).toHaveLength(1);
  }
});
test("compensation revalidates its original file before every manager action", async () => {
  const { options, commands, plan } = await fixture(
    "linux",
    linuxQuery(true, true),
  );
  await expect(
    withInstallerFileTransaction(async () => {
      await installService(options);
      commands.length = 0;
      options.runner = async (command) => {
        commands.push(command);
        await writeFile(plan.file, "user changed after stop");
      };
      throw new Error("later failure");
    }),
  ).rejects.toThrow("rollback was incomplete");
  expect(commands).toHaveLength(1);
  expect(commands[0]).toContain("stop");
  expect(await readFile(plan.file, "utf8")).toBe("user changed after stop");
});

test("verified manager absence cannot suppress a concurrent service-file conflict", async () => {
  const { options, plan } = await fixture("linux", absentQuery, false);
  await expect(
    withInstallerFileTransaction(async () => {
      await installService(options);
      options.runner = async (command) => {
        if (command.includes("disable")) {
          await writeFile(plan.file, "concurrent user plan");
          throw new Error("disable failed");
        }
      };
      throw new Error("later failure");
    }),
  ).rejects.toThrow("rollback was incomplete");
  expect(await readFile(plan.file, "utf8")).toBe("concurrent user plan");
});
