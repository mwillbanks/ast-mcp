import { afterEach, expect, spyOn, test } from "bun:test";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { manualHttpLaunchCommand, runInstallerCli } from "../../src/installer";
import { httpEndpoint } from "../../src/installer/transport";

test("manual Windows HTTP launch keeps the project root and quotes the native alias", () => {
  const root = String.raw`C:\Projects\project & tools`;
  const command = String.raw`C:\Projects\project & tools\node_modules\.bin\ast-mcp.cmd`;
  expect(
    manualHttpLaunchCommand(
      command,
      root,
      httpEndpoint("127.0.0.1", 4912),
      "win32",
    ),
  ).toBe(
    `cd /d "${root}" && "${command}" mcp --transport http --host 127.0.0.1 --port 4912`,
  );
  expect(() =>
    manualHttpLaunchCommand(
      command,
      String.raw`C:\Projects\%PATH%`,
      httpEndpoint("127.0.0.1", 4912),
      "win32",
    ),
  ).toThrow("CMD expansion characters");
});

const created: string[] = [];
afterEach(async () => {
  await Promise.all(
    created
      .splice(0)
      .map((folder) => rm(folder, { force: true, recursive: true })),
  );
});

async function temporary(prefix: string) {
  const folder = await mkdtemp(path.join(os.tmpdir(), prefix));
  created.push(folder);
  return folder;
}

test("parses HTTP installer options and reports the effective endpoint", async () => {
  const root = await temporary("ast-mcp installer & cli http-");
  const output: string[] = [];
  const stdout = spyOn(process.stdout, "write").mockImplementation((value) => {
    output.push(String(value));
    return true;
  });
  try {
    await runInstallerCli([
      "install",
      "--scope=local",
      "--target=codex",
      `--root=${root}`,
      "--transport=http",
      "--host=127.0.0.1",
      "--port=4912",
    ]);
  } finally {
    stdout.mockRestore();
  }
  const result = JSON.parse(output.join(""));
  expect(result.transport).toBe("http");
  expect(result.endpoint).toBe("http://127.0.0.1:4912/mcp");
  expect(result.service).toEqual({ managed: false });
  expect(result.manualStart).toContain("--transport http");
  const projectDirectory =
    process.platform === "win32" ? `"${root}"` : `'${root}'`;
  expect(result.manualStart).toStartWith(
    `${process.platform === "win32" ? "cd /d" : "cd"} ${projectDirectory} && `,
  );
  expect(
    await readFile(path.join(root, ".codex/config.toml"), "utf8"),
  ).toContain('url = "http://127.0.0.1:4912/mcp"');
});

test("installer output honors flags and rejects invalid output before host writes", async () => {
  const root = await temporary("ast-mcp-installer-output-");
  for (const extra of [
    ["--output", "xml"],
    ["--output=json", "--output=human"],
  ]) {
    await expect(
      runInstallerCli([
        "install",
        "--root",
        root,
        "--target",
        "codex",
        ...extra,
      ]),
    ).rejects.toThrow("--output");
    await expect(
      access(path.join(root, ".codex/config.toml")),
    ).rejects.toThrow();
  }
  const chunks: string[] = [];
  await runInstallerCli(
    [
      "install",
      "--root",
      root,
      "--target",
      "codex",
      "--transport",
      "http",
      "--port",
      "4913",
      "--output=yaml",
    ],
    {
      isTTY: true,
      write: (text) => chunks.push(text),
    },
  );
  expect(Bun.YAML.parse(chunks.join(""))).toMatchObject({
    operation: "install",
    transport: "http",
    endpoint: "http://127.0.0.1:4913/mcp",
    service: { managed: false },
  });
  chunks.length = 0;
  await runInstallerCli(
    ["uninstall", "--root", root, "--target", "codex", "--output=human"],
    {
      isTTY: false,
      write: (text) => chunks.push(text),
    },
  );
  expect(chunks.join("")).toContain("Installation uninstall");
});

for (const [name, config, flags] of [
  ["malformed TOML", "version = [", ["--output", "json"]],
  [
    "missing formatter configuration",
    'version = 2\n[formatting]\nenabled = true\nfallback = "dprint"\ndprint_config = "./missing-dprint.json"\n',
    ["--output=json"],
  ],
] as const) {
  test(`explicit output permits uninstall with ${name}`, async () => {
    const root = await temporary("ast-mcp-uninstall-recovery-");
    const hostPath = path.join(root, ".codex/config.toml");
    const hostConfig =
      'model = "preserved-model"\n# ast-mcp:begin\n[mcp_servers.ast-mcp]\ncommand = "bun"\nargs = ["ast-mcp", "mcp"]\n# ast-mcp:end\n';
    await mkdir(path.join(root, ".git"));
    await mkdir(path.dirname(hostPath));
    await writeFile(hostPath, hostConfig);
    await writeFile(path.join(root, "ast-mcp.toml"), config);
    const args = ["uninstall", "--root", root, "--target", "codex"];
    const output: string[] = [];
    const context = { write: (text: string) => output.push(text) };

    await expect(runInstallerCli(args, context)).rejects.toThrow();
    expect(await readFile(hostPath, "utf8")).toBe(hostConfig);
    expect(output).toEqual([]);

    await runInstallerCli([...args, ...flags], context);
    expect(JSON.parse(output.join(""))).toMatchObject({
      operation: "uninstall",
    });
    expect(Bun.TOML.parse(await readFile(hostPath, "utf8"))).toEqual({
      model: "preserved-model",
    });
    expect(await readFile(path.join(root, "ast-mcp.toml"), "utf8")).toBe(
      config,
    );
  });
}

test("rejects invalid installer transport and service combinations before host writes", async () => {
  const root = await temporary("ast-mcp-installer-cli-invalid-");
  await expect(
    runInstallerCli([
      "install",
      "--root",
      root,
      "--target",
      "codex",
      "--transport",
      "invalid",
    ]),
  ).rejects.toThrow("expected stdio or http");
  await expect(
    runInstallerCli([
      "install",
      "--root",
      root,
      "--target",
      "codex",
      "--transport",
      "http",
      "--service",
    ]),
  ).rejects.toThrow("explicit --port");
  await expect(access(path.join(root, ".codex/config.toml"))).rejects.toThrow();
});
