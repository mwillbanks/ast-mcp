import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  checkUnitTiming,
  checkUnitTimingSource,
  runUnitTiming,
} from "../../scripts/validation/check-unit-timing";
import cases from "../fixtures/unit-timing-cases.json";

test("rejects ambient timing aliases imports and computed members", () => {
  const forbidden = cases.rejected;
  for (const source of forbidden)
    expect(
      checkUnitTimingSource("fixture.test.ts", source).length,
      source,
    ).toBeGreaterThan(0);
});

test("allows fixed dates mock clocks and locally shadowed names", () => {
  const allowed = cases.accepted;
  for (const source of allowed)
    expect(checkUnitTimingSource("fixture.test.ts", source), source).toEqual(
      [],
    );
});

test("rejects indirect imports through shared helpers and fixture reexports", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-timing-lint-"));
  try {
    await mkdir(path.join(root, "templates"));
    for (const [file, content] of Object.entries(cases.indirect)) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), content);
    }
    const violations = await checkUnitTiming(root);
    const diagnostics: string[] = [];
    expect(await runUnitTiming(root, (line) => diagnostics.push(line))).toBe(1);
    expect(diagnostics.every((line) => /:\d+: /.test(line))).toBeTrue();
    expect(
      violations.some((value) =>
        value.message.includes("integration fixtures"),
      ),
    ).toBeTrue();
    expect(
      violations.some((value) =>
        value.file.replaceAll("\\", "/").endsWith("fixtures/wrapper.ts"),
      ),
    ).toBeTrue();
    for (const suffix of [
      "website/tests/direct.test.tsx",
      "templates/direct.test.mts",
      "website/tests/helpers/timing.tsx",
      "templates/support/timing.mts",
    ]) {
      expect(
        violations.some((value) =>
          value.file.replaceAll("\\", "/").endsWith(suffix),
        ),
      ).toBeTrue();
    }
    for (const suffix of [
      "fixtures/web-helper.tsx",
      "fixtures/template-helper.mts",
    ]) {
      expect(
        violations.some(
          (value) =>
            value.file.replaceAll("\\", "/").endsWith(suffix) &&
            value.message.includes("integration fixtures"),
        ),
      ).toBeTrue();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
