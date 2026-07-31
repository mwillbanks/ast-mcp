import { expect, test } from "bun:test";
import { checkMarkdown } from "../scripts/check-prose";

test("enforces ASD-STE100 sentence limits and active voice", () => {
  expect(checkMarkdown("guide.md", "Run this clear command now.")).toEqual([]);
  expect(
    checkMarkdown(
      "guide.md",
      "Run one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen.",
    ),
  ).toEqual([]);
  expect(
    checkMarkdown(
      "guide.md",
      "Run one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty.",
    )[0]?.message,
  ).toContain("limit is 20");
  expect(
    checkMarkdown("guide.md", "Run the command after it is configured."),
  ).toContainEqual(
    expect.objectContaining({
      message: "Procedural sentence uses passive voice.",
    }),
  );
});

test("excludes non-prose Markdown surfaces", () => {
  const source = [
    "---",
    "description: This frontmatter sentence is intentionally longer than every supported descriptive limit in the checker implementation.",
    "---",
    "```text",
    "Run this deliberately oversized procedural sentence with many extra words that the checker must ignore inside code blocks.",
    "```",
    "| This table contains a deliberately oversized descriptive sentence that the checker must ignore completely. |",
    "`ast-mcp install --scope local --target all --with-a-very-long-command`",
    "https://example.com/a/very/long/url/that/is/not/prose",
  ].join("\n");
  expect(checkMarkdown("guide.md", source)).toEqual([]);
  expect(
    checkMarkdown(
      "/evals/prompt.md",
      "Run a very long evaluation prompt that would otherwise exceed the procedural sentence limit by adding many unnecessary words here.",
    ),
  ).toEqual([]);
});
