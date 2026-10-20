import { expect, test } from "bun:test";

import { migrateConfigSource } from "../src/config-migrate";

test("migration disables implicit formatting and reports the changed default", () => {
  const result = migrateConfigSource("version = 1\n", "/project/ast-mcp.toml");
  const parsed = Bun.TOML.parse(result.source) as {
    formatting: { enabled: boolean; fallback: string };
  };
  expect(parsed.formatting).toMatchObject({
    enabled: false,
    fallback: "preserve",
  });
  expect(result.warnings.join(" ")).toContain("defaults to disabled");
});

test.each([true, false])(
  "migration preserves explicit formatting.enabled=%s",
  (enabled) => {
    const result = migrateConfigSource(
      `version = 1\n[formatting]\nenabled = ${enabled}\n`,
      "/project/ast-mcp.toml",
    );
    expect(
      (Bun.TOML.parse(result.source) as { formatting: { enabled: boolean } })
        .formatting.enabled,
    ).toBe(enabled);
    expect(result.warnings).toEqual([]);
  },
);
