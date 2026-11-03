import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v4";

import registerTools from "../../src/tools/index.ts";
import type { IntelligenceToolService } from "../../src/tools/intelligence.ts";

export interface RegisteredToolReference {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

/** Collect registrations only. Never retain or invoke a tool handler. */
export function captureToolReference(
  examples?: Record<string, unknown[]>,
): RegisteredToolReference[] {
  const entries: RegisteredToolReference[] = [];
  const server = {
    server: { setNotificationHandler: Function.prototype },
    registerTool(
      name: string,
      config: {
        title?: string;
        description?: string;
        inputSchema: z.ZodType;
        annotations?: Record<string, unknown>;
      },
    ) {
      if (examples) {
        const candidates = examples[name];
        if (!candidates?.length)
          throw new Error(`Missing documentation example for ${name}`);
        for (const example of candidates) config.inputSchema.parse(example);
      }
      entries.push({
        name,
        title: config.title,
        description: config.description ?? "",
        inputSchema: z.toJSONSchema(config.inputSchema, {
          io: "input",
          unrepresentable: "any",
        }) as Record<string, unknown>,
        annotations: config.annotations,
      });
      return {};
    },
  };
  registerTools(server as unknown as McpServer, {
    intelligence: new Proxy(
      {},
      { get: () => Function.prototype },
    ) as IntelligenceToolService,
  });
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

/** Stable object ordering makes schema drift independent of registration order. */
export function stableReference(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === "object")
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, child]) => [key, normalize(child)]),
      );
    return item;
  };
  return JSON.stringify(normalize(value), null, 2) + "\n";
}

export async function checkToolReference(
  options: {
    print?: boolean;
    snapshot?: string;
    output?: (text: string) => void;
  } = {},
): Promise<void> {
  const actual = stableReference(captureToolReference());
  if (options.print) {
    (options.output ?? console.log)(actual);
    return;
  }
  const snapshot =
    options.snapshot ??
    (await Bun.file(
      new URL("../../website/src/data/tool-reference.json", import.meta.url),
    ).text());
  if (stableReference(JSON.parse(snapshot)) !== actual)
    throw new Error(
      "Tool reference snapshot is stale. Capture with bun run tools:reference --print and update the guarded website snapshot.",
    );
}

if (import.meta.main)
  await checkToolReference({ print: process.argv.includes("--print") });
