import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withConfig } from "../src/config";
import { sha256 } from "../src/runtime/hash";
import registerConfigurationTools from "../src/tools/configuration";

type ToolResult = {
  content: Array<{ text?: string; type: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
};
type ToolHandler = (
  args: Record<string, unknown>,
  context?: unknown,
) => Promise<ToolResult>;

test("configuration tools expose health, policy, and bounded document selectors", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "ast-mcp-config-tools-v2-"),
  );
  const previousRoots = process.env.AST_MCP_ROOTS;
  process.env.AST_MCP_ROOTS = root;
  const registered = new Map<string, ToolHandler>();
  const server = {
    registerTool(name: string, _definition: unknown, handler: ToolHandler) {
      registered.set(name, handler);
    },
    server: {
      getClientCapabilities: () => ({ roots: {} }),
      listRoots: async () => ({ roots: [{ uri: `file://${root}` }] }),
    },
  };
  const execute = async <T>(
    _args: unknown,
    operation: () => Promise<T>,
  ): Promise<T> =>
    withConfig(
      {
        cwd: root,
        env: {
          AST_MCP_ROOTS: root,
          XDG_CONFIG_HOME: path.join(root, "xdg"),
        },
      },
      operation,
    );

  try {
    await mkdir(path.join(root, ".git"));
    await writeFile(
      path.join(root, "ast-mcp.toml"),
      [
        "version = 2",
        "[formatting]",
        'fallback = "preserve"',
        "[[paths]]",
        'id = "workspace"',
        'path = "."',
        'policies = { read = "allow", write = "request" }',
        "",
      ].join("\n"),
    );
    registerConfigurationTools(server as never, execute as never);
    expect(registered.has("config_core")).toBeTrue();
    expect(registered.has("config_paths")).toBeTrue();
    const emptyCore = await (registered.get("config_core") as ToolHandler)({});
    expect(emptyCore.isError).toBeTrue();
    const missingPath = await (registered.get("config_paths") as ToolHandler)({
      operations: [{ id: "missing", op: "remove" }],
    });
    expect(missingPath.isError).toBeTrue();

    const status = await (registered.get("config_status") as ToolHandler)({});
    expect(status.isError).not.toBeTrue();
    expect(status.structuredContent).toMatchObject({
      data: {
        diagnostics: [
          {
            code: "deprecated_root_environment",
            source: "AST_MCP_ROOTS",
          },
        ],
        generation: 1,
        healthy: true,
        version: 2,
      },
      ok: true,
    });

    const policy = await (registered.get("policy_check") as ToolHandler)({
      checks: [
        { operation: "read", path: path.join(root, "data.json") },
        { operation: "write", path: path.join(root, "data.json") },
        { operation: "delete", path: path.join(root, "data.json") },
      ],
    });
    expect(policy.isError).not.toBeTrue();
    const target = path.join(root, "target.json");
    const link = path.join(root, "link.json");
    await writeFile(target, '{"value":1}');
    await symlink(target, link);
    const linkPolicy = await (registered.get("policy_check") as ToolHandler)({
      checks: [{ operation: "read", path: link }],
    });
    expect(linkPolicy.structuredContent).toMatchObject({
      data: { decisions: [{ policy: "deny" }] },
      ok: true,
    });
    expect(
      (
        (
          policy.structuredContent as {
            data: { decisions: Array<{ policy: string }> };
          }
        ).data.decisions as Array<{ policy: string }>
      ).map((decision) => decision.policy),
    ).toEqual(["allow", "request", "request"]);
    const relativePolicy = await (
      registered.get("policy_check") as ToolHandler
    )({
      checks: [{ operation: "read", path: "relative.json" }],
    });
    expect(relativePolicy.structuredContent).toMatchObject({
      data: {
        decisions: [
          { canonicalPath: path.join(await realpath(root), "relative.json") },
        ],
      },
      ok: true,
    });

    const documents: Array<[string, string, string[]]> = [
      [
        "data.json",
        JSON.stringify({
          "a/b": 3,
          items: [{ name: "zero" }, { name: "one" }],
        }),
        ["", "/a~1b", "/items/1/name", "/missing"],
      ],
      ["data.jsonc", '{ // comment\n "value": 4\n}', ["/value"]],
      ["data.toml", "[group]\nvalue = 5\n", ["/group/value"]],
      ["data.yaml", "group:\n  value: 6\n", ["/group/value"]],
    ];
    for (const [name, content, selectors] of documents) {
      const filePath = path.join(root, name);
      await writeFile(filePath, content);
      const result = await (registered.get("document_query") as ToolHandler)({
        filePath,
        selectors,
      });
      expect(result.isError).not.toBeTrue();
      expect(result.structuredContent).toMatchObject({
        data: { filePath: await realpath(filePath) },
        ok: true,
      });
      expect(
        String(
          (result.structuredContent as { data: { sha256: string } }).data
            .sha256,
        ),
      ).toBe(sha256(content));
      if (name === "data.json") {
        const values = (
          result.structuredContent as {
            data: {
              values: Array<{
                location: { column?: number; line?: number; selector: string };
              }>;
            };
          }
        ).data.values;
        expect(
          values.find((item) => item.location.selector === "/items/1/name")
            ?.location,
        ).toEqual({
          column: content.indexOf('"name":"one"') + 1,
          line: 1,
          selector: "/items/1/name",
        });
      }
    }

    const invalidSelector = await (
      registered.get("document_query") as ToolHandler
    )({
      filePath: path.join(root, "data.json"),
      selectors: ["not-a-pointer"],
    });
    expect(invalidSelector.isError).toBeTrue();
    const unsupported = path.join(root, "data.txt");
    await writeFile(unsupported, "value");
    const invalidFormat = await (
      registered.get("document_query") as ToolHandler
    )({ filePath: unsupported, selectors: [""] });
    expect(invalidFormat.isError).toBeTrue();
    const largeResult = path.join(root, "large-result.json");
    await writeFile(
      largeResult,
      JSON.stringify({ value: "x".repeat(300_000) }),
    );
    const resultTooLarge = await (
      registered.get("document_query") as ToolHandler
    )({ filePath: largeResult, selectors: [""] });
    expect(resultTooLarge).toMatchObject({
      isError: true,
      structuredContent: {
        error: { code: "document_result_too_large" },
        ok: false,
      },
    });
    const largeSource = path.join(root, "large-source.json");
    await writeFile(largeSource, `{"value":"${"x".repeat(1024 * 1024)}"}`);
    const sourceTooLarge = await (
      registered.get("document_query") as ToolHandler
    )({ filePath: largeSource, selectors: ["/value"] });
    expect(sourceTooLarge).toMatchObject({
      isError: true,
      structuredContent: {
        error: { code: "document_too_large" },
        ok: false,
      },
    });
  } finally {
    if (previousRoots === undefined) delete process.env.AST_MCP_ROOTS;
    else process.env.AST_MCP_ROOTS = previousRoots;
    await rm(root, { force: true, recursive: true });
  }
});
