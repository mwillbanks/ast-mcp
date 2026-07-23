import { expect, test } from "bun:test";
import { verifyEvaluation } from "./semantic";

const evaluation = {
  assertions: ["Reports each source and destination result."],
  expected_output: "reports each source and destination result",
  files: [],
  forbidden_tools: [],
  id: 91,
  required_tools: ["file_rename"],
};

test("rename evaluator accepts root-relative runtime results", () => {
  const errors = verifyEvaluation(
    evaluation,
    [
      {
        index: 0,
        input: JSON.stringify({
          "source.txt": { destination: "renamed.txt", expectedSha256: "hash" },
        }),
        tool: "file_rename",
      },
    ],
    JSON.stringify({
      files: {
        "/tmp/ast-mcp-root/source.txt": {
          destinationPath: "/tmp/ast-mcp-root/renamed.txt",
          renamed: true,
        },
      },
    }),
    ["/tmp/ast-mcp-root"],
  );
  expect(errors).toEqual([]);
});

test("rename evaluator rejects incomplete per-file results", () => {
  const errors = verifyEvaluation(
    evaluation,
    [
      {
        index: 0,
        input: JSON.stringify({
          "/tmp/ast-mcp-root/one.txt": {
            destination: "/tmp/ast-mcp-root/one-new.txt",
            expectedSha256: "hash",
          },
          "/tmp/ast-mcp-root/two.txt": {
            destination: "/tmp/ast-mcp-root/two-new.txt",
            expectedSha256: "hash",
          },
        }),
        tool: "file_rename",
      },
    ],
    JSON.stringify({
      files: {
        "/tmp/ast-mcp-root/one.txt": {
          destinationPath: "/tmp/ast-mcp-root/wrong.txt",
          renamed: true,
        },
      },
    }),
    ["/tmp/ast-mcp-root"],
  );
  expect(
    errors.some((error) => error.includes("assertion not proven")),
  ).toBeTrue();
});

test("rename evaluator rejects xargs and busybox wrappers", () => {
  const negative = {
    ...evaluation,
    assertions: ["Does not use shell mv or a direct editor for renaming."],
    expected_output: "Does not use shell mv",
    required_tools: [],
  };
  for (const source of [
    "xargs mv source destination",
    "busybox mv source destination",
  ]) {
    const errors = verifyEvaluation(
      negative,
      [{ index: 0, input: source, tool: "shell" }],
      "blocked",
      ["/tmp/ast-mcp-root"],
    );
    expect(
      errors.some((error) => error.includes("assertion not proven")),
    ).toBeTrue();
  }
});
