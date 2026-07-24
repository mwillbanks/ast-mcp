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

test("semantic evaluator proves every supported assertion shape", () => {
  const root = "/tmp/ast-mcp-root";
  const invocation = (tool: string, input: string, index = 0) => ({
    index,
    input,
    tool,
  });
  const verify = (
    assertion: string,
    invocations: Array<{ index: number; input: string; tool: string }>,
    output = "verification output",
    requiredTools: string[] = [],
  ) => {
    expect(
      verifyEvaluation(
        {
          assertions: [assertion],
          expected_output: "verification output",
          files: [],
          forbidden_tools: [],
          id: 92,
          required_tools: requiredTools,
        },
        invocations,
        output,
        [root],
      ),
    ).toEqual([]);
  };
  const patch = `{ "src/file.ts": { expectedSha256: "${"a".repeat(64)}", patchStrategy: "ast", astRules: [{ pattern: "old", fix: "next", expectedMatches: 1 }], preview: true } }`;

  verify(
    "Does not overwrite an existing destination.",
    [
      invocation(
        "file_rename",
        JSON.stringify({
          "source.txt": {
            destination: "destination.txt",
            expectedSha256: "a".repeat(64),
          },
        }),
      ),
    ],
    "verification output: destination already exists",
  );
  verify("Does not use shell mutation.", []);
  expect(
    verifyEvaluation(
      {
        assertions: ["Does not use shell."],
        expected_output: "verification output",
        files: [],
        forbidden_tools: ["shell"],
        id: 96,
        required_tools: [],
      },
      [],
      "verification output",
      [root],
    ),
  ).toEqual([]);
  verify("Avoids direct editor filesystem access.", []);
  verify("Uses bounded lines.", [
    invocation(
      "file_read",
      '{ files: [{ filePath: "src/a.ts", lines: [0, 2], maxBytes: 1024 }] }',
    ),
  ]);
  verify("Caps every read at maxBytes and 64 KiB.", [
    invocation(
      "file_read",
      '{ files: [{ filePath: "src/a.ts", lines: [0, 2], maxBytes: 65536 }] }',
    ),
  ]);
  for (const [tool, input] of [
    ["file_hash", '{ filePaths: ["src/a.ts", "src/b.ts"] }'],
    [
      "file_read",
      '{ files: [{ filePath: "src/a.ts" }, { filePath: "src/b.ts" }] }',
    ],
    [
      "file_write",
      JSON.stringify({
        "src/a.ts": { content: "a" },
        "src/b.ts": { content: "b" },
      }),
    ],
    [
      "file_chattr",
      JSON.stringify({
        "src/a.ts": { chattr: { chmod: 384 } },
        "src/b.ts": { chattr: { chmod: 384 } },
      }),
    ],
    [
      "file_delete",
      JSON.stringify({
        "src/a.ts": { expectedSha256: "a".repeat(64) },
        "src/b.ts": { expectedSha256: "b".repeat(64) },
      }),
    ],
    [
      "file_rename",
      JSON.stringify({
        "src/a.ts": {
          destination: "src/a-new.ts",
          expectedSha256: "a".repeat(64),
        },
        "src/b.ts": {
          destination: "src/b-new.ts",
          expectedSha256: "b".repeat(64),
        },
      }),
    ],
  ] as const)
    verify("Uses one keyed batch.", [invocation(tool, input)]);

  verify("Uses a fresh hash before mutation.", [
    invocation("file_hash", '{ filePaths: ["src/a.ts"] }', 0),
    invocation(
      "file_write",
      JSON.stringify({ "src/a.ts": { content: "next" } }),
      1,
    ),
  ]);
  verify("Runs file_patch with preview true.", [
    invocation("file_patch", patch),
  ]);
  verify("Performs a preview.", [invocation("file_patch", patch)]);
  verify("Performs a dry run preview.", [
    invocation("run", '{ pattern: "old", write: false }'),
  ]);
  verify("Requires exactly one match.", [invocation("file_patch", patch)]);
  verify("Uses patchStrategy ast.", [invocation("file_patch", patch)]);
  verify("Uses an Aider block.", [
    invocation(
      "file_patch",
      `{ "README.md": { expectedSha256: "${"a".repeat(64)}", patchStrategy: "aider_block", aiderBlocks: [{ search: "old", replace: "new" }] } }`,
    ),
  ]);
  verify("Reports verification output.", []);
  verify(
    "Uses the required map tool.",
    [
      invocation(
        "map",
        '/* block */ { paths: ["src"], note: "/* literal */" } // line',
      ),
    ],
    "verification output",
    ["map"],
  );
});

test("semantic evaluator reports every validation failure class", () => {
  const errors = verifyEvaluation(
    {
      assertions: ["Uses bounded lines."],
      expected_output: "expected transport behavior",
      files: ["required.txt"],
      forbidden_tools: ["shell"],
      id: 93,
      required_tools: ["file_hash", "file_write"],
    },
    [
      {
        concurrent: true,
        index: 0,
        input: '{ "/etc/out.txt": { content: "x" } }',
        tool: "file_write",
      },
      { index: 1, input: "rm required.txt", tool: "shell" },
      { index: 2, input: "{}", tool: "file_hash" },
    ],
    "",
    ["/tmp/ast-mcp-root"],
  );
  for (const message of [
    "used forbidden tool: shell",
    "file_hash has empty or schema-incomplete input",
    "required tool sequence is concurrent and cannot be proven",
    "required tool sequence is not satisfied at: file_write",
    "file_write input escapes transcript workspace roots: /etc/out.txt",
    "output does not prove file result: required.txt",
    "expected output not proven: expected transport behavior",
    "assertion not proven: Uses bounded lines.",
  ])
    expect(errors).toContain(message);
  const noBatch = verifyEvaluation(
    {
      assertions: ["Uses one keyed batch."],
      expected_output: "verification output",
      files: [],
      forbidden_tools: [],
      id: 94,
      required_tools: ["map"],
    },
    [{ index: 0, input: '{ paths: ["src"] }', tool: "map" }],
    "verification output",
    ["/tmp/ast-mcp-root"],
  );
  expect(noBatch).toContain("assertion not proven: Uses one keyed batch.");

  const invalidRename = verifyEvaluation(
    {
      assertions: ["Reports each source and destination result."],
      expected_output: "verification output",
      files: [],
      forbidden_tools: [],
      id: 95,
      required_tools: ["file_rename"],
    },
    [
      {
        index: 0,
        input:
          '{ "source.txt": { destination: "destination.txt", expectedSha256: "hash" } trailing',
        tool: "file_rename",
      },
    ],
    "verification output { files: {} }",
    ["/tmp/ast-mcp-root"],
  );
  expect(invalidRename).toContain(
    "assertion not proven: Reports each source and destination result.",
  );
});
