import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { clearConfigCache, withConfig } from "../../src/config";
import { formatContent } from "../../src/runtime/format";
import { hermeticConfig } from "../support/hermetic-config";

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

afterEach(async () => {
  clearConfigCache();
  await Promise.all(
    created.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

async function scriptConfig(
  root: string,
  script: string,
  options: {
    mode?: "stdout" | "in_place";
    enabled?: boolean;
    formatterEnabled?: boolean;
    fallback?: "preserve" | "dprint" | "reject";
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
      `fallback = ${JSON.stringify(options.fallback ?? "preserve")}`,
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

test("external formatter timeouts are actionable", async () => {
  const root = await project("ast-mcp-format-native-timeout-");
  await scriptConfig(
    root,
    "await Bun.sleep(250); process.stdout.write(await Bun.stdin.text())",
    { fallback: "reject", timeout: 20 },
  );
  await expect(
    withConfig(hermeticConfig(root), () =>
      formatContent(path.join(root, "value.txt"), "value"),
    ),
  ).rejects.toThrow(/timed out after 20ms/);
});

test.each(["stdout", "in_place"] as const)(
  "preserves content after a %s formatter timeout by default",
  async (mode) => {
    const root = await project("ast-mcp-format-timeout-preserve-");
    const target = path.join(root, "value.txt");
    await scriptConfig(root, "await Bun.sleep(10000)", {
      mode,
      timeout: 20,
    });
    expect(
      await withConfig(hermeticConfig(root), () =>
        formatContent(target, "unchanged"),
      ),
    ).toBe("unchanged");
    expect((await readdir(root)).sort()).toEqual([".git", "ast-mcp.toml"]);
  },
);

test.each([
  ["timeout", "await Bun.sleep(10000)", { timeout: 20 }, "formatter_timeout"],
] as const)(
  "returns typed diagnostics for %s",
  async (_name, script, options, code) => {
    const root = await project("ast-mcp-formatter-diagnostic-");
    await scriptConfig(root, script, { ...options, fallback: "reject" });
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
