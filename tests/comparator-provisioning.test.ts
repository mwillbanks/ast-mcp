import { expect, test } from "bun:test";
import {
  astBroProvisionCommand,
  graphifyProvisionCommand,
  provisionIntelligenceComparators,
  runComparatorCommand,
} from "../scripts/provision-intelligence-comparators.ts";

test("uses the pinned npm ast-bro package only on supported macOS ARM64", () => {
  expect(astBroProvisionCommand("darwin", "arm64")).toEqual([
    "bun",
    "add",
    "--global",
    "@ast-bro/cli@4.2.0",
  ]);
});

test("uses the pinned Cargo crate on Linux, Windows, and Intel macOS", () => {
  for (const [platform, arch] of [
    ["linux", "x64"],
    ["win32", "x64"],
    ["darwin", "x64"],
  ] as const)
    expect(astBroProvisionCommand(platform, arch)).toEqual([
      "cargo",
      "install",
      "ast-bro",
      "--version",
      "4.2.0",
      "--locked",
      "--force",
    ]);
});

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

test("provisions and verifies both pinned comparators", async () => {
  const commands: string[][] = [];
  const result = await provisionIntelligenceComparators("darwin", "arm64", {
    findExecutable: (name) => (name === "python" ? "/python" : null),
    run: async (command) => {
      commands.push(command);
      if (command[0] === "ast-bro") return "ast-bro 4.2.0";
      if (command[0] === "graphify") return "graphify 0.9.53";
      return "";
    },
  });
  expect(result).toEqual({
    astBro: "ast-bro 4.2.0",
    graphify: "graphify 0.9.53",
  });
  expect(commands).toEqual([
    ["bun", "add", "--global", "@ast-bro/cli@4.2.0"],
    [
      "/python",
      "-m",
      "pip",
      "install",
      "--disable-pip-version-check",
      "graphifyy==0.9.53",
    ],
    ["ast-bro", "--version"],
    ["graphify", "--version"],
  ]);
});

test("rejects unsupported hosts and missing Python", async () => {
  await expect(
    provisionIntelligenceComparators("aix", "ppc64"),
  ).rejects.toThrow("Unsupported comparator platform: aix-ppc64");
  await expect(
    provisionIntelligenceComparators("linux", "x64", {
      findExecutable: () => null,
    }),
  ).rejects.toThrow("Python is required to provision graphify");
});

test("rejects comparator version drift", async () => {
  const findExecutable = () => "/python";
  await expect(
    provisionIntelligenceComparators("linux", "x64", {
      findExecutable,
      run: async (command) => (command[0] === "ast-bro" ? "ast-bro 4.1.0" : ""),
    }),
  ).rejects.toThrow("Expected ast-bro 4.2.0");
  for (const graphify of [
    "graphify 0.9.52",
    "prefix graphify 0.9.53",
    "graphify 0.9.53 suffix",
  ]) {
    await expect(
      provisionIntelligenceComparators("linux", "x64", {
        findExecutable,
        run: async (command) => {
          if (command[0] === "ast-bro") return "ast-bro 4.2.0";
          if (command[0] === "graphify") return graphify;
          return "";
        },
      }),
    ).rejects.toThrow("Expected graphify 0.9.53");
  }
});
