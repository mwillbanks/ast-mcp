import { expect, test } from "bun:test";

import {
  comparatorCommandTimeout,
  graphifyProvisionCommand,
  provisionGraphifyComparator,
  runComparatorCommand,
} from "../scripts/provision-intelligence-comparators.ts";

test("pins the graphifyy distribution through the selected Python interpreter", () => {
  expect(graphifyProvisionCommand("python3")).toEqual([
    "python3",
    "-m",
    "pip",
    "install",
    "--disable-pip-version-check",
    "graphifyy==0.9.53",
  ]);
});

test("bounds optional installation and version checks", () => {
  expect(comparatorCommandTimeout(graphifyProvisionCommand("python3"))).toBe(
    300_000,
  );
  expect(comparatorCommandTimeout(["graphify", "--version"])).toBe(30_000);
});

test("reports the project timeout instead of an ambiguous SIGKILL exit", async () => {
  await expect(
    runComparatorCommand(
      [process.execPath, "-e", "setInterval(() => {}, 1_000)"],
      75,
    ),
  ).rejects.toThrow("timed out after 75ms");
});

test.skipIf(process.platform === "win32")(
  "bounds POSIX pipe drains after a command leaves a descendant running",
  async () => {
    const script = `const descendant = Bun.spawn([${JSON.stringify(process.execPath)}, "-e", "setTimeout(() => process.exit(0), 3_000)"], { stdin: "ignore", stderr: "inherit", stdout: "inherit" }); descendant.unref(); process.exit(0);`;
    const started = performance.now();
    await expect(
      runComparatorCommand([process.execPath, "-e", script], 75),
    ).rejects.toThrow("timed out after 75ms");
    expect(performance.now() - started).toBeLessThan(2_500);
  },
);

test("runs comparator commands and reports subprocess failures", async () => {
  expect(await runComparatorCommand([process.execPath, "--version"])).toBe(
    Bun.version,
  );
  await expect(
    runComparatorCommand([
      process.execPath,
      "-e",
      'console.error("fixture failure"); process.exit(7)',
    ]),
  ).rejects.toThrow("failed with exit 7: fixture failure");
});

test("provisions and verifies pinned Graphify only when absent", async () => {
  const commands: string[][] = [];
  const result = await provisionGraphifyComparator("darwin", "arm64", {
    findExecutable: (name) => (name === "python" ? "/python" : null),
    run: async (command) => {
      commands.push(command);
      if (command[0] === "graphify") return "graphify 0.9.53";
      return "";
    },
  });
  expect(result).toEqual({ graphify: "graphify 0.9.53" });
  expect(commands).toEqual([
    [
      "/python",
      "-m",
      "pip",
      "install",
      "--disable-pip-version-check",
      "graphifyy==0.9.53",
    ],
    ["graphify", "--version"],
  ]);
});

test("reuses an exact Graphify version without requiring Python", async () => {
  const commands: string[][] = [];
  const result = await provisionGraphifyComparator("linux", "x64", {
    findExecutable: (name) => (name === "graphify" ? "/graphify" : null),
    run: async (command) => {
      commands.push(command);
      return "graphify 0.9.53";
    },
  });
  expect(result).toEqual({ graphify: "graphify 0.9.53" });
  expect(commands).toEqual([["graphify", "--version"]]);
});

test("reinstalls a stale Graphify executable before accepting its version", async () => {
  const commands: string[][] = [];
  let installed = false;
  const result = await provisionGraphifyComparator("linux", "x64", {
    findExecutable: (name) =>
      name === "python" ? "/python" : name === "graphify" ? "/graphify" : null,
    run: async (command) => {
      commands.push(command);
      if (command[0] !== "graphify") {
        installed = true;
        return "";
      }
      return installed ? "graphify 0.9.53" : "graphify 0.9.52";
    },
  });
  expect(result).toEqual({ graphify: "graphify 0.9.53" });
  expect(commands).toEqual([
    ["graphify", "--version"],
    graphifyProvisionCommand("/python"),
    ["graphify", "--version"],
  ]);
});

test("rejects unsupported hosts and missing Python", async () => {
  await expect(provisionGraphifyComparator("aix", "ppc64")).rejects.toThrow(
    "Unsupported comparator platform: aix-ppc64",
  );
  await expect(
    provisionGraphifyComparator("linux", "x64", {
      findExecutable: () => null,
    }),
  ).rejects.toThrow("Python is required to provision graphify");
});

test("rejects Graphify version drift after reinstalling", async () => {
  const findExecutable = () => "/python";
  for (const graphify of [
    "graphify 0.9.52",
    "prefix graphify 0.9.53",
    "graphify 0.9.53 suffix",
  ]) {
    await expect(
      provisionGraphifyComparator("linux", "x64", {
        findExecutable,
        run: async (command) => {
          if (command[0] === "graphify") return graphify;
          return "";
        },
      }),
    ).rejects.toThrow("Expected graphify 0.9.53");
  }
});
