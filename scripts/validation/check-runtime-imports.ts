import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import ts from "typescript-strada";

export interface ImportViolation {
  file: string;
  line: number;
  specifier: string;
  message: string;
}

const tooling = /^(oxfmt|oxlint|fallow|@modelcontextprotocol\/inspector)(\/|$)/;

/** Inspect syntax, including runtime imports nested inside functions. */
export function checkRuntimeSource(
  file: string,
  source: string,
  root: string,
): ImportViolation[] {
  const relative = path.relative(root, file).replaceAll("\\", "/");
  if (!/^(src|bin)\//.test(relative)) return [];
  const parsed = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const violations: ImportViolation[] = [];
  function inspect(node: ts.Node, module: ts.Expression | undefined) {
    if (!module || !ts.isStringLiteralLike(module)) return;
    const specifier = module.text;
    const resolved = path
      .relative(root, path.resolve(path.dirname(file), specifier))
      .replaceAll("\\", "/");
    const development =
      /^(\.{1,2}\/)+(scripts|tests)(\/|$)/.test(specifier) ||
      (specifier.startsWith(".") && /^(scripts|tests)(\/|$)/.test(resolved));
    const message = tooling.test(specifier)
      ? "Keep development tooling out of runtime modules; invoke repository scripts instead."
      : development
        ? "Runtime modules must not import development scripts or tests."
        : undefined;
    if (message)
      violations.push({
        file: relative,
        line:
          parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1,
        specifier,
        message,
      });
  }
  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const typeOnly =
        clause?.isTypeOnly ||
        (!clause?.name &&
          bindings &&
          ts.isNamedImports(bindings) &&
          bindings.elements.length > 0 &&
          bindings.elements.every((item) => item.isTypeOnly));
      if (!typeOnly) inspect(node, node.moduleSpecifier);
    } else if (ts.isExportDeclaration(node)) {
      const typeOnly =
        node.isTypeOnly ||
        (node.exportClause &&
          ts.isNamedExports(node.exportClause) &&
          node.exportClause.elements.length > 0 &&
          node.exportClause.elements.every((item) => item.isTypeOnly));
      if (!typeOnly) inspect(node, node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      !node.isTypeOnly &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      inspect(node, node.moduleReference.expression);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require"))
    ) {
      inspect(node, node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  return violations;
}

export async function checkRuntimeImports(
  root: string,
): Promise<ImportViolation[]> {
  const violations: ImportViolation[] = [];
  async function scan(directory: string) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      if (
        entry.isDirectory() &&
        entry.name !== "node_modules" &&
        !entry.name.startsWith(".")
      ) {
        await scan(file);
      } else if (entry.isFile() && /\.(?:[cm]?[jt]sx?)$/.test(entry.name)) {
        violations.push(
          ...checkRuntimeSource(file, await readFile(file, "utf8"), root),
        );
      }
    }
  }
  await scan(path.join(root, "src"));
  await scan(path.join(root, "bin"));
  return violations;
}

export async function runRuntimeImportCheck(
  root: string,
  report: (message: string) => void = console.error,
): Promise<number> {
  const violations = await checkRuntimeImports(root);
  for (const violation of violations) {
    report(
      `${violation.file}:${violation.line}: no-restricted-imports: ${violation.message} (${violation.specifier})`,
    );
  }
  return violations.length ? 1 : 0;
}

if (import.meta.main) {
  process.exitCode = await runRuntimeImportCheck(
    path.resolve(process.argv[2] ?? path.join(import.meta.dir, "../..")),
  );
}
