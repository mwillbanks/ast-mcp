import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { withConfig } from "../../src/config";
import { formatContent } from "../../src/runtime/format";
import { hermeticConfig } from "../support/hermetic-config";

const samples = [
  ["value.json", '{"answer":42}', "answer"],
  ["notes.md", "# Title\n\n-   first\n", "first"],
  ["settings.toml", "answer=42\n", "answer"],
  ["Dockerfile", "FROM alpine:3.22\nRUN echo hello\n", "hello"],
  ["example.php", "<?php\nfunction answer(){return 42;}\n", "answer"],
  ["example.py", "def answer():\n return 42\n", "answer"],
  ["example.go", "package main\nfunc answer() int {return 42}\n", "answer"],
  ["example.html", "<div><span>answer</span></div>", "answer"],
  ["Example.cs", "class Example{public int Answer(){return 42;}}", "Answer"],
  [
    "example.ipynb",
    JSON.stringify({
      cells: [
        {
          cell_type: "code",
          execution_count: null,
          metadata: {},
          outputs: [],
          source: ["answer=42"],
        },
      ],
      metadata: { language_info: { name: "python" } },
      nbformat: 4,
      nbformat_minor: 5,
    }),
    "answer",
  ],
] as const;

test.each(samples)(
  "disabled formatting preserves %s byte-for-byte",
  async (name, source, marker) => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "ast-mcp-formatter-upgrades-"),
    );
    try {
      await withConfig(hermeticConfig(root), async () => {
        const target = path.join(root, name);
        const formatted = await formatContent(target, source);
        expect(formatted, name).toContain(marker);
        expect(formatted, name).toBe(source);
        expect(await formatContent(target, formatted), name).toBe(formatted);
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  60_000,
);
