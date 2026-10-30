import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runCli } from "../../src/cli";
import { parseDoctorArguments, runDoctorCli } from "../../src/cli/doctor";

const created: string[] = [];
afterEach(async () => {
  await Promise.all(
    created.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("doctor defaults to host-neutral discovery and rejects invalid arguments before work", async () => {
  expect(parseDoctorArguments([], "/example")).toEqual({
    root: "/example",
    scope: "local",
    target: "auto",
  });
  expect(
    parseDoctorArguments(
      ["--target=codex", "--scope=global", "--profile=safe"],
      "/example",
    ),
  ).toMatchObject({ target: "codex", scope: "global", profile: "safe" });
  for (const args of [
    ["--unknown"],
    ["--target"],
    ["--scope=all"],
    ["--profile=../secret"],
    ["--target=claude", "--profile=safe"],
  ])
    expect(() => parseDoctorArguments(args)).toThrow();
  let received: string[] = [];
  expect(
    await runCli(["doctor", "--target", "claude", "--output=json"], {
      config: async () => {},
      hook: async () => 0,
      installer: async () => {},
      mcp: async () => {},
      doctor: async (args) => {
        received = args;
        return 0;
      },
    }),
  ).toBe(0);
  expect(received).toEqual(["--target", "claude", "--output", "json"]);
});

test("doctor keeps registry failures reportable and renders every supported output format", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-doctor-"));
  created.push(root);
  await mkdir(path.join(root, ".claude"), { recursive: true });
  await writeFile(path.join(root, "ast-mcp.toml"), "invalid [");
  let requests = 0;
  const fetcher = (async () => {
    requests++;
    throw new Error("private exception must not leak");
  }) as unknown as typeof fetch;
  for (const format of ["human", "json", "yaml", "toml"]) {
    let output = "";
    expect(
      await runDoctorCli(
        ["--root", root, "--target", "claude", "--output", format],
        {
          home: root,
          env: {},
          fetch: fetcher,
          write: (value) => {
            output += value;
          },
        },
      ),
    ).toBe(0);
    expect(output).toContain("unavailable");
    expect(output).not.toContain("private exception");
    expect(output).not.toContain("Codex Desktop");
    if (format === "json") {
      const report = JSON.parse(output);
      expect(report.host.requestedTarget).toBe("claude");
      expect(report.host.installedPackages.connectedServerVersion).toBe(
        "unknown",
      );
      expect(report.versionCheck.status).toBe("unavailable");
    }
  }
  expect(requests).toBe(4);
});

test("doctor explicit root uses its policy instead of the Claude launch project", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-doctor-root-"));
  created.push(base);
  const launch = path.join(base, "launch");
  const selected = path.join(base, "selected");
  for (const root of [launch, selected])
    await mkdir(path.join(root, ".git"), { recursive: true });
  await writeFile(
    path.join(launch, "ast-mcp.toml"),
    'version = 2\n[safety]\nfilesystem = "unrestricted"\n',
  );
  await writeFile(
    path.join(selected, "ast-mcp.toml"),
    'version = 2\n[safety]\nfilesystem = "restricted"\n',
  );
  const previous = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = launch;
  try {
    let output = "";
    await runDoctorCli(
      ["--root", selected, "--target", "claude", "--output", "json"],
      {
        home: base,
        env: {},
        fetch: (async () => {
          throw new Error("offline");
        }) as unknown as typeof fetch,
        write: (value) => {
          output += value;
        },
      },
    );
    expect(JSON.parse(output).configuration).toMatchObject({
      healthy: true,
      filesystem: "restricted",
      filesystemSource: "project",
    });
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = previous;
  }
});
