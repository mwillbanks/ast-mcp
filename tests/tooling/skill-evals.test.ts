import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

type Evaluation = {
  id: number;
  surface: string;
  category: "positive" | "variant" | "negative";
  variant: string;
  required_tools: string[];
  forbidden_tools: string[];
};

test("eval matrix covers every registered MCP surface", async () => {
  const root = path.resolve(import.meta.dir, "../..");
  const client = new Client({
    name: "skill-eval-coverage-test",
    version: "1.0.0",
  });
  const transport = new StdioClientTransport({
    args: [path.resolve(root, "src/index.ts")],
    command: "bun",
    cwd: root,
    stderr: "pipe",
  });

  try {
    await client.connect(transport);
    const discovered = (await client.listTools()).tools;
    const registered = discovered.map((tool) => tool.name);
    const catalog = await readFile(
      path.resolve(root, "templates/skills/ast-mcp/references/tool-catalog.md"),
      "utf8",
    );
    const toolTable = catalog
      .split("## Callable tools")[1]
      .split("## File inputs")[0];
    const rows = [
      ...toolTable.matchAll(/^\|\s+`([a-z_]+)`\s+\|\s+([^|]+)\|/gm),
    ];
    expect(rows.map((row) => row[1]).sort()).toEqual([...registered].sort());
    for (const tool of discovered) {
      const row = rows.find((candidate) => candidate[1] === tool.name)!;
      const fields = [...row[2].matchAll(/`([A-Za-z_]+)(\?)?`/g)];
      expect(fields.map((field) => field[1]).sort()).toEqual(
        Object.keys(tool.inputSchema.properties ?? {}).sort(),
      );
      expect(
        fields
          .filter((field) => !field[2])
          .map((field) => field[1])
          .sort(),
      ).toEqual([...(tool.inputSchema.required ?? [])].sort());
    }
    const nativeSection = catalog
      .split("## Native intelligence inputs")[1]
      .split("## Workspaces")[0];
    const documentedDepth = nativeSection.match(/`depth` accepts (\d+)–(\d+)/);
    expect(documentedDepth).not.toBeNull();
    for (const tool of discovered) {
      const depth = tool.inputSchema.properties?.depth as
        | {
            type?: string;
            minimum?: number;
            exclusiveMinimum?: number;
            maximum?: number;
          }
        | undefined;
      if (!depth) continue;
      expect(depth.type).toBe("integer");
      const minimum = depth.minimum ?? depth.exclusiveMinimum! + 1;
      expect(Number(documentedDepth![1])).toBe(minimum);
      expect(Number(documentedDepth![2])).toBe(depth.maximum!);
    }
    const suite = await (async () => {
      const evalDirectory = path.resolve(
        root,
        "templates/skills/ast-mcp/evals",
      );
      const [primaryJson, fileHashJson, batchJson] = await Promise.all([
        readFile(path.join(evalDirectory, "evals.json"), "utf8"),
        readFile(path.join(evalDirectory, "file-hash.evals.json"), "utf8"),
        readFile(path.join(evalDirectory, "batch.evals.json"), "utf8"),
      ]);
      const primary = JSON.parse(primaryJson) as {
        mcp_tools: string[];
        evals: Evaluation[];
      };
      const fileHashEvals = JSON.parse(fileHashJson) as Evaluation[];
      const batchEvals = JSON.parse(batchJson) as Evaluation[];
      return {
        ...primary,
        evals: [...primary.evals, ...fileHashEvals, ...batchEvals],
      };
    })();

    expect([...suite.mcp_tools].sort()).toEqual([...registered].sort());
    const batchCases = suite.evals.filter(
      (evaluation) => evaluation.id >= 74 && evaluation.id <= 93,
    );
    expect(batchCases).toHaveLength(20);
    expect(
      batchCases.some(
        (evaluation) => evaluation.variant === "ordered-ast-rules",
      ),
    ).toBeTrue();
    expect(
      batchCases.some((evaluation) => evaluation.variant === "json-rpc-batch"),
    ).toBeTrue();

    for (const tool of registered) {
      const cases = suite.evals.filter(
        (evaluation) => evaluation.surface === tool,
      );
      expect(
        cases.filter((evaluation) => evaluation.category === "positive").length,
      ).toBeGreaterThanOrEqual(1);
      expect(
        cases.filter((evaluation) => evaluation.category === "variant").length,
      ).toBeGreaterThanOrEqual(1);
      expect(
        cases.filter((evaluation) => evaluation.category === "negative").length,
      ).toBeGreaterThanOrEqual(1);

      for (const evaluation of cases) {
        expect(
          [...evaluation.required_tools, ...evaluation.forbidden_tools].every(
            (name) => registered.includes(name),
          ),
        ).toBeTrue();
      }

      expect(
        cases
          .filter((evaluation) => evaluation.category !== "negative")
          .every((evaluation) => evaluation.required_tools.includes(tool)),
      ).toBeTrue();
    }
  } finally {
    await client.close();
  }
});
