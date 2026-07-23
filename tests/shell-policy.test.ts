import { expect, test } from "bun:test";
import { embeddedShellMutates, shellMutates } from "../src/shell-policy";

const skillPolicyPath = "../templates/skills/ast-mcp/evals/" + "shell-policy";
const {
  embeddedShellMutates: skillEmbeddedShellMutates,
  shellMutates: skillShellMutates,
} = await import(skillPolicyPath);

for (const command of [
  "touch blocked",
  "rm blocked",
  "mv before after",
  "patch < change.diff",
  "find . -delete",
  "find . -exec touch {} ;",
  "xargs rm",
  "bash -c 'rm blocked'",
  "bash -lc 'rm blocked'",
  "env -S \"bash -lc 'rm blocked'\"",
  "env FOO=bar bash -c 'rm blocked'",
  "echo $(touch blocked)",
  "sudo --user bob touch blocked",
  "doas -u user touch blocked",
  "env -u PATH touch blocked",
  "timeout 5 touch blocked",
  'bun -e \'Bun.write("blocked", "x")\'',
  'python3.11 -c \'open("blocked", "w").write("x")\'',
  'python3.11 -c \'open("blocked", mode="w").write("x")\'',
  'node -e \'require("fs").openSync("blocked", "w")\'',
  'node -e \'require("fs").renameSync("before", "after")\'',
  "sed -i s/a/b/ file",
  "ast-grep -p before --rewrite after -U",
  "Set-Content -Path file -Value value",
]) {
  test(`shell policy routes known manual mutation: ${command}`, () => {
    expect(shellMutates(command)).toBeTrue();
    expect(skillShellMutates(command)).toBeTrue();
  });
}

for (const command of [
  "rg value src",
  "rg value src 2>/dev/null",
  "command -v touch",
  "git clone ./src ./dst",
  "git checkout -- file",
  "git reset --hard",
  "git clean -fd",
  "git init repo",
  "git -c alias.co=checkout co -b demo",
  "printf text > generated.log",
  "cat source 1>target",
  "bun run generate | tee generated.log",
  "bun run generate > generated.log",
  "cp source target",
  "install source target",
  "mkdir generated",
  "chmod +x generated.sh",
  "python3.11 script.py",
  "node scripts/generate.mjs",
  "python3.11 -c 'print(1)'",
  "node -e 'console.log(1)'",
  "source ./script.sh",
  "sudo -s",
  "printf 'command: foo\\n'",
  "echo cmd: foo",
  "sed -n 1p file",
  "bun test --bail",
  "dprint fmt",
  "echo 'unterminated",
  "unknown-command file",
]) {
  test(`shell policy permits host-governed execution: ${command}`, () => {
    expect(shellMutates(command)).toBeFalse();
    expect(skillShellMutates(command)).toBeFalse();
  });
}

test("embedded command fields use the same routing heuristic", () => {
  for (const source of [
    'await tools.exec_command({ cmd: "touch blocked" })',
    'await tools.exec_command({ "command": "echo \\"x\\"; rm blocked" })',
    "await tools.exec_command({ script: `mv before after` })",
  ]) {
    expect(embeddedShellMutates(source)).toBeTrue();
    expect(skillEmbeddedShellMutates(source)).toBeTrue();
  }
  for (const source of [
    'await tools.exec_command({ cmd: "git checkout -- file" })',
    "await tools.exec_command({ cmd: command })",
    'await tools.exec_command({ note: "touch blocked" })',
    "x".repeat(100_001),
  ]) {
    expect(embeddedShellMutates(source)).toBeFalse();
    expect(skillEmbeddedShellMutates(source)).toBeFalse();
  }
});
