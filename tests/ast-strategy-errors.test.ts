import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as astBroClient from "../src/ast-bro/client";
import { astStrategy } from "../src/patch/strategy/ast";

test("AST strategy returns structured preview diagnostics", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-ast-preview-"));
  const filePath = path.join(folder, "value.ts");
  await writeFile(filePath, "export const value = 1;\n");
  const call = spyOn(astBroClient, "callAstBro").mockResolvedValue({
    content: [
      {
        text: JSON.stringify({
          error_count: 1,
          errors: [{ message: "invalid preview" }],
          matches: [],
          schema: "ast-bro.run.v1",
        }),
        type: "text",
      },
    ],
  } as never);

  try {
    await expect(
      astStrategy.prepare({
        aiderBlocks: [],
        astRules: [
          {
            fix: "export const value = 2",
            pattern: "export const value = 1",
          },
        ],
        capabilities: {
          effective: {
            aiderMatchers: [
              "exact",
              "whitespace",
              "relative-indentation",
              "diff-match-patch",
            ],
            patch: ["ast", "aider_block"],
            read: ["ast", "text"],
          },
          filePath,
          generation: 1,
          intrinsic: {
            patch: ["ast", "aider_block"],
            read: ["ast", "text"],
            search: ["ast"],
          },
          kind: "source",
          language: "typescript",
          parseErrorCount: 0,
          parseStatus: "parseable",
          size: 24,
        },
        filePath,
        language: "typescript",
        mode: 0o644,
        original: "export const value = 1;\n",
      }),
    ).rejects.toMatchObject({
      code: "ast_preview_error",
      details: { errors: [{ message: "invalid preview" }] },
      retryable: true,
      suggestedNextCall: "run",
    });
  } finally {
    call.mockRestore();
    await rm(folder, { force: true, recursive: true });
  }
});
