import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  testDurations,
  runDurationReport,
} from "../../scripts/testing/test-durations";

const report = (suites: string, failures = 0) =>
  '<testsuites failures="' + failures + '">' + suites + "</testsuites>";
test("converts complete successful durations to deterministic positive weights", () => {
  const xml = report(
    '<testsuite file="tests/z.test.ts" time="0"/><testsuite file="tests/a&amp;b.test.ts" time="1.2345"/>',
  );
  expect(
    testDurations(xml, ["tests/z.test.ts", "tests/a&b.test.ts"]).files,
  ).toEqual({ "tests/a&b.test.ts": 1235, "tests/z.test.ts": 1 });
});
test("rejects missing duplicate failed unknown and invalid measurements", () => {
  for (const xml of [
    "",
    report(""),
    "<other/>",
    "junk" + report('<testsuite file="a" time="1"/>'),
    report('<testsuite file="a" time="1" time="2"/>'),
    '<testsuites failures="0" errors="1"><testsuite file="a" time="1"/></testsuites>',
    '<testsuites failures="0"><testsuite file="a" time="1">',
    '<testsuites failures="0"><testsuite file="a" time="1"></testsuites>',
    report('<testsuite file="a" time=""/>'),
    report('<testsuite file="a" time=" "/>'),
    report('<testsuite file="a" time="1"><error/></testsuite>'),
    report('<testsuite file="a" time="1" errors="1"/>'),
    report('<testsuite file="a" time="1"/>', 1),
    report('<testsuite file="other" time="1"/>'),
    report('<testsuite file="a" time="NaN"/>'),
    report('<testsuite file="a" time="-1"/>'),
    report('<testsuite file="a" time="1"/><testsuite file="a" time="2"/>'),
  ])
    expect(() => testDurations(xml, ["a"])).toThrow();
});

test("uses inclusive file durations without double-counting nested describes", () => {
  expect(
    testDurations(
      report(
        '<testsuite file="a" time="1"><testsuite file="a" time="0.9"/></testsuite>',
      ),
      ["a"],
    ).files,
  ).toEqual({ a: 1000 });
});

test("measurement command validates arguments and emits checked inventory", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "ast-mcp-duration-command-"),
  );
  try {
    await mkdir(path.join(root, "tests"));
    await mkdir(path.join(root, "templates"));
    await writeFile(path.join(root, "tests/a.test.ts"), "export {};");
    const input = path.join(root, "report.xml");
    await writeFile(
      input,
      report('<testsuite file="tests/a.test.ts" time="1"/>'),
    );
    const output: string[] = [];
    await runDurationReport([input], root, (line) => output.push(line));
    expect(JSON.parse(output[0]).files).toEqual({ "tests/a.test.ts": 1000 });
    await expect(runDurationReport([], root)).rejects.toThrow("Usage");
    await expect(runDurationReport([input, input], root)).rejects.toThrow(
      "Usage",
    );
    await expect(
      runDurationReport([path.join(root, "missing")], root),
    ).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
