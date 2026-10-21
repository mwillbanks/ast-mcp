import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runSkillsCli, updateSkills } from "../../src/cli/skills";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function temporary() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-skill-cli-"));
  roots.push(root);
  return root;
}

for (const format of ["json", "yaml", "toml", "human"]) {
  test("skills update renders " + format, async () => {
    const root = await temporary();
    const output: string[] = [];
    await runSkillsCli(["update", root, "--output=" + format], {
      write: (text) => output.push(text),
    });
    const text = output.join("");
    if (format === "human") {
      expect(text).toContain("Skill update");
      expect(text).toContain("Written:");
      expect(text).toContain("SKILL.md");
    } else {
      const value =
        format === "json"
          ? JSON.parse(text)
          : format === "yaml"
            ? Bun.YAML.parse(text)
            : Bun.TOML.parse(text);
      expect(value).toMatchObject({
        operation: "update",
        destination: root,
        written: expect.arrayContaining(["SKILL.md"]),
        conflicts: [],
        updated: [],
        unchanged: [],
        obsolete: [],
        preserved: [],
      });
    }
    expect((await updateSkills(root)).unchanged).toContain("SKILL.md");
  });
}

test("conflicts render structured stdout and produce actionable stderr with a nonzero exit", async () => {
  const root = await temporary();
  await writeFile(path.join(root, "SKILL.md"), "custom instructions");
  const cli = path.resolve(import.meta.dir, "../../bin/ast-mcp.ts");
  const process = Bun.spawn(
    [Bun.which("bun")!, "run", cli, "skills", "update", root, "--output=json"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, exit] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  expect(exit).not.toBe(0);
  expect(JSON.parse(stdout)).toMatchObject({
    operation: "update",
    conflicts: ["SKILL.md"],
    preserved: ["SKILL.md"],
  });
  expect(stderr).toContain("Compare these files with a fresh export");
  expect(await readFile(path.join(root, "SKILL.md"), "utf8")).toBe(
    "custom instructions",
  );
});

test("in-process conflicts report preserved files before rejecting", async () => {
  const root = await temporary();
  await writeFile(path.join(root, "SKILL.md"), "custom");
  const output: string[] = [];
  await expect(
    runSkillsCli(["update", root, "--output=json"], {
      write: (text) => output.push(text),
    }),
  ).rejects.toThrow("reconcile them manually");
  expect(JSON.parse(output.join("")).conflicts).toEqual(["SKILL.md"]);
});

test("invalid update arguments and flags fail before creating a destination", async () => {
  const root = path.join(await temporary(), "absent");
  for (const args of [
    ["update"],
    ["update", root, "extra"],
    ["update", root, "--output=no"],
    ["update", root, "--output=json", "--output=human"],
  ]) {
    await expect(runSkillsCli(args)).rejects.toThrow();
    expect(await Bun.file(path.join(root, "SKILL.md")).exists()).toBeFalse();
  }
});
