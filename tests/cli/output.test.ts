import { expect, spyOn, test } from "bun:test";

import {
  CliOutputUsageError,
  parseOutputArguments,
  renderCliOutput,
  selectOutputFormat,
  writeCliOutput,
} from "../../src/cli/output";

test("output options accept both forms anywhere and preserve command arguments", () => {
  expect(parseOutputArguments(["--output", "yaml", "config", "show"])).toEqual({
    args: ["config", "show"],
    output: "yaml",
  });
  expect(
    parseOutputArguments(["skills", "export", "dest", "--output=toml"]),
  ).toEqual({
    args: ["skills", "export", "dest"],
    output: "toml",
  });
  expect(parseOutputArguments(["config", "show"])).toEqual({
    args: ["config", "show"],
  });
  for (const args of [
    ["--output"],
    ["--output="],
    ["--output", "--help"],
    ["--output", "xml"],
    ["--output=JSON"],
    ["--output=json", "--output", "human"],
    ["--output", "human", "--output=yaml"],
  ])
    expect(() => parseOutputArguments(args)).toThrow(CliOutputUsageError);
});

test("stdout TTY selection respects configured defaults and explicit overrides", () => {
  const config = {
    cli: { output: { interactive: "human", nonInteractive: "json" } },
  } as const;
  expect(selectOutputFormat(config, undefined, true)).toBe("human");
  expect(selectOutputFormat(config, undefined, false)).toBe("json");
  expect(selectOutputFormat(config, "toml", true)).toBe("toml");
  expect(selectOutputFormat(config, "yaml", false)).toBe("yaml");
  expect(selectOutputFormat(config)).toBe(
    process.stdout.isTTY ? "human" : "json",
  );
  expect(
    selectOutputFormat(
      { cli: { output: { interactive: "yaml", nonInteractive: "toml" } } },
      undefined,
      false,
    ),
  ).toBe("toml");
});

test("native structured serializers preserve result fields and complete lines", () => {
  const result = {
    operation: "install",
    changed: ["config.toml"],
    service: { managed: false },
    count: 2,
    nested: [{ valid: true }],
  };
  expect(JSON.parse(renderCliOutput(result, "json", "Install"))).toEqual(
    result,
  );
  expect(Bun.YAML.parse(renderCliOutput(result, "yaml", "Install"))).toEqual(
    result,
  );
  expect(Bun.TOML.parse(renderCliOutput(result, "toml", "Install"))).toEqual(
    result,
  );
  for (const format of ["json", "yaml", "toml"] as const)
    expect(renderCliOutput(result, format, "Install")).toEndWith("\n");
});

test("human output displays readable sections and values", () => {
  const output = renderCliOutput(
    {
      projectRoot: "/project",
      valid: true,
      missing: null,
      absent: undefined,
      empty: [],
      nested_values: [{ filePath: "one.ts", changed: false }, ["two"]],
    },
    "human",
    "Configuration",
  );
  expect(output).toContain(
    "Configuration\n\nProject Root: /project\nValid: true",
  );
  expect(output).toContain("Missing: None");
  expect(output).not.toContain("Absent");
  expect(output).toContain("Empty:\n  None");
  expect(output).toContain("Nested values:\n  -\n    File Path: one.ts");
  expect(output).toContain("Changed: false");
  expect(output).toContain("- two");
});

test("TOML omits absent object fields recursively without dropping array positions", () => {
  const object = { absent: null, missing: undefined, kept: "yes" };
  const result = {
    absent: null,
    missing: undefined,
    nested: object,
    array: [object, { absent: undefined, kept: "two" }],
  };
  expect(Bun.TOML.parse(renderCliOutput(result, "toml", "Result"))).toEqual({
    nested: { kept: "yes" },
    array: [{ kept: "yes" }, { kept: "two" }],
  });
  expect(result.nested).toBe(object);
  expect(result.nested.absent).toBeNull();
  const timestamp = new Date("2026-01-01T00:00:00Z");
  expect(renderCliOutput({ timestamp }, "toml", "Result")).toContain(
    "2026-01-01T00:00:00Z",
  );
});

test("TOML rejects holes and unrepresentable array values with actionable locations", () => {
  for (const value of [null, undefined, () => {}, Symbol("fixture"), 1n]) {
    expect(() =>
      renderCliOutput({ nested: { values: [value] } }, "toml", "Result"),
    ).toThrow(/--output json or yaml/);
  }
  expect(() => renderCliOutput({ values: [null] }, "toml", "Result")).toThrow(
    "$.values[0]",
  );
  expect(() => renderCliOutput({ values: Array(1) }, "toml", "Result")).toThrow(
    "$.values[0]",
  );
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  expect(() => renderCliOutput(circular, "toml", "Result")).toThrow(
    "circular value at $.self",
  );
  expect(() => renderCliOutput({ value: 1n }, "toml", "Result")).toThrow(
    "Cannot render TOML output",
  );
  expect(() =>
    renderCliOutput({ value: new Date("invalid") }, "toml", "Result"),
  ).toThrow("--output json or yaml");
});

test("output writer keeps structured output on the selected stdout writer", () => {
  const chunks: string[] = [];
  writeCliOutput({ valid: true }, "json", "Result", (text) =>
    chunks.push(text),
  );
  expect(JSON.parse(chunks.join(""))).toEqual({ valid: true });
  const write = spyOn(process.stdout, "write").mockReturnValue(true);
  try {
    writeCliOutput({ valid: true }, "human", "Result");
    expect(write).toHaveBeenCalledWith("Result\n\nValid: true\n");
  } finally {
    write.mockRestore();
  }
});
