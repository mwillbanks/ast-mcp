import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const repositoryRoot = path.resolve(import.meta.dir, "..");
const roots: string[] = [];

async function git(root: string, args: string[]): Promise<void> {
  const process = Bun.spawn(["git", "-C", root, ...args], {
    stderr: "pipe",
    stdout: "pipe",
  });
  if ((await process.exited) !== 0) {
    throw new Error(await new Response(process.stderr).text());
  }
}

async function fixture(): Promise<{
  client: Client;
  root: string;
  workspaceId: string;
}> {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "ast-mcp-direct-intelligence-"),
  );
  roots.push(root);
  await git(root, ["init", "-b", "main"]);
  await writeFile(
    path.join(root, "tsconfig.json"),
    `{
      // Bun parses this JSONC without another dependency.
      "compilerOptions": {
        "baseUrl": ".",
        "paths": {
          "*-suffix": ["leading/index*"],
          "@bad**": ["bad/*"],
          "@exact": ["lib/exact.ts"],
          "@invalid/*": ["repeated/*/literal-*"],
          "@lib/*": ["lib/*"],
          "ab*bc": ["overlap/*"]
        }
      }
    }\n`,
  );
  await mkdir(path.join(root, "lib"));
  await writeFile(path.join(root, "lib/exact.ts"), "export const exact = 1;\n");
  await writeFile(path.join(root, "lib/value.ts"), "export const value = 1;\n");
  await mkdir(path.join(root, "repeated", "value"), { recursive: true });
  await writeFile(
    path.join(root, "repeated", "value", "literal-*.ts"),
    "export const repeated = 1;\n",
  );
  await mkdir(path.join(root, "leading"));
  await writeFile(
    path.join(root, "leading", "index.ts"),
    "export const leading = 1;\n",
  );
  await mkdir(path.join(root, "overlap"));
  await writeFile(
    path.join(root, "overlap", "b.ts"),
    "export const overlap = 1;\n",
  );
  await writeFile(
    path.join(root, "overlap", "index.ts"),
    "export const overlapIndex = 1;\n",
  );
  await mkdir(path.join(root, "bad"));
  await writeFile(
    path.join(root, "bad", "value.ts"),
    "export const bad = 1;\n",
  );
  await mkdir(path.join(root, "dual"));
  await writeFile(path.join(root, "dual/foo.ts"), "export const value = 1;\n");
  await writeFile(path.join(root, "dual/foo.js"), "export const value = 2;\n");
  await writeFile(
    path.join(root, "explicit.ts"),
    'import { value } from "./dual/foo.ts";\nexport { value };\n',
  );
  await writeFile(
    path.join(root, "barrel.ts"),
    [
      'export { leading } from "-suffix";',
      'export * from "@badvalue*";',
      'export { exact } from "@exact";',
      'export * from "@exact/prefix";',
      'export * from "@invalid/value";',
      'export { value } from "@lib/value";',
      'export * from "abc";',
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(root, "consumer.ts"),
    'import { value } from "./barrel";\nexport const answer = value;\n',
  );
  await writeFile(
    path.join(root, "script.py"),
    'def greet(name):\n    return f"hello {name}"\n',
  );
  await writeFile(path.join(root, "a.ts"), 'import "./b";\n');
  await writeFile(path.join(root, "b.ts"), 'import "./c";\n');
  await writeFile(path.join(root, "c.ts"), 'import "./a";\n');

  const client = new Client({ name: "direct-regression", version: "1.0.0" });
  const transport = new StdioClientTransport({
    args: [path.join(repositoryRoot, "src/index.ts")],
    command: "bun",
    cwd: root,
    stderr: "pipe",
  });
  await client.connect(transport);
  const opened = await client.callTool({
    arguments: { directory: root },
    name: "workspace_open",
  });
  const workspaceId = (
    opened.structuredContent as {
      data?: { workspace?: { workspaceId?: string } };
    }
  ).data?.workspace?.workspaceId;
  if (!workspaceId) throw new Error("workspace_open omitted workspaceId");
  return { client, root, workspaceId };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

test("direct tools analyze catalog languages and resolve dependency scope", async () => {
  const { client, workspaceId } = await fixture();
  try {
    const mapped = await client.callTool({
      arguments: { paths: ["script.py"], workspaceId },
      name: "map",
    });
    expect(mapped.isError).not.toBeTrue();
    expect(mapped.structuredContent).toMatchObject({
      data: {
        files: [
          {
            language: "python",
            path: "script.py",
          },
        ],
      },
    });

    const dependencies = await client.callTool({
      arguments: { file: "barrel.ts", hide_external: true, workspaceId },
      name: "deps",
    });
    expect(dependencies.isError).not.toBeTrue();
    const dependencyItems = (
      dependencies.structuredContent as {
        data: { items: Array<{ external: boolean; from: string; to: string }> };
      }
    ).data.items;
    expect(dependencyItems).toContainEqual(
      expect.objectContaining({
        external: false,
        from: "barrel.ts",
        to: "leading/index.ts",
      }),
    );
    expect(dependencyItems).toContainEqual(
      expect.objectContaining({
        external: false,
        from: "barrel.ts",
        to: "lib/exact.ts",
      }),
    );
    expect(dependencyItems).toContainEqual(
      expect.objectContaining({
        external: false,
        from: "barrel.ts",
        to: "lib/value.ts",
      }),
    );

    const allDependencies = await client.callTool({
      arguments: { file: "barrel.ts", workspaceId },
      name: "deps",
    });
    expect(allDependencies.isError).not.toBeTrue();
    const allDependencyItems = (
      allDependencies.structuredContent as {
        data: { items: Array<{ external: boolean; from: string; to: string }> };
      }
    ).data.items;
    expect(allDependencyItems).toContainEqual(
      expect.objectContaining({
        external: true,
        from: "barrel.ts",
        to: "@badvalue*",
      }),
    );
    expect(allDependencyItems).toContainEqual(
      expect.objectContaining({
        external: true,
        from: "barrel.ts",
        to: "@exact/prefix",
      }),
    );
    expect(allDependencyItems).toContainEqual(
      expect.objectContaining({
        external: true,
        from: "barrel.ts",
        to: "@invalid/value",
      }),
    );
    expect(allDependencyItems).toContainEqual(
      expect.objectContaining({
        external: true,
        from: "barrel.ts",
        to: "abc",
      }),
    );

    for (const selector of [
      { file: "lib/value.ts" },
      { path: "lib/value.ts" },
    ]) {
      const reverse = await client.callTool({
        arguments: { ...selector, hide_external: true, workspaceId },
        name: "reverse_deps",
      });
      expect(reverse.isError).not.toBeTrue();
      expect(reverse.structuredContent).toMatchObject({
        data: {
          items: [
            expect.objectContaining({
              from: "barrel.ts",
              to: "lib/value.ts",
            }),
          ],
        },
      });
    }
  } finally {
    await client.close();
  }
});

test("direct tools bound cycles and UTF-8 payloads deterministically", async () => {
  const { client, workspaceId } = await fixture();
  try {
    const cycles = await client.callTool({
      arguments: { limit: 1, workspaceId },
      name: "cycles",
    });
    expect(cycles.isError).not.toBeTrue();
    const cycleData = (
      cycles.structuredContent as {
        data: { cycles: string[]; truncated: boolean };
      }
    ).data;
    expect(cycleData.cycles).toHaveLength(1);
    expect(cycleData.cycles[0]).toBe("a.ts -> b.ts -> c.ts -> a.ts");
    expect(cycleData.truncated).toBeFalse();

    const explicit = await client.callTool({
      arguments: { file: "explicit.ts", hide_external: true, workspaceId },
      name: "deps",
    });
    expect(explicit.isError).not.toBeTrue();
    expect(explicit.structuredContent).toMatchObject({
      data: {
        items: [
          expect.objectContaining({
            ambiguous: false,
            from: "explicit.ts",
            to: "dual/foo.ts",
          }),
        ],
      },
    });

    const controller = new AbortController();
    controller.abort();
    await expect(
      client.callTool(
        { arguments: { text: "cancelled", workspaceId }, name: "squeeze" },
        { signal: controller.signal },
      ),
    ).rejects.toThrow();

    const squeezed = await client.callTool({
      arguments: { budget: 3, text: "éé" },
      name: "squeeze",
    });
    expect(squeezed.isError).not.toBeTrue();
    const squeezeData = (
      squeezed.structuredContent as {
        data: { text: string; truncated: boolean };
      }
    ).data;
    expect(squeezeData.text).toBe("é");
    expect(Buffer.byteLength(squeezeData.text)).toBeLessThanOrEqual(3);
    expect(squeezeData.truncated).toBeTrue();
  } finally {
    await client.close();
  }
});
