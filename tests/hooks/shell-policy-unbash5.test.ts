import { describe, expect, test } from "bun:test";

import { shellMutates } from "../../src/hooks/shell-policy";
const templatePath = "../../templates/skills/ast-mcp/evals/" + "shell-policy";
const { shellMutates: templateShellMutates } = await import(templatePath);

for (const [name, mutates] of [
  ["runtime", shellMutates],
  ["template", templateShellMutates],
] as const) {
  describe(`${name} unbash 6 AST traversal`, () => {
    test.each([
      "time ! rm >audit -rf src",
      "command >audit rm -rf src",
      "env A=1 >audit rm -rf src",
      "A=$(rm -rf src) printf x",
      "export A=$(rm -rf src)",
      'printf "%s" "${x:-$(rm -rf src)}"',
      "cat <(rm -rf src)",
      "cat <<EOF\n$(rm -rf src)\nEOF",
      "f() { printf x; } >$(rm -rf src)",
      "for item in $(rm -rf src); do printf x; done",
      "echo $(if); rm -rf src",
      'printf "%s" "${x/$(rm -rf src)/safe}"',
      'printf "%s" "${x:$(rm -rf src):1}"',
      "A=([0]=$(rm -rf src)) printf x",
      'printf "%s" "$((1 + $(rm -rf src)))"',
      "(( 1 ? 2 : $(rm -rf src) ))",
      "[[ $(rm -rf src) = value ]]",
      "[[ ! -n $(rm -rf src) ]]",
      "for ((i=0; i<1; i++)); do rm -rf src; done",
      "while printf x; do rm -rf src; done",
      "case x in x) rm -rf src;; esac",
      "printf [$(rm -rf src)]",
      'printf ["$(rm -rf src)"]',
      "if false; then printf x; elif true; then rm -rf src; fi",
      "if false; then printf x; elif rm -rf src; then printf x; fi",
      "! time -p printf x | rm -rf src",
      "[[ x && y && $(rm -rf src) ]]",
      "[[ ! ! $(rm -rf src) ]]",
      "printf [$(if)]; rm -rf src",
    ])("finds mutator in %s", (source) => expect(mutates(source)).toBe(true));
    test("traverses long flat test expressions without recursive stack growth", () => {
      expect(mutates("[[ " + "x && ".repeat(2000) + "$(rm -rf src) ]]")).toBe(
        true,
      );
    });
    test("finds substitutions at the start of long arithmetic chains", () => {
      expect(
        mutates("echo $(( $(touch blocked)" + " + 1".repeat(1000) + " ))"),
      ).toBe(true);
    });
    test("bounds deeply nested malformed input", () => {
      expect(mutates("(".repeat(2000) + "rm -rf src" + ")".repeat(2000))).toBe(
        false,
      );
    });
    test.each([
      "printf '%s' rm >audit",
      "cat <<'EOF'\n$(rm -rf src)\nEOF",
      "echo $(if)",
      "if rm -rf src",
      "export A=literal >audit",
      "printf [$(if)]",
      "printf '[\"$(rm -rf src)\"]'",
      "if false; then printf x; elif true; then printf y; fi",
      "! time -p printf x | cat",
      "[[ x && y && z ]]",
      "[[ ! ! x ]]",
    ])("preserves non-mutating or malformed result for %s", (source) =>
      expect(mutates(source)).toBe(false),
    );
  });
}
