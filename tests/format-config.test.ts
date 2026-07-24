import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { clearConfigCache, resolveConfig, withConfig } from "../src/config";
import { formatContent, formatFileAtomically } from "../src/runtime/format";

const created: string[] = [];

async function project(prefix: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  created.push(root);
  await mkdir(path.join(root, ".git"));
  return root;
}

async function configure(root: string, content: string) {
  await writeFile(path.join(root, "ast-mcp.toml"), content);
  clearConfigCache();
}

function formatterToml(options: {
  args: string[];
  command: string;
  extensions?: string[];
  globs?: string[];
  timeoutMs?: number;
}) {
  return [
    "version = 1",
    "[formatting]",
    "enabled = true",
    "[[formatting.formatters]]",
    `command = ${JSON.stringify(options.command)}`,
    `args = ${JSON.stringify(options.args)}`,
    options.extensions
      ? `extensions = ${JSON.stringify(options.extensions)}`
      : undefined,
    options.globs ? `globs = ${JSON.stringify(options.globs)}` : undefined,
    options.timeoutMs ? `timeout_ms = ${options.timeoutMs}` : undefined,
    "",
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

afterEach(async () => {
  clearConfigCache();
  await Promise.all(
    created.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

test("resolves relative and absolute custom dprint configurations", async () => {
  const relativeRoot = await project("ast-mcp-format-relative-");
  const relativeConfig = path.join(relativeRoot, "config", "dprint.json");
  await mkdir(path.dirname(relativeConfig));
  await writeFile(
    relativeConfig,
    JSON.stringify({
      includes: ["**/*.json"],
      json: { indentWidth: 4, "object.preferSingleLine": false },
      plugins: ["https://plugins.dprint.dev/json-0.23.0.wasm"],
    }),
  );
  await configure(
    relativeRoot,
    'version = 1\n[formatting]\ndprint_config = "./config/dprint.json"\n',
  );

  const resolved = await resolveConfig({ cwd: relativeRoot, env: {} });
  expect(resolved.formatting.dprintConfig).toBe(relativeConfig);
  const formatted = await withConfig({ cwd: relativeRoot, env: {} }, () =>
    formatContent(path.join(relativeRoot, "value.json"), '{"a":1}'),
  );
  expect(formatted).toBe('{ "a": 1 }\n');

  const absoluteRoot = await project("ast-mcp-format-absolute-");
  await configure(
    absoluteRoot,
    `version = 1\n[formatting]\ndprint_config = ${JSON.stringify(relativeConfig)}\n`,
  );
  expect(
    (await resolveConfig({ cwd: absoluteRoot, env: {} })).formatting
      .dprintConfig,
  ).toBe(relativeConfig);
});

test("reports missing and invalid custom dprint configurations", async () => {
  const root = await project("ast-mcp-format-invalid-");
  await configure(
    root,
    'version = 1\n[formatting]\ndprint_config = "./missing.json"\n',
  );
  await expect(resolveConfig({ cwd: root, env: {} })).rejects.toThrow(
    /formatting\.dprint_config.*does not exist/,
  );

  await writeFile(path.join(root, "broken.json"), "{");
  await configure(
    root,
    'version = 1\n[formatting]\ndprint_config = "./broken.json"\n',
  );
  await expect(resolveConfig({ cwd: root, env: {} })).rejects.toThrow(
    /Invalid dprint configuration.*broken\.json/,
  );
});

test("disabled formatting skips dprint and atomic rewrites", async () => {
  const root = await project("ast-mcp-format-disabled-");
  const filePath = path.join(root, "value.json");
  const content = '{"a":1}';
  await writeFile(filePath, content);
  await configure(root, "version = 1\n[formatting]\nenabled = false\n");

  await withConfig(
    { cwd: root, env: { DPRINT_BINARY: path.join(root, "missing-dprint") } },
    async () => {
      expect(await formatContent(filePath, content)).toBe(content);
      await formatFileAtomically(filePath);
    },
  );
  expect(await readFile(filePath, "utf8")).toBe(content);
});

test("external formatters match extensions and receive placeholders without a shell", async () => {
  const root = await project("ast-mcp-format-external-");
  const script = path.join(root, "formatter.mjs");
  await writeFile(
    script,
    'let input = ""; for await (const chunk of process.stdin) input += chunk; process.stdout.write(process.argv[2] + "|" + process.argv[3] + "|" + input.toUpperCase());',
  );
  await configure(
    root,
    formatterToml({
      args: [script, "{file}", "{project_root}"],
      command: process.execPath,
      extensions: [".TXT"],
    }),
  );

  const output = await withConfig({ cwd: root, env: {} }, () =>
    formatContent(path.join(root, "notes.TXT"), "hello"),
  );
  expect(output).toBe(`${path.join(root, "notes.TXT")}|${root}|HELLO`);
});

test("external formatter glob routing is ordered and unmatched files fall back to dprint", async () => {
  const root = await project("ast-mcp-format-routing-");
  const script = path.join(root, "formatter.mjs");
  await writeFile(
    script,
    'let input = ""; for await (const chunk of process.stdin) input += chunk; process.stdout.write(process.argv[2] + ":" + input);',
  );
  await configure(
    root,
    [
      "version = 1",
      "[formatting]",
      "[[formatting.formatters]]",
      `command = ${JSON.stringify(process.execPath)}`,
      `args = ${JSON.stringify([script, "first"])}`,
      'globs = ["generated/**/*.data"]',
      "[[formatting.formatters]]",
      `command = ${JSON.stringify(process.execPath)}`,
      `args = ${JSON.stringify([script, "second"])}`,
      'extensions = [".data"]',
      "",
    ].join("\n"),
  );

  await withConfig({ cwd: root, env: {} }, async () => {
    expect(
      await formatContent(path.join(root, "generated", "x.data"), "value"),
    ).toBe("first:value");
    expect(await formatContent(path.join(root, "plain.json"), '{"a":1}')).toBe(
      '{ "a": 1 }\n',
    );
  });
});

test("external formatter failures and timeouts are actionable", async () => {
  const root = await project("ast-mcp-format-errors-");
  await configure(
    root,
    formatterToml({
      args: ["-e", "console.error('formatter exploded'); process.exit(7)"],
      command: process.execPath,
      extensions: [".txt"],
    }),
  );
  await expect(
    withConfig({ cwd: root, env: {} }, () =>
      formatContent(path.join(root, "value.txt"), "value"),
    ),
  ).rejects.toThrow(/formatter exploded/);

  await configure(
    root,
    formatterToml({
      args: [
        "-e",
        "await Bun.sleep(250); process.stdout.write(await Bun.stdin.text())",
      ],
      command: process.execPath,
      extensions: [".txt"],
      timeoutMs: 20,
    }),
  );
  await expect(
    withConfig({ cwd: root, env: {} }, () =>
      formatContent(path.join(root, "value.txt"), "value"),
    ),
  ).rejects.toThrow(/timed out after 20ms/);
});
