import { expect, test } from "bun:test";
import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { McpServer, ServerContext } from "@modelcontextprotocol/server";

import { withConfig } from "../../src/config";
import { parseSource } from "../../src/intelligence/parser/index.ts";
import registerCodeIntelligence from "../../src/tools/code-intelligence";
import { hermeticConfig } from "../support/hermetic-config";

test("member and cycle output limits report incomplete results after exhaustive scans", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ast-bulk-output-budget-"));
  const api = harness(root);
  try {
    await writeFile(
      path.join(root, "first.ts"),
      'import { second } from "./second"; export const first = 1; export const extra = 2;',
    );
    await writeFile(
      path.join(root, "second.ts"),
      'import { first } from "./first"; export const second = 1;',
    );
    for (const name of ["map", "digest"]) {
      const result = await api.call(name, { max_members: 0 });
      expect(result.isError).not.toBeTrue();
      expect(result.structuredContent.data).toMatchObject({
        exhaustive: false,
        truncated: true,
        scan: { exhaustive: true, truncated: false, parsed: 2 },
      });
      expect(JSON.parse(result.content[0]!.text)).toMatchObject({
        exhaustive: false,
        truncated: true,
      });
    }
    const completeCycles = await api.call("cycles");
    expect(completeCycles.isError).not.toBeTrue();
    expect(completeCycles.structuredContent.data).toMatchObject({
      exhaustive: true,
      truncated: false,
    });
    expect(JSON.stringify(completeCycles.structuredContent.data)).toContain(
      "first.ts",
    );
    const limitedCycles = await api.call("cycles", { budget: 2 });
    expect(limitedCycles.isError).not.toBeTrue();
    expect(limitedCycles.structuredContent.data).toMatchObject({
      exhaustive: false,
      truncated: true,
      scan: { exhaustive: true, truncated: false, parsed: 2 },
    });
    expect(JSON.parse(limitedCycles.content[0]!.text)).toMatchObject({
      cycles: [],
      exhaustive: false,
      truncated: true,
    });
  } finally {
    await api.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

const sourceLimit = 2 * 1024 * 1024;
const requestLimit = 16 * 1024 * 1024;
type Reply = {
  isError?: boolean;
  content: Array<{ text: string }>;
  structuredContent: {
    data: {
      exhaustive: boolean;
      truncated: boolean;
      items?: unknown[];
      files?: unknown[];
      scan: {
        candidates: number;
        parsed: number;
        exhaustive: boolean;
        truncated: boolean;
        omitted: Record<string, number>;
        paths: Record<string, string[]>;
        pathsTruncated: boolean;
      };
    };
    error?: { code: string };
  };
};

function harness(root: string) {
  const handlers = new Map<
    string,
    (input: Record<string, unknown>, context: ServerContext) => Promise<Reply>
  >();
  const server = {
    async close() {},
    registerTool(name: string, _definition: unknown, handler: never) {
      handlers.set(name, handler);
    },
  };
  registerCodeIntelligence(
    server as unknown as McpServer,
    async (_args, operation) => withConfig(hermeticConfig(root), operation),
  );
  return {
    close: () => server.close(),
    call: (name: string, input: Record<string, unknown> = {}) =>
      handlers.get(name)!(
        { root, timeout_ms: 30_000, ...input },
        {} as ServerContext,
      ),
  };
}

function assertIncomplete(reply: Reply) {
  expect(reply.isError, JSON.stringify(reply)).not.toBeTrue();
  expect(reply.structuredContent.data).toMatchObject({
    exhaustive: false,
    truncated: true,
    scan: { exhaustive: false, truncated: true },
  });
  // Agents read the compact text projection as well as structuredContent.
  expect(JSON.parse(reply.content[0]!.text)).toMatchObject({
    exhaustive: false,
    truncated: true,
    scan: { exhaustive: false, truncated: true },
  });
}

test("bulk source-size omissions continue scanning and bound diagnostic paths across native tools", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ast-bulk-source-size-"));
  const api = harness(root);
  try {
    const omitted = Array.from(
      { length: 25 },
      (_, index) => `a${String(index).padStart(2, "0")}.ts`,
    );
    for (const name of omitted) {
      const file = path.join(root, name);
      await writeFile(file, "");
      await truncate(file, sourceLimit + 1);
    }
    await writeFile(
      path.join(root, "valid.ts"),
      'import { other } from "./z-other"; export function marker() { return other(); }',
    );
    await writeFile(
      path.join(root, "z-other.ts"),
      "export function other() { return 1; }",
    );
    for (const [name, input] of [
      ["map", {}],
      ["digest", {}],
      ["search", { query: "marker" }],
      ["graph", {}],
      ["deps", { file: "valid.ts" }],
      ["reverse_deps", { file: "z-other.ts" }],
      ["cycles", {}],
    ] as const) {
      const result = await api.call(name, input);
      assertIncomplete(result);
      const scan = result.structuredContent.data.scan;
      expect(scan).toMatchObject({
        candidates: 27,
        parsed: 2,
        omitted: { sourceSize: 25, sourceBytes: 0, parsedFacts: 0 },
        pathsTruncated: true,
      });
      expect(scan.paths.sourceSize).toEqual(omitted.slice(0, 20));
      if (name === "search")
        expect(result.structuredContent.data.items).toHaveLength(1);
      if (name === "graph" || name === "deps" || name === "reverse_deps")
        expect(result.structuredContent.data.items).toHaveLength(1);
    }
    for (const selection of [{ file: omitted[0] }, { paths: [omitted[0]] }]) {
      const exact = await api.call("map", selection);
      expect(exact.isError).toBeTrue();
      expect(exact.structuredContent.error?.code).toBe(
        "intelligence_budget_exceeded",
      );
    }
    const recovered = await api.call("search", {
      file: "valid.ts",
      query: "marker",
    });
    expect(recovered.isError).not.toBeTrue();
    expect(recovered.structuredContent.data).toMatchObject({
      exhaustive: true,
      truncated: false,
    });
  } finally {
    await api.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

test("aggregate source exhaustion returns retained results and reports every unscanned candidate", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ast-bulk-source-bytes-"));
  const api = harness(root);
  try {
    const source = "export const marker = 1;".padEnd(sourceLimit, " ");
    const names = Array.from({ length: 9 }, (_, index) => `file-${index}.ts`);
    for (const name of names) await writeFile(path.join(root, name), source);
    await writeFile(path.join(root, "z-tail.ts"), "export const tail = 1;");
    const result = await api.call("digest");
    assertIncomplete(result);
    expect(result.structuredContent.data.files).toHaveLength(8);
    expect(result.structuredContent.data.scan).toMatchObject({
      candidates: 10,
      parsed: 8,
      omitted: { sourceSize: 0, sourceBytes: 2, parsedFacts: 0 },
      paths: { sourceBytes: ["file-8.ts", "z-tail.ts"] },
    });
  } finally {
    await api.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

test("aggregate parsed-facts exhaustion preserves graph results and does not charge computation twice", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ast-bulk-parsed-facts-"));
  const api = harness(root);
  try {
    const source =
      'import { dependency } from "external-package";\n' +
      Array.from(
        { length: 300 },
        (_, index) =>
          `export function marker${index}() { return dependency(); }\n`,
      ).join("");
    const facts = parseSource({
      languageId: "typescript",
      source,
      maxNodes: 100_000,
    });
    expect(facts.partial).toBeFalse();
    const factBytes = Buffer.byteLength(JSON.stringify(facts));
    const retained = Math.floor(requestLimit / factBytes);
    expect(retained).toBeGreaterThan(0);
    expect(retained).toBeLessThan(49);
    const names = Array.from(
      { length: retained + 2 },
      (_, index) => `file-${String(index).padStart(2, "0")}.ts`,
    );
    expect(Buffer.byteLength(source) * names.length).toBeLessThan(requestLimit);
    for (const name of names) await writeFile(path.join(root, name), source);
    const result = await api.call("graph", { limit: 100, budget: 100_000 });
    assertIncomplete(result);
    expect(result.structuredContent.data.items).toHaveLength(retained);
    expect(result.structuredContent.data.scan).toMatchObject({
      candidates: names.length,
      parsed: retained,
      omitted: { sourceSize: 0, sourceBytes: 0, parsedFacts: 2 },
      paths: { parsedFacts: names.slice(retained) },
    });
  } finally {
    await api.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
