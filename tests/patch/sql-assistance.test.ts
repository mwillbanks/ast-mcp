import { expect, test } from "bun:test";
import { spyOn } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { currentConfig, withConfig } from "../../src/config";
import { patchFile, patchFiles } from "../../src/patch/engine";
import { applyConfigCore } from "../../src/runtime/config-write";
import { inspectFileCapabilities } from "../../src/runtime/file-capabilities";
import { sha256 } from "../../src/runtime/hash";
import {
  sqlAdapterRegistry,
  type SqlPatchDecision,
} from "../../src/runtime/sql-assistance";
import { hermeticConfig } from "../support/hermetic-config";

const dialect = "patch-policy-fixture";
let loads = 0;
sqlAdapterRegistry.register(dialect, async () => {
  loads += 1;
  return {
    id: "patch-fixture",
    version: "1",
    async validate({ source }) {
      return {
        status: source.includes("SELECT FROM") ? "invalid" : "valid",
        complete: true,
        scope: "sql",
      };
    },
  };
});

async function project(
  work: (root: string, source: string, file: string) => Promise<void>,
  extra = "",
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-sql-patch-"));
  const source = "SELECT 1;\n";
  const file = path.join(root, "migration.sql");
  await writeFile(
    path.join(root, "ast-mcp.toml"),
    `version = 2
[mcp.configuration]
require_approval = false
${extra}
[[paths]]
id = "workspace"
path = "."
policies = { read = "allow", write = "allow" }
`,
  );
  await writeFile(file, source);
  try {
    await withConfig(hermeticConfig(root), () => work(root, source, file));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

function sqlFormatterConfiguration(
  policy: "advisory" | "required",
  script = 'process.stdout.write("SELECT FROM;\\n")',
) {
  return `[files.patch.sql]
policy = "${policy}"
dialect = "${dialect}"
[formatting]
enabled = true
fallback = "reject"
[[formatting.formatters]]
id = "sql-fixture"
extensions = [".sql"]
command = ${JSON.stringify(process.execPath)}
args = ["-e", ${JSON.stringify(script)}, "{source_file}"]
mode = "stdout"
`;
}

async function expectNoCandidates(root: string) {
  expect(
    (await readdir(root)).filter(
      (name) =>
        (name.endsWith(".sql") && name.includes(".ast-mcp-")) ||
        name.startsWith(".ast-mcp-format-"),
    ),
  ).toEqual([]);
}

function result(batch: Record<string, unknown>, file: string) {
  return (
    batch.files as Record<
      string,
      { sql: SqlPatchDecision; previewReceipt: string }
    >
  )[file]!;
}

test("SQL preview and receipt commit allow generic grammar recovery without dialect selection", async () => {
  await project(async (_root, source, file) => {
    const before = loads;
    const originalCapabilities = await inspectFileCapabilities(file);
    const replacement =
      "CREATE POLICY member_access ON public.members FOR SELECT USING (true);";
    const preview = result(
      await patchFiles({
        [file]: {
          expectedSha256: sha256(source),
          patchStrategy: "aider_block",
          aiderBlocks: [{ search: "SELECT 1;", replace: replacement }],
          preview: true,
        },
      }),
      file,
    );
    expect(preview.sql.validation.status).toBe("not_requested");
    expect(await readFile(file, "utf8")).toBe(source);
    const committed = result(
      await patchFiles({
        [file]: {
          expectedSha256: sha256(source),
          previewReceipt: preview.previewReceipt,
        },
      }),
      file,
    );
    expect(committed.sql.validation.status).toBe("not_requested");
    expect(await readFile(file, "utf8")).toBe(replacement + "\n");
    expect(
      (await inspectFileCapabilities(file)).parseErrorCount!,
    ).toBeGreaterThan(originalCapabilities.parseErrorCount!);
    expect(loads).toBe(before);
  });
});

test("explicit advisory unknown SQL assistance does not block patching", async () => {
  await project(async (_root, source, file) => {
    const committed = result(
      await patchFiles({
        [file]: {
          expectedSha256: sha256(source),
          patchStrategy: "aider_block",
          aiderBlocks: [
            { search: "SELECT 1", replace: "SELECT custom_extension()" },
          ],
          sql: { dialect: "unsupported-fixture" },
        },
      }),
      file,
    );
    expect(committed.sql).toMatchObject({
      allowed: true,
      policy: "advisory",
      validation: { status: "unsupported" },
    });
    expect(await readFile(file, "utf8")).toBe("SELECT custom_extension();\n");
  });
});

test("required SQL failures reject without replacement and agent skip overrides the configured default", async () => {
  await project(
    async (root, source, file) => {
      const entry = {
        expectedSha256: sha256(source),
        patchStrategy: "aider_block" as const,
        aiderBlocks: [{ search: "SELECT 1;", replace: "SELECT FROM;" }],
      };
      await expect(patchFiles({ [file]: entry })).rejects.toMatchObject({
        code: "sql_validation_rejected",
      });
      expect(await readFile(file, "utf8")).toBe(source);
      const before = loads;
      const changed = result(
        await patchFiles({ [file]: { ...entry, sql: { policy: "skip" } } }),
        file,
      );
      expect(changed.sql).toMatchObject({
        policy: "skip",
        overridden: true,
        validation: { status: "skipped" },
      });
      expect(await readFile(file, "utf8")).toBe("SELECT FROM;\n");
      expect(loads).toBe(before);
      expect(
        (await readdir(root)).filter(
          (name) =>
            name.startsWith("migration.ast-mcp-") ||
            name.startsWith(".ast-mcp-format-"),
        ),
      ).toEqual([]);
    },
    `[files.patch.sql]
policy = "required"
dialect = "${dialect}"
`,
  );
});

test("required missing adapters reject while explicit advisory policy permits the operation", async () => {
  await project(
    async (_root, source, file) => {
      const entry = {
        expectedSha256: sha256(source),
        patchStrategy: "aider_block" as const,
        aiderBlocks: [{ search: "SELECT 1", replace: "SELECT 2" }],
      };
      await expect(patchFiles({ [file]: entry })).rejects.toMatchObject({
        code: "sql_validation_rejected",
      });
      expect(await readFile(file, "utf8")).toBe(source);
      const changed = result(
        await patchFiles({ [file]: { ...entry, sql: { policy: "advisory" } } }),
        file,
      );
      expect(changed.sql).toMatchObject({
        allowed: true,
        policy: "advisory",
        overridden: true,
        validation: { status: "unsupported" },
      });
      expect(await readFile(file, "utf8")).toBe("SELECT 2;\n");
    },
    `[files.patch.sql]
policy = "required"
dialect = "unknown-fixture"
`,
  );
});

test("receipt SQL policy is copied and supplied policy changes require a fresh preview", async () => {
  await project(async (_root, source, file) => {
    const sql = { policy: "required" as "required" | "skip", dialect };
    const preview = result(
      await patchFiles({
        [file]: {
          expectedSha256: sha256(source),
          patchStrategy: "aider_block",
          aiderBlocks: [{ search: "SELECT 1", replace: "SELECT 2" }],
          sql,
          preview: true,
        },
      }),
      file,
    );
    sql.policy = "skip";
    await expect(
      patchFiles({
        [file]: {
          expectedSha256: sha256(source),
          previewReceipt: preview.previewReceipt,
          sql,
        },
      }),
    ).rejects.toMatchObject({ code: "preview_receipt_sql_changed" });
    expect(await readFile(file, "utf8")).toBe(source);
    const committed = result(
      await patchFiles({
        [file]: {
          expectedSha256: sha256(source),
          previewReceipt: preview.previewReceipt,
        },
      }),
      file,
    );
    expect(committed.sql).toMatchObject({
      policy: "required",
      validation: { status: "valid" },
    });
    expect(await readFile(file, "utf8")).toBe("SELECT 2;\n");
  });
});

for (const patch of [
  { aider_matchers: ["exact" as const] },
  { strategies: ["aider_block" as const] },
  { sql: { policy: "required" as const, dialect } },
]) {
  test(
    "SQL receipts invalidate after effective patch defaults change " +
      JSON.stringify(patch),
    async () => {
      await project(async (root, source, file) => {
        const before = (await currentConfig()).files.patch;
        const preview = result(
          await patchFiles({
            [file]: {
              expectedSha256: sha256(source),
              patchStrategy: "aider_block",
              aiderBlocks: [{ search: "SELECT 1", replace: "SELECT 2" }],
              preview: true,
            },
          }),
          file,
        );
        await applyConfigCore({ files: { patch } });
        await withConfig(hermeticConfig(root), async () => {
          expect((await currentConfig()).files.patch).not.toEqual(before);
          await expect(
            patchFiles({
              [file]: {
                expectedSha256: sha256(source),
                previewReceipt: preview.previewReceipt,
              },
            }),
          ).rejects.toMatchObject({
            code: "preview_receipt_configuration_changed",
          });
        });
        expect(await readFile(file, "utf8")).toBe(source);
      });
    },
  );
}

test("formatter candidates use the same required SQL policy before replacement", async () => {
  await project(async (_root, source, file) => {
    const preview = result(
      await patchFiles({
        [file]: {
          expectedSha256: sha256(source),
          patchStrategy: "aider_block",
          aiderBlocks: [{ search: "SELECT 1", replace: "SELECT 2" }],
          preview: true,
        },
      }),
      file,
    );
    expect(preview.sql.validation.status).toBe("valid");
    await expect(
      patchFiles({
        [file]: {
          expectedSha256: sha256(source),
          previewReceipt: preview.previewReceipt,
        },
      }),
    ).rejects.toMatchObject({ code: "sql_validation_rejected" });
    expect(await readFile(file, "utf8")).toBe(source);
  }, sqlFormatterConfiguration("required"));
});

test("SQL overrides never suppress TypeScript or document validation", async () => {
  await project(async (root) => {
    const file = path.join(root, "value.ts");
    const source = "const value = 1;\n";
    await writeFile(file, source);
    await expect(
      patchFiles({
        [file]: {
          expectedSha256: sha256(source),
          patchStrategy: "aider_block",
          aiderBlocks: [{ search: source, replace: "const = ;\n" }],
          sql: { policy: "skip" },
        },
      }),
    ).rejects.toMatchObject({ code: "sql_assistance_not_applicable" });
    expect(await readFile(file, "utf8")).toBe(source);
    await expect(
      patchFiles({
        [file]: {
          expectedSha256: sha256(source),
          patchStrategy: "aider_block",
          aiderBlocks: [{ search: source, replace: "const = ;\n" }],
        },
      }),
    ).rejects.toMatchObject({ code: "candidate_parse_error" });
    expect(await readFile(file, "utf8")).toBe(source);
  });
});

for (const initiallyAvailable of [true, false]) {
  test(
    "SQL receipt rejects validator availability changes from " +
      initiallyAvailable,
    async () => {
      const selectedDialect = "receipt-availability-" + initiallyAvailable;
      let available = initiallyAvailable;
      sqlAdapterRegistry.register(selectedDialect, async () => {
        if (!available) throw new Error("validator unavailable");
        return {
          id: "availability-fixture",
          version: "1",
          async validate() {
            return { status: "valid", complete: true, scope: "sql" };
          },
        };
      });
      await project(async (_root, source, file) => {
        const preview = result(
          await patchFiles({
            [file]: {
              expectedSha256: sha256(source),
              patchStrategy: "aider_block",
              aiderBlocks: [{ search: "SELECT 1", replace: "SELECT 2" }],
              sql: { dialect: selectedDialect },
              preview: true,
            },
          }),
          file,
        );
        expect(preview.sql.validation.status).toBe(
          initiallyAvailable ? "valid" : "unavailable",
        );
        available = !initiallyAvailable;
        await expect(
          patchFiles({
            [file]: {
              expectedSha256: sha256(source),
              previewReceipt: preview.previewReceipt,
            },
          }),
        ).rejects.toMatchObject({ code: "preview_receipt_sql_changed" });
        expect(await readFile(file, "utf8")).toBe(source);
        available = false;
        const direct = result(
          await patchFiles({
            [file]: {
              expectedSha256: sha256(source),
              patchStrategy: "aider_block",
              aiderBlocks: [{ search: "SELECT 1", replace: "SELECT 2" }],
              sql: { dialect: selectedDialect },
            },
          }),
          file,
        );
        expect(direct.sql.validation.status).toBe("unavailable");
        expect(await readFile(file, "utf8")).toBe(source.replace("1", "2"));
      });
    },
  );
}

for (const policy of ["required", "skip"] as const) {
  test(
    "SQL receipt preserves " + policy + " behavior when its loader fails",
    async () => {
      const selectedDialect = "receipt-loader-" + policy;
      let available = true;
      let invocations = 0;
      sqlAdapterRegistry.register(selectedDialect, async () => {
        invocations += 1;
        if (!available) throw new Error("validator unavailable");
        return {
          id: "loader-fixture",
          version: "1",
          async validate() {
            return { status: "valid", complete: true, scope: "sql" };
          },
        };
      });
      await project(async (_root, source, file) => {
        const preview = result(
          await patchFiles({
            [file]: {
              expectedSha256: sha256(source),
              patchStrategy: "aider_block",
              aiderBlocks: [{ search: "SELECT 1", replace: "SELECT 2" }],
              sql: { policy, dialect: selectedDialect },
              preview: true,
            },
          }),
          file,
        );
        available = false;
        const commit = patchFiles({
          [file]: {
            expectedSha256: sha256(source),
            previewReceipt: preview.previewReceipt,
          },
        });
        if (policy === "required") {
          await expect(commit).rejects.toMatchObject({
            code: "sql_validation_rejected",
          });
          expect(await readFile(file, "utf8")).toBe(source);
        } else {
          expect(result(await commit, file).sql.validation.status).toBe(
            "skipped",
          );
          expect(invocations).toBe(0);
          expect(await readFile(file, "utf8")).toBe(source.replace("1", "2"));
        }
      });
    },
  );
}

for (const repair of [false, true]) {
  test(
    "SQL patches accept " +
      (repair ? "fewer" : "equal") +
      " recovery counts on invalid originals",
    async () => {
      await project(async (_root, _source, file) => {
        const original = repair
          ? "CREATE POLICY member_access ON public.members USING (\n"
          : "CREATE POLICY member_access ON public.members FOR SELECT USING (true);\n";
        const candidate = repair
          ? "SELECT 2;\n"
          : original.replace("member_access", "renamed_access");
        await writeFile(file, original);
        const before = await inspectFileCapabilities(file);
        expect(before.parseErrorCount).toBeGreaterThan(0);
        const changed = result(
          await patchFiles({
            [file]: {
              expectedSha256: sha256(original),
              patchStrategy: "aider_block",
              aiderBlocks: [{ search: original, replace: candidate }],
            },
          }),
          file,
        );
        const after = await inspectFileCapabilities(file);
        if (repair)
          expect(after.parseErrorCount!).toBeLessThan(before.parseErrorCount!);
        else expect(after.parseErrorCount).toBe(before.parseErrorCount);
        expect(changed.sql.validation.status).toBe("not_requested");
        expect(await readFile(file, "utf8")).toBe(candidate);
      });
    },
  );
}

test("expired SQL preview receipts reject without replacement", async () => {
  await project(async (_root, source, file) => {
    const preview = result(
      await patchFiles({
        [file]: {
          expectedSha256: sha256(source),
          patchStrategy: "aider_block",
          aiderBlocks: [{ search: "SELECT 1", replace: "SELECT 2" }],
          sql: { policy: "required", dialect },
          preview: true,
        },
      }),
      file,
    );
    const expiredAt = Date.now() + 6 * 60 * 1000;
    const clock = spyOn(Date, "now").mockReturnValue(expiredAt);
    try {
      await expect(
        patchFiles({
          [file]: {
            expectedSha256: sha256(source),
            previewReceipt: preview.previewReceipt,
          },
        }),
      ).rejects.toMatchObject({ code: "preview_receipt_expired" });
      expect(await readFile(file, "utf8")).toBe(source);
    } finally {
      clock.mockRestore();
    }
  });
});

for (const policy of ["advisory", "skip", "not_requested"] as const) {
  test("formatter SQL errors respect " + policy + " policy", async () => {
    await project(async (root, source, file) => {
      const before = loads;
      const changed = result(
        await patchFiles({
          [file]: {
            expectedSha256: sha256(source),
            patchStrategy: "aider_block",
            aiderBlocks: [{ search: "SELECT 1", replace: "SELECT 2" }],
            ...(policy === "not_requested" ? {} : { sql: { policy } }),
          },
        }),
        file,
      );
      expect(changed.sql.validation.status).toBe(
        policy === "advisory"
          ? "invalid"
          : policy === "skip"
            ? "skipped"
            : "not_requested",
      );
      if (policy !== "advisory") expect(loads).toBe(before);
      expect(await readFile(file, "utf8")).toBe("SELECT FROM;\n");
      await expectNoCandidates(root);
    }, sqlFormatterConfiguration("advisory"));
  });
}

test("later required SQL formatter rejection rolls back earlier batch commits", async () => {
  const script = `const source = await Bun.stdin.text();
if (process.argv[1].endsWith("z-later.sql")) {
  if ((await Bun.file(process.argv[1].replace("z-later.sql", "migration.sql")).text()) !== "SELECT 2;\\n")
    throw new Error("earlier file did not commit");
  process.stdout.write("SELECT FROM;\\n");
} else process.stdout.write(source);`;
  await project(
    async (root, source, file) => {
      const later = path.join(root, "z-later.sql");
      await writeFile(later, source);
      const request = {
        expectedSha256: sha256(source),
        patchStrategy: "aider_block" as const,
        aiderBlocks: [{ search: "SELECT 1", replace: "SELECT 2" }],
      };
      await expect(
        patchFiles({ [file]: request, [later]: request }),
      ).rejects.toMatchObject({ code: "sql_validation_rejected" });
      expect(await readFile(file, "utf8")).toBe(source);
      expect(await readFile(later, "utf8")).toBe(source);
      await expectNoCandidates(root);
      const retry = result(await patchFiles({ [file]: request }), file);
      expect(retry.sql.validation.status).toBe("valid");
    },
    sqlFormatterConfiguration("required", script),
  );
});

test("the single-file API forwards optional SQL policy", async () => {
  await project(async (_root, source, file) => {
    const changed = await patchFile({
      filePath: file,
      expectedSha256: sha256(source),
      patchStrategy: "aider_block",
      aiderBlock: { search: "SELECT 1", replace: "SELECT 2" },
      sql: { policy: "skip" },
    });
    expect(changed.sql).toMatchObject({
      policy: "skip",
      validation: { status: "skipped" },
    });
    expect(await readFile(file, "utf8")).toBe("SELECT 2;\n");
  });
});

test("a caller cannot mutate a pending batch SQL policy or patch operations", async () => {
  await project(async (_root, source, file) => {
    const sql = { policy: "required" as "required" | "skip", dialect };
    const blocks = [{ search: "SELECT 1", replace: "SELECT 2" }];
    const pending = patchFiles({
      [file]: {
        expectedSha256: sha256(source),
        patchStrategy: "aider_block",
        aiderBlocks: blocks,
        sql,
      },
    });
    sql.policy = "skip";
    blocks[0]!.replace = "SELECT FROM";
    const changed = result(await pending, file);
    expect(changed.sql).toMatchObject({
      policy: "required",
      validation: { status: "valid" },
    });
    expect(await readFile(file, "utf8")).toBe("SELECT 2;\n");
  });
});

for (const [index, section] of [
  '[files.patch]\nsql = { dialect = "mysql", version = "8", variant = "mariadb" }',
  '[files.patch.sql]\ndialect = "mysql"\nversion = "8"\nvariant = "mariadb"',
].entries()) {
  test(
    "config_core merges SQL defaults without synthesized policy representation " +
      index,
    async () => {
      await project(async (root) => {
        await applyConfigCore({
          files: { patch: { sql: { dialect: "postgresql" } } },
        });
        const config = await withConfig(hermeticConfig(root), currentConfig);
        expect(config.files.patch.sql).toEqual({ dialect: "postgresql" });
        expect(config.provenance["files.patch.sql.dialect"]).toBe("project");
        for (const key of ["policy", "version", "variant"]) {
          expect(config.provenance[`files.patch.sql.${key}`]).toBeUndefined();
        }
        const saved = Bun.TOML.parse(
          await readFile(path.join(root, "ast-mcp.toml"), "utf8"),
        ) as { files: { patch: { sql: unknown } } };
        expect(saved.files.patch.sql).toEqual({ dialect: "postgresql" });
      }, section + "\n");
    },
  );
}

test("config_core updates SQL defaults without overwriting sibling patch settings", async () => {
  await project(async (root, source, file) => {
    await applyConfigCore({
      files: { patch: { sql: { policy: "required", dialect } } },
    });
    await withConfig(hermeticConfig(root), async () => {
      expect((await currentConfig()).files.patch).toMatchObject({
        sql: { policy: "required", dialect },
        aiderMatchers: [
          "exact",
          "whitespace",
          "relative-indentation",
          "diff-match-patch",
        ],
      });
      await expect(
        patchFiles({
          [file]: {
            expectedSha256: sha256(source),
            patchStrategy: "aider_block",
            aiderBlocks: [{ search: "SELECT 1;", replace: "SELECT FROM;" }],
          },
        }),
      ).rejects.toMatchObject({ code: "sql_validation_rejected" });
    });
    expect(await readFile(file, "utf8")).toBe(source);
  });
});
