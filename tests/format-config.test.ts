import { afterEach, expect, spyOn, test } from "bun:test";
import {
  chmod,
  stat,
  symlink,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { clearConfigCache, resolveConfig, withConfig } from "../src/config";
import { writeFilesSafely } from "../src/patch/engine";
import {
  assertFormattable,
  formatContent,
  formatFileAtomically,
} from "../src/runtime/format";
import { sha256 } from "../src/runtime/hash";
import { hermeticConfig } from "./support/hermetic-config";

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

  const resolved = await resolveConfig(hermeticConfig(relativeRoot));
  expect(resolved.formatting.dprintConfig).toBe(relativeConfig);
  const formatted = await withConfig(hermeticConfig(relativeRoot), () =>
    formatContent(path.join(relativeRoot, "value.json"), '{"a":1}'),
  );
  expect(formatted).toBe('{"a":1}');

  const absoluteRoot = await project("ast-mcp-format-absolute-");
  await configure(
    absoluteRoot,
    `version = 1\n[formatting]\ndprint_config = ${JSON.stringify(relativeConfig)}\n`,
  );
  expect(
    (await resolveConfig(hermeticConfig(absoluteRoot))).formatting.dprintConfig,
  ).toBe(relativeConfig);
});

test("reports missing and invalid custom dprint configurations", async () => {
  const root = await project("ast-mcp-format-invalid-");
  await configure(
    root,
    'version = 2\n[formatting]\nenabled = true\nfallback = "dprint"\ndprint_config = "./missing.json"\n',
  );
  await expect(resolveConfig(hermeticConfig(root))).rejects.toThrow(
    /formatting\.dprint_config.*does not exist/,
  );

  await writeFile(path.join(root, "broken.json"), "{");
  await configure(
    root,
    'version = 2\n[formatting]\nenabled = true\nfallback = "dprint"\ndprint_config = "./broken.json"\n',
  );
  await expect(resolveConfig(hermeticConfig(root))).rejects.toThrow(
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
    hermeticConfig(root, {
      DPRINT_BINARY: path.join(root, "missing-dprint"),
    }),
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

  const output = await withConfig(hermeticConfig(root), () =>
    formatContent(path.join(root, "notes.TXT"), "hello"),
  );
  expect(output).toBe(`${path.join(root, "notes.TXT")}|${root}|HELLO`);
});

test("external formatter glob routing is ordered and unmatched files remain unchanged", async () => {
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
      "enabled = true",
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

  await withConfig(hermeticConfig(root), async () => {
    expect(
      await formatContent(path.join(root, "generated", "x.data"), "value"),
    ).toBe("first:value");
    expect(await formatContent(path.join(root, "plain.json"), '{"a":1}')).toBe(
      '{"a":1}',
    );
  });
});

test("external formatter glob matches a directory beginning with two dots", async () => {
  const root = await project("ast-mcp-format-dot-prefix-");
  const script = path.join(root, "formatter.mjs");
  await writeFile(
    script,
    'let input = ""; for await (const chunk of process.stdin) input += chunk; process.stdout.write("nested:" + input.toUpperCase());',
  );
  await configure(
    root,
    formatterToml({
      args: [script],
      command: process.execPath,
      globs: ["..cache/**/*.data"],
    }),
  );

  const output = await withConfig(hermeticConfig(root), () =>
    formatContent(path.join(root, "..cache", "deep", "value.data"), "kept"),
  );
  expect(output).toBe("nested:KEPT");
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
    withConfig(hermeticConfig(root), () =>
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
    withConfig(hermeticConfig(root), () =>
      formatContent(path.join(root, "value.txt"), "value"),
    ),
  ).rejects.toThrow(/timed out after 20ms/);
});

async function scriptConfig(
  root: string,
  script: string,
  options: {
    mode?: "stdout" | "in_place";
    enabled?: boolean;
    formatterEnabled?: boolean;
    command?: string;
    timeout?: number;
    args?: string[];
  } = {},
) {
  await configure(
    root,
    [
      "version = 2",
      "[formatting]",
      `enabled = ${options.enabled ?? true}`,
      'fallback = "preserve"',
      'dprint_config = "./missing-unused.json"',
      "[[formatting.formatters]]",
      'id = "test"',
      `enabled = ${options.formatterEnabled ?? true}`,
      `command = ${JSON.stringify(options.command ?? process.execPath)}`,
      `args = ${JSON.stringify(options.args ?? ["-e", script, "{file}", "{source_file}", "{project_root}"])}`,
      'extensions = [".txt", ".json"]',
      `mode = "${options.mode ?? "stdout"}"`,
      `timeout_ms = ${options.timeout ?? 1000}`,
    ].join("\n"),
  );
}

test("master disable suppresses explicitly enabled formatters and invalid unused dprint settings", async () => {
  const root = await project("ast-mcp-master-disabled-");
  await scriptConfig(root, "throw new Error('must not execute')", {
    enabled: false,
    command: path.join(root, "missing"),
  });
  expect(
    (await resolveConfig(hermeticConfig(root))).formatting.enabled,
  ).toBeFalse();
  expect(
    await withConfig(hermeticConfig(root), () =>
      formatContent(path.join(root, "value.txt"), "untouched"),
    ),
  ).toBe("untouched");
});

test("disabled individual formatters are skipped under enabled master", async () => {
  const root = await project("ast-mcp-formatter-disabled-");
  await scriptConfig(root, "", {
    formatterEnabled: false,
    command: path.join(root, "missing"),
  });
  expect(
    await withConfig(hermeticConfig(root), () =>
      formatContent(path.join(root, "value.txt"), "untouched"),
    ),
  ).toBe("untouched");
});

test.each([
  [
    "missing",
    "",
    { command: "ast-mcp-no-such-formatter-676977" },
    "formatter_unavailable",
  ],
  [
    "nonzero",
    "console.error('rejected candidate');process.exit(7)",
    {},
    "formatter_rejected",
  ],
  ["timeout", "await Bun.sleep(10000)", { timeout: 20 }, "formatter_timeout"],
  [
    "oversized stdout",
    "process.stdout.write(Buffer.alloc(17*1024*1024,65))",
    {},
    "formatter_invalid_output",
  ],
  [
    "invalid stdout",
    "process.stdout.write(Buffer.from([0xff]))",
    {},
    "formatter_invalid_output",
  ],
] as const)(
  "returns typed diagnostics for %s",
  async (_name, script, options, code) => {
    const root = await project("ast-mcp-formatter-diagnostic-");
    await scriptConfig(root, script, options);
    await expect(
      withConfig(hermeticConfig(root), () =>
        formatContent(path.join(root, "value.txt"), "unchanged"),
      ),
    ).rejects.toMatchObject({
      code,
      retryable: false,
      suggestedNextCall: "config_status",
    });
  },
);

test("in-place formatting preserves basename, nested config discovery, cwd and source placeholders", async () => {
  const root = await project("ast-mcp-inplace-basename-");
  const nested = path.join(root, "nested");
  await mkdir(nested);
  await writeFile(path.join(root, "formatter.json"), '{"tag":"root"}');
  await writeFile(path.join(nested, "formatter.json"), '{"tag":"nested"}');
  const target = path.join(nested, "package.json");
  await writeFile(target, '{"original":true}');
  const script = `const fs = await import("node:fs/promises"); const path = await import("node:path"); const [file, source, root] = process.argv.slice(1); let dir=path.dirname(file); while(!await Bun.file(path.join(dir,"formatter.json")).exists()) dir=path.dirname(dir); const conf=await Bun.file(path.join(dir,"formatter.json")).json(); await fs.writeFile(file, JSON.stringify({name:path.basename(file),tag:conf.tag,cwd:process.cwd(),source,root}));`;
  await scriptConfig(root, script, { mode: "in_place" });
  const result = await withConfig(hermeticConfig(root), () =>
    formatContent(target, "{}"),
  );
  const formatted = JSON.parse(result);
  expect(formatted).toEqual({
    name: "package.json",
    tag: "nested",
    cwd: expect.any(String),
    source: target,
    root,
  });
  const [actualCwd, expectedCwd] = await Promise.all([
    stat(formatted.cwd, { bigint: true }),
    stat(root, { bigint: true }),
  ]);
  expect(actualCwd.ino).toBeGreaterThan(0n);
  expect(actualCwd.dev).toBe(expectedCwd.dev);
  expect(actualCwd.ino).toBe(expectedCwd.ino);
  expect(await readFile(target, "utf8")).toBe('{"original":true}');
  expect((await readdir(nested)).sort()).toEqual([
    "formatter.json",
    "package.json",
  ]);
});

test.each([
  ["removed", "await fs.unlink(file)"],
  ["directory", "await fs.unlink(file);await fs.mkdir(file)"],
  ["invalid UTF-8", "await fs.writeFile(file, Buffer.from([0xff]))"],
  ["oversized", "await fs.writeFile(file,Buffer.alloc(17*1024*1024,65))"],
])("rejects %s in-place output and removes staging", async (_name, action) => {
  const root = await project("ast-mcp-inplace-invalid-");
  await scriptConfig(
    root,
    `const fs=await import("node:fs/promises");const file=process.argv[1];${action}`,
    { mode: "in_place" },
  );
  await expect(
    withConfig(hermeticConfig(root), () =>
      formatContent(path.join(root, "value.txt"), "original"),
    ),
  ).rejects.toMatchObject({ code: "formatter_invalid_output" });
  expect((await readdir(root)).sort()).toEqual([".git", "ast-mcp.toml"]);
});

test("formatter failure preserves atomic batches and removes newly created parents", async () => {
  const root = await project("ast-mcp-formatter-batch-");
  const first = path.join(root, "first.txt");
  const second = path.join(root, "new", "deep", "second.txt");
  await writeFile(first, "original");
  await scriptConfig(
    root,
    `const fs=await import("node:fs/promises");const file=process.argv[1]; if(file.endsWith("second.txt")){console.error("second rejected");process.exit(2)} await fs.writeFile(file,"formatted");`,
    { mode: "in_place" },
  );
  await expect(
    withConfig(hermeticConfig(root), () =>
      writeFilesSafely({
        [first]: { content: "candidate", expectedSha256: sha256("original") },
        [second]: { content: "candidate" },
      }),
    ),
  ).rejects.toMatchObject({ code: "formatter_rejected" });
  expect(await readFile(first, "utf8")).toBe("original");
  expect(await Bun.file(second).exists()).toBeFalse();
  expect((await readdir(root)).sort()).toEqual([
    ".git",
    "ast-mcp.toml",
    "first.txt",
  ]);
});

test("formatter failure cleans created parents when mkdir returns a physical alias", async () => {
  const root = await realpath(await project("ast-mcp-formatter-alias-batch-"));
  const first = path.join(root, "first.txt");
  const second = path.join(root, "new", "deep", "second.txt");
  const alias = path.join(root, ".physical-alias");
  await symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
  await writeFile(first, "original");
  await scriptConfig(
    root,
    'console.error("original formatter failure");process.exit(2)',
    { mode: "in_place" },
  );
  const filesystem = await import("node:fs/promises");
  const originalMkdir = filesystem.mkdir;
  let aliases = 0;
  const make = spyOn(filesystem, "mkdir").mockImplementation((async (
    ...args: Parameters<typeof mkdir>
  ) => {
    const created = await originalMkdir(...args);
    if (
      typeof created === "string" &&
      path.basename(String(args[0])) === "deep"
    ) {
      aliases++;
      return path.join(alias, "new");
    }
    return created;
  }) as typeof mkdir);
  const remove = spyOn(filesystem, "rmdir");
  try {
    // Visit the new path first so the rejection exercises its parent cleanup.
    await expect(
      withConfig(hermeticConfig(root), () =>
        writeFilesSafely({
          [second]: { content: "candidate" },
          [first]: { content: "candidate", expectedSha256: sha256("original") },
        }),
      ),
    ).rejects.toMatchObject({
      code: "formatter_rejected",
      message: expect.stringContaining("original formatter failure"),
    });
    expect(aliases).toBe(1);
    expect(await Bun.file(second).exists()).toBeFalse();
    await expect(stat(path.join(root, "new"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(first, "utf8")).toBe("original");
    for (const [directory] of remove.mock.calls) {
      const relative = path.relative(root, String(directory));
      expect(relative).not.toBe("..");
      expect(relative.startsWith(`..${path.sep}`)).toBeFalse();
      expect(path.isAbsolute(relative)).toBeFalse();
      expect(relative).not.toBe("");
    }
  } finally {
    make.mockRestore();
    remove.mockRestore();
  }
});

test("explicit installed external dprint compatibility receives stdin and original source path", async () => {
  const root = await project("ast-mcp-dprint-explicit-");
  const config = path.join(root, "dprint.json");
  await writeFile(config, "{}");
  await configure(
    root,
    `version = 2\n[formatting]\nenabled = true\nfallback = "dprint"\ndprint_config = ${JSON.stringify(config)}\n[dependencies]\ndprint_binary = ${JSON.stringify(process.execPath)}\n`,
  );
  // Bun executes this local fixture as the dprint fmt subcommand.
  await writeFile(
    path.join(root, "fmt"),
    "process.stdout.write(JSON.stringify({args:process.argv.slice(2),input:await Bun.stdin.text()}));",
  );
  const output = await withConfig(hermeticConfig(root), () =>
    formatContent(path.join(root, "value.txt"), "input"),
  );
  expect(JSON.parse(output)).toEqual({
    args: ["--config", config, "--stdin", "value.txt"],
    input: "input",
  });
});

test("reject fallback requires explicit master activation", async () => {
  const root = await project("ast-mcp-format-reject-");
  await configure(
    root,
    'version = 2\n[formatting]\nenabled = true\nfallback = "reject"\n',
  );
  await expect(
    withConfig(hermeticConfig(root), () =>
      formatContent(path.join(root, "x.txt"), "source"),
    ),
  ).rejects.toMatchObject({ code: "formatter_rejected" });
});

test.each(["stdout", "in_place"] as const)(
  "explicit %s preserves a UTF-8 BOM",
  async (mode) => {
    const root = await project("ast-mcp-format-bom-");
    await scriptConfig(
      root,
      mode === "stdout" ? "process.stdin.pipe(process.stdout)" : "",
      { mode },
    );
    expect(
      await withConfig(hermeticConfig(root), () =>
        formatContent(path.join(root, "value.txt"), "\uFEFFsource"),
      ),
    ).toBe("\uFEFFsource");
  },
);

test("explicit stdout formatting commits atomically and preserves OS mode", async () => {
  const root = await project("ast-mcp-format-atomic-");
  const target = path.join(root, "value.txt");
  await writeFile(target, "original", { mode: 0o640 });
  await scriptConfig(
    root,
    "process.stdout.write((await Bun.stdin.text()).toUpperCase())",
  );
  await withConfig(hermeticConfig(root), async () => {
    await assertFormattable(target);
    await formatFileAtomically(target);
  });
  expect(await readFile(target, "utf8")).toBe("ORIGINAL");
  if (process.platform !== "win32")
    expect((await stat(target)).mode & 0o777).toBe(0o640);
});

test.skipIf(process.platform === "win32")(
  "in-place symlink output cannot read an external file",
  async () => {
    const root = await project("ast-mcp-format-symlink-");
    const external = path.join(root, "external.txt");
    await writeFile(external, "private");
    await scriptConfig(
      root,
      `const fs=await import("node:fs/promises");const path=await import("node:path");const file=process.argv[1];await fs.unlink(file);await fs.symlink(path.join(process.argv[3],"external.txt"),file)`,
      { mode: "in_place" },
    );
    await expect(
      withConfig(hermeticConfig(root), () =>
        formatContent(path.join(root, "value.txt"), "candidate"),
      ),
    ).rejects.toMatchObject({ code: "formatter_invalid_output" });
    expect(await readFile(external, "utf8")).toBe("private");
  },
);

test.skipIf(process.platform === "win32" || process.getuid?.() === 0).each([
  ["success", "", "formatter_cleanup_failed"],
  ["rejection", "process.exit(7)", "formatter_rejected"],
])("cleanup failure preserves %s outcome", async (_name, exit, code) => {
  const root = await project("ast-mcp-format-cleanup-");
  await scriptConfig(
    root,
    `const fs=await import("node:fs/promises");await fs.chmod(process.argv[3],0o500);${exit}`,
    { mode: "in_place" },
  );
  try {
    await expect(
      withConfig(hermeticConfig(root), () =>
        formatContent(path.join(root, "value.txt"), "candidate"),
      ),
    ).rejects.toMatchObject({ code });
  } finally {
    await chmod(root, 0o700);
  }
});

test("installed oxfmt formats staged package.json with filename-sensitive configuration", async () => {
  const root = await project("ast-mcp-format-oxfmt-");
  const target = path.join(root, "package.json");
  const source = '{"trustedDependencies":["a","b"]}';
  const command = Bun.which("oxfmt", {
    PATH: path.resolve(import.meta.dir, "../node_modules/.bin"),
  });
  if (!command) throw new Error("Repository oxfmt executable is missing");
  await scriptConfig(root, "", {
    command,
    args: ["--write", "{file}"],
    mode: "in_place",
  });
  const output = await withConfig(hermeticConfig(root), () =>
    formatContent(target, source),
  );
  expect(JSON.parse(output)).toEqual(JSON.parse(source));
  expect(output).toContain('"trustedDependencies": [\n');
  expect(await Bun.file(target).exists()).toBeFalse();
});
