import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  clearConfigCache,
  globalConfigPath,
  resolveConfig,
} from "../../src/config";
import { sqlAssistanceOptionsSchema } from "../../src/runtime/sql-options-schema";

const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-sql-config-"));
  roots.push(root);
  await mkdir(path.join(root, ".git"));
  return {
    cwd: root,
    env: {},
    home: path.join(root, "home"),
    platform: "linux" as const,
  };
}

afterEach(async () => {
  clearConfigCache();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

test("SQL patch defaults need no dialect or validation policy", async () => {
  const options = await fixture();
  const config = await resolveConfig(options);
  expect(config.files.patch.sql).toEqual({});
  for (const field of ["dialect", "policy", "variant", "version"])
    expect(config.provenance[`files.patch.sql.${field}`]).toBeUndefined();
  expect(sqlAssistanceOptionsSchema.parse({})).toEqual({});
});

test("SQL selectors accept unimplemented dialects without enabling required validation", async () => {
  const options = await fixture();
  await writeFile(
    path.join(options.cwd, "ast-mcp.toml"),
    'version = 2\n[files.patch.sql]\ndialect = "Oracle"\nvariant = "vendor_ext"\nversion = "23ai"\n',
  );
  const config = await resolveConfig(options);
  expect(config.files.patch.sql).toEqual({
    dialect: "oracle",
    variant: "vendor_ext",
    version: "23ai",
  });
  expect(config.files.patch.sql?.policy).toBeUndefined();
  expect(config.provenance["files.patch.sql.dialect"]).toBe("project");
});

test("SQL defaults merge by leaf with global and project provenance", async () => {
  const options = await fixture();
  const global = globalConfigPath(options);
  await mkdir(path.dirname(global), { recursive: true });
  await writeFile(
    global,
    'version = 2\n[files.patch.sql]\npolicy = "required"\ndialect = "PostgreSQL"\nversion = "18"\nvariant = "base"\n',
  );
  await writeFile(
    path.join(options.cwd, "ast-mcp.toml"),
    'version = 2\n[files.patch.sql]\npolicy = "advisory"\nvariant = "extension"\n',
  );
  const config = await resolveConfig(options);
  expect(config.files.patch.sql).toEqual({
    policy: "advisory",
    dialect: "postgresql",
    version: "18",
    variant: "extension",
  });
  expect(config.provenance["files.patch.sql.policy"]).toBe("project");
  expect(config.provenance["files.patch.sql.variant"]).toBe("project");
  expect(config.provenance["files.patch.sql.dialect"]).toBe("global");
  expect(config.provenance["files.patch.sql.version"]).toBe("global");
  await writeFile(
    path.join(options.cwd, "ast-mcp.toml"),
    'version = 2\n[files.patch.sql]\npolicy = "skip"\n',
  );
  clearConfigCache();
  expect((await resolveConfig(options)).files.patch.sql).toEqual({
    policy: "skip",
    dialect: "postgresql",
    version: "18",
    variant: "base",
  });
});

test("changing configured SQL dialect clears inherited selectors and provenance", async () => {
  const options = await fixture();
  const global = globalConfigPath(options);
  await mkdir(path.dirname(global), { recursive: true });
  await writeFile(
    global,
    'version = 2\n[files.patch.sql]\npolicy = "required"\ndialect = "PostgreSQL"\nversion = "18"\nvariant = "plpgsql"\n',
  );
  const project = path.join(options.cwd, "ast-mcp.toml");
  await writeFile(
    project,
    'version = 2\n[files.patch.sql]\ndialect = "MySQL"\n',
  );
  const changed = await resolveConfig(options);
  expect(changed.files.patch.sql).toEqual({
    policy: "required",
    dialect: "mysql",
  });
  expect(changed.provenance["files.patch.sql.dialect"]).toBe("project");
  expect(changed.provenance["files.patch.sql.policy"]).toBe("global");
  expect(changed.provenance["files.patch.sql.version"]).toBeUndefined();
  expect(changed.provenance["files.patch.sql.variant"]).toBeUndefined();

  await writeFile(
    project,
    'version = 2\n[files.patch.sql]\ndialect = "POSTGRESQL"\n',
  );
  clearConfigCache();
  const retained = await resolveConfig(options);
  expect(retained.files.patch.sql).toEqual({
    policy: "required",
    dialect: "postgresql",
    version: "18",
    variant: "plpgsql",
  });
  expect(retained.provenance["files.patch.sql.version"]).toBe("global");
  expect(retained.provenance["files.patch.sql.variant"]).toBe("global");

  await writeFile(
    project,
    'version = 2\n[files.patch.sql]\ndialect = "MySQL"\nversion = "8.4"\nvariant = "vendor"\n',
  );
  clearConfigCache();
  const explicit = await resolveConfig(options);
  expect(explicit.files.patch.sql).toEqual({
    policy: "required",
    dialect: "mysql",
    version: "8.4",
    variant: "vendor",
  });
  expect(explicit.provenance["files.patch.sql.version"]).toBe("project");
  expect(explicit.provenance["files.patch.sql.variant"]).toBe("project");
});

test("SQL operation schema preserves explicit overrides and bounds selector input", () => {
  expect(
    sqlAssistanceOptionsSchema.parse({
      policy: "skip",
      dialect: "MySQL",
      version: "8.4",
      variant: "vendor-extension",
    }),
  ).toEqual({
    policy: "skip",
    dialect: "mysql",
    version: "8.4",
    variant: "vendor-extension",
  });
  for (const value of [
    { policy: "force" },
    { dialect: "" },
    { dialect: "../postgres" },
    { variant: "SELECT 1;" },
    { version: "18/../../source" },
    { dialect: "a".repeat(129) },
    { variant: "a".repeat(129) },
    { version: "1".repeat(129) },
    { unknown: true },
  ])
    expect(sqlAssistanceOptionsSchema.safeParse(value).success).toBeFalse();
});

test("invalid SQL configuration fails before becoming an effective policy", async () => {
  const options = await fixture();
  await writeFile(
    path.join(options.cwd, "ast-mcp.toml"),
    'version = 2\n[files.patch.sql]\npolicy = "force"\n',
  );
  await expect(resolveConfig(options)).rejects.toThrow();
});
