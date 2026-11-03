import { readFile } from "node:fs/promises";
import path from "node:path";

import ts from "typescript-strada";

import { sourceDirectory } from "./source-directory";

export interface TimingViolation {
  file: string;
  line: number;
  message: string;
}
const globals = new Set([
  "Bun",
  "Date",
  "performance",
  "process",
  "AbortSignal",
  "Atomics",
  "globalThis",
  "global",
  "window",
  "setTimeout",
  "setInterval",
  "setImmediate",
]);
const forbidden =
  /^(?:(?:globalThis|global|window)\.)?(?:setTimeout|setInterval|setImmediate|Bun\.(?:sleep|sleepSync|nanoseconds)|Date\.now|performance\.(?:now|timeOrigin)|process\.hrtime(?:\.bigint)?|AbortSignal\.timeout|Atomics\.wait(?:Async)?)$/;
const nativeModules = /^(?:node:)?(?:timers(?:\/promises)?|perf_hooks)$/;

/** Resolve local bindings so aliases cannot hide native timing and shadows remain valid. */
export function checkUnitTimingSource(
  file: string,
  source: string,
  embedded = false,
): TimingViolation[] {
  const parsed = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const host = ts.createCompilerHost({ noLib: true, noResolve: true });
  host.getSourceFile = (name) => (name === file ? parsed : undefined);
  const program = ts.createProgram(
    [file],
    { noLib: true, noResolve: true },
    host,
  );
  const checker = program.getTypeChecker();
  const aliases = new Map<ts.Symbol, string>();
  const violations: TimingViolation[] = [];
  const seen = new Set<number>();
  function report(node: ts.Node, message: string) {
    if (seen.has(node.pos)) return;
    seen.add(node.pos);
    violations.push({
      file,
      line:
        parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1,
      message,
    });
  }
  function constant(expression: ts.Expression | undefined): string | undefined {
    if (!expression) return;
    if (ts.isStringLiteralLike(expression)) return expression.text;
    if (ts.isIdentifier(expression)) {
      const declaration =
        checker.getSymbolAtLocation(expression)?.valueDeclaration;
      if (
        declaration &&
        ts.isVariableDeclaration(declaration) &&
        declaration.initializer &&
        ts.isStringLiteralLike(declaration.initializer)
      )
        return declaration.initializer.text;
    }
  }
  function name(
    expression: ts.Node | undefined,
    visited = new Set<ts.Symbol>(),
  ): string | undefined {
    if (!expression) return;
    if (
      ts.isParenthesizedExpression(expression) ||
      ts.isAsExpression(expression) ||
      ts.isNonNullExpression(expression) ||
      ts.isAwaitExpression(expression)
    )
      return name(expression.expression, visited);
    if (
      ts.isCallExpression(expression) &&
      (expression.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(expression.expression) &&
          expression.expression.text === "require"))
    ) {
      const module = expression.arguments[0];
      if (module && ts.isStringLiteralLike(module) && module.text === "bun")
        return "Bun";
    }
    if (ts.isIdentifier(expression)) {
      const symbol = ts.isShorthandPropertyAssignment(expression.parent)
        ? checker.getShorthandAssignmentValueSymbol(expression.parent)
        : checker.getSymbolAtLocation(expression);
      if (!symbol || !symbol.declarations?.length)
        return globals.has(expression.text) ? expression.text : undefined;
      if (visited.has(symbol)) return;
      visited.add(symbol);
      const alias = aliases.get(symbol);
      if (alias) return alias;
      const declaration = symbol.valueDeclaration;
      if (declaration && ts.isVariableDeclaration(declaration))
        return name(declaration.initializer, visited);
      return;
    }
    if (ts.isPropertyAccessExpression(expression)) {
      const parent = name(expression.expression, visited);
      return parent && parent + "." + expression.name.text;
    }
    if (ts.isElementAccessExpression(expression)) {
      const parent = name(expression.expression, visited);
      const key = constant(expression.argumentExpression);
      return parent && key ? parent + "." + key : undefined;
    }
    return;
  }
  function bind(binding: ts.BindingName, value: string | undefined) {
    if (!value) return;
    if (ts.isIdentifier(binding)) {
      const symbol = checker.getSymbolAtLocation(binding);
      if (symbol) aliases.set(symbol, value);
    } else if (ts.isObjectBindingPattern(binding)) {
      for (const element of binding.elements) {
        const key = element.propertyName ?? element.name;
        if (ts.isIdentifier(key) || ts.isStringLiteralLike(key))
          bind(element.name, value + "." + key.text);
      }
    }
  }
  function collect(node: ts.Node) {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      const module = node.moduleSpecifier.text;
      const bindings = node.importClause?.namedBindings;
      const typeOnly =
        node.importClause?.isTypeOnly ||
        (!node.importClause?.name &&
          bindings &&
          ts.isNamedImports(bindings) &&
          bindings.elements.every((item) => item.isTypeOnly));
      if (!typeOnly && nativeModules.test(module))
        report(
          node,
          "Native timer imports are forbidden in unit tests; use tests/support/mock-time.",
        );
      const namespace =
        module === "bun"
          ? "Bun"
          : /^(?:node:)?process$/.test(module)
            ? "process"
            : undefined;
      if (namespace && !typeOnly) {
        if (node.importClause?.name) bind(node.importClause.name, namespace);
        if (bindings && ts.isNamespaceImport(bindings))
          bind(bindings.name, namespace);
        if (bindings && ts.isNamedImports(bindings)) {
          for (const item of bindings.elements) {
            if (!item.isTypeOnly)
              bind(
                item.name,
                namespace + "." + (item.propertyName ?? item.name).text,
              );
          }
        }
      }
    }
    if (ts.isVariableDeclaration(node)) bind(node.name, name(node.initializer));
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    )
      bind(node.left, name(node.right));
    ts.forEachChild(node, collect);
  }
  collect(parsed);
  collect(parsed);
  function visit(node: ts.Node) {
    if (
      !embedded &&
      (ts.isCallExpression(node) || ts.isNewExpression(node)) &&
      /(?:^|\.)(?:writeFile|writeFileSync|write|spawn|spawnSync|Worker)$/.test(
        node.expression.getText(parsed),
      )
    ) {
      function inspectScript(
        expression: ts.Node,
        seenBindings = new Set<ts.Symbol>(),
      ) {
        if (ts.isIdentifier(expression)) {
          const symbol = checker.getSymbolAtLocation(expression);
          if (symbol && !seenBindings.has(symbol)) {
            seenBindings.add(symbol);
            const declaration = symbol.valueDeclaration;
            if (
              declaration &&
              ts.isVariableDeclaration(declaration) &&
              declaration.initializer
            )
              inspectScript(declaration.initializer, seenBindings);
          }
        } else if (
          ts.isStringLiteralLike(expression) ||
          ts.isTemplateExpression(expression)
        ) {
          const script = ts.isTemplateExpression(expression)
            ? expression.head.text +
              expression.templateSpans
                .map((span) => "undefined" + span.literal.text)
                .join("")
            : expression.text;
          if (checkUnitTimingSource(file, script, true).length)
            report(
              expression,
              "Native timing in generated scripts belongs in an explicit integration fixture.",
            );
        } else
          ts.forEachChild(expression, (child) =>
            inspectScript(child, seenBindings),
          );
      }
      for (const argument of node.arguments ?? []) inspectScript(argument);
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const target = name(node.expression)?.replace(
        /\.(?:call|apply|bind)$/,
        "",
      );
      if (
        target &&
        (forbidden.test(target) ||
          (/^(?:(?:globalThis|global|window)\.)?Date$/.test(target) &&
            (ts.isCallExpression(node) ||
              !node.arguments ||
              node.arguments.length === 0)))
      )
        report(
          node,
          "Ambient time is forbidden in unit tests; use a mock clock or an explicit phase gate.",
        );
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments[0] &&
        ts.isStringLiteralLike(node.arguments[0]) &&
        nativeModules.test(node.arguments[0].text)
      )
        report(
          node,
          "Dynamic native timer imports are forbidden in unit tests.",
        );
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require" &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      nativeModules.test(node.arguments[0].text)
    )
      report(node, "Native timer require calls are forbidden in unit tests.");
    if (
      ts.isImportEqualsDeclaration(node) &&
      !node.isTypeOnly &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteralLike(node.moduleReference.expression) &&
      nativeModules.test(node.moduleReference.expression.text)
    )
      report(node, "Native timer imports are forbidden in unit tests.");
    if (
      ts.isIdentifier(node) &&
      ["setTimeout", "setInterval", "setImmediate"].includes(name(node) ?? "")
    ) {
      let parent: ts.Node | undefined = node.parent;
      let typeOnly = false;
      while (parent && parent !== parsed) {
        if (ts.isTypeNode(parent)) {
          typeOnly = true;
          break;
        }
        parent = parent.parent;
      }
      if (
        !typeOnly &&
        !(
          ts.isPropertyAccessExpression(node.parent) &&
          node.parent.name === node
        )
      )
        report(node, "Native timer references are forbidden in unit tests.");
    }
    if (
      ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node)
    ) {
      const target = name(node);
      if (target && forbidden.test(target))
        report(
          node,
          "Native timing references are forbidden in unit tests; use tests/support/mock-time.",
        );
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  return violations;
}

