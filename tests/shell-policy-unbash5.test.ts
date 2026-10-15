import { describe, expect, test } from "bun:test";

import { shellMutates } from "../src/shell-policy";
const templatePath = "../templates/skills/ast-mcp/evals/" + "shell-policy";
const { shellMutates: templateShellMutates } = await import(templatePath);

for (const [name, mutates] of [
  ["runtime", shellMutates],
  ["template", templateShellMutates],
] as const) {
  describe(`${name} unbash 5 AST traversal`, () => {
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
    ])("finds mutator in %s", (source) => expect(mutates(source)).toBe(true));
    test.each([
      "printf '%s' rm >audit",
      "cat <<'EOF'\n$(rm -rf src)\nEOF",
      "echo $(if)",
      "if rm -rf src",
      "export A=literal >audit",
    ])("preserves non-mutating or malformed result for %s", (source) =>
      expect(mutates(source)).toBe(false),
    );
  });
}
