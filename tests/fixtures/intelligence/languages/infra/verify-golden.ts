import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import {
  analyzeInfraLanguage,
  closeInfraLanguageWorker,
} from "../../../../../src/intelligence/languages/infra/index.ts";

const root = import.meta.dir;
const files = {
  bash: "bash.sh",
  fortran: "fortran.f90",
  hcl: "hcl.tf",
  powershell: "powershell.ps1",
  sql: "sql.sql",
  systemverilog: "systemverilog.sv",
  verilog: "verilog.v",
} as const;
const golden = JSON.parse(
  await readFile(`${root}/graphify-golden.json`, "utf8"),
);
const cases: Record<string, unknown> = {};
for (const [languageId, file] of Object.entries(files))
  cases[languageId] = await analyzeInfraLanguage({
    languageId: languageId as keyof typeof files,
    source: await readFile(`${root}/${file}`, "utf8"),
  });
await closeInfraLanguageWorker();
assert.deepEqual(cases, golden.cases);
