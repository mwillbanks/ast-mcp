import { describe, expect, test } from "bun:test";
import path from "node:path";
import * as z from "zod/v4";
import { normalizeConfigLayer } from "../src/helpers/config";
import { parseInstallerArguments } from "../src/helpers/installer";
import { boundedRecord } from "../src/helpers/mcp-schema";
import {
  compactCallSyntax,
  containsToolInvocation,
  normalizeNewlines,
} from "../src/helpers/string";

describe("shared helpers", () => {
  test("normalizes text and detects direct MCP invocations", () => {
    expect(normalizeNewlines("one\r\ntwo\rthree")).toBe("one\ntwo\nthree");
    expect(compactCallSyntax("tools . mcp__ast_mcp__show ( value )")).toContain(
      "tools.mcp__ast_mcp__show(",
    );
    expect(
      containsToolInvocation("await tools.mcp__ast_mcp__show({ path })", [
        "mcp__ast_mcp__show",
      ]),
    ).toBe(true);
  });

  test("normalizes dependency commands relative to the configuration file", () => {
    const configDirectory = path.resolve("/workspace", "config");
    const configPath = path.join(configDirectory, "ast-mcp.toml");
    expect(
      normalizeConfigLayer(
        { dependencies: { dprint_binary: "./bin/dprint" } },
        configPath,
      ).dependencies,
    ).toEqual({
      dprint_binary: path.join(configDirectory, "bin/dprint"),
    });
  });

  test("parses installer aliases and rejects unknown options before values", () => {
    expect(
      parseInstallerArguments(
        ["update", "--target=codex", "--port", "4312"],
        "/repo",
      ),
    ).toEqual({
      operation: "update",
      options: {
        port: 4312,
        root: "/repo",
        scope: "local",
        targets: ["codex"],
      },
    });
    expect(() => parseInstallerArguments(["--unknown"], "/repo")).toThrow(
      "Unknown option",
    );
  });

  test("enforces shared keyed-batch bounds", () => {
    const schema = boundedRecord(z.object({ value: z.string() }), "bounded");
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ one: { value: "ok" } }).success).toBe(true);
    const oversized = Object.fromEntries(
      Array.from({ length: 51 }, (_, index) => [String(index), { value: "x" }]),
    );
    expect(schema.safeParse(oversized).success).toBe(false);
  });
});