export async function checkUnitTiming(
  root = process.cwd(),
): Promise<TimingViolation[]> {
  const violations: TimingViolation[] = [];
  async function scan(directory: string) {
    const entries = await sourceDirectory(directory);
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).replaceAll("\\", "/");
      if (entry.isDirectory()) {
        if (
          !["node_modules", ".git"].includes(entry.name) &&
          relative !== "tests/integration" &&
          relative !== "tests/fixtures"
        )
          await scan(absolute);
      } else if (
        /\.[cm]?[jt]sx?$/.test(entry.name) &&
        (relative.startsWith("tests/") ||
          /\.test\.[cm]?[jt]sx?$/.test(relative)) &&
        relative !== "tests/support/mock-time.ts"
      ) {
        violations.push(
          ...checkUnitTimingSource(relative, await readFile(absolute, "utf8")),
        );
      }
    }
  }
  await scan(path.join(root, "tests"));
  await scan(path.join(root, "templates"));
  await scan(path.join(root, "website/tests"));
  // Fixtures are checked when reachable from a unit helper or test. Production
  // modules retain native defaults and are outside this test-only import boundary.
  const checked = new Set<string>();
  async function inspectImports(file: string) {
    if (checked.has(file)) return;
    checked.add(file);
    const source = await readFile(file, "utf8");
    const parsed = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
    );
    const imports: { specifier: string; line: number }[] = [];
    function visit(node: ts.Node) {
      let module: ts.Expression | undefined;
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
        module = node.moduleSpecifier;
      if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference)
      )
        module = node.moduleReference.expression;
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) &&
            node.expression.text === "require"))
      )
        module = node.arguments[0];
      if (
        module &&
        ts.isStringLiteralLike(module) &&
        module.text.startsWith(".")
      )
        imports.push({
          specifier: module.text,
          line:
            parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line +
            1,
        });
      ts.forEachChild(node, visit);
    }
    visit(parsed);
    for (const entry of imports) {
      const base = path.resolve(path.dirname(file), entry.specifier);
      const relative = path.relative(root, base).replaceAll("\\", "/");
      if (relative.startsWith("tests/integration/")) {
        violations.push({
          file: path.relative(root, file),
          line: entry.line,
          message:
            "Unit tests and helpers must not import integration fixtures.",
        });
        continue;
      }
      if (
        !["tests/", "templates/", "website/tests/"].some((prefix) =>
          relative.startsWith(prefix),
        ) ||
        relative === "tests/support/mock-time" ||
        relative === "tests/support/mock-time.ts"
      )
        continue;
      const sourceBase = base.replace(/\.([cm]?)js$/, ".$1ts");
      for (const candidate of [
        ...new Set([
          base,
          sourceBase,
          ...(/\.[cm]?js$/.test(base)
            ? [
                base.replace(/\.[cm]?js$/, ".tsx"),
                base.replace(/\.[cm]?js$/, ".mts"),
                base.replace(/\.[cm]?js$/, ".cts"),
              ]
            : []),
          ...[
            ".ts",
            ".tsx",
            ".mts",
            ".cts",
            ".js",
            ".jsx",
            ".mjs",
            ".cjs",
          ].flatMap((extension) => [
            base + extension,
            path.join(base, "index" + extension),
          ]),
        ]),
      ]) {
        try {
          const content = await readFile(candidate, "utf8");
          if (
            ["tests/fixtures/", "templates/", "website/tests/"].some((prefix) =>
              relative.startsWith(prefix),
            ) &&
            !relative.startsWith("templates/skills/ast-mcp/scripts/")
          )
            violations.push(
              ...checkUnitTimingSource(path.relative(root, candidate), content),
            );
          await inspectImports(candidate);
          break;
        } catch (error) {
          if (
            !["ENOENT", "EISDIR"].includes(
              (error as NodeJS.ErrnoException).code ?? "",
            )
          )
            throw error;
        }
      }
    }
  }
  const tests = new Bun.Glob("**/*.test.{ts,tsx,mts,cts,js,jsx,mjs,cjs}");
  for (const directory of ["tests", "templates", "website/tests"]) {
    for await (const file of tests.scan({
      cwd: path.join(root, directory),
      absolute: true,
      onlyFiles: true,
    })) {
      const relative = path.relative(root, file).replaceAll("\\", "/");
      if (!relative.startsWith("tests/integration/"))
        await inspectImports(file);
    }
  }
  return violations;
}

export async function runUnitTiming(
  root = process.cwd(),
  output: (text: string) => void = console.error,
) {
  const violations = await checkUnitTiming(root);
  for (const violation of violations)
    output(violation.file + ":" + violation.line + ": " + violation.message);
  return violations.length ? 1 : 0;
}

if (import.meta.main) process.exitCode = await runUnitTiming();
