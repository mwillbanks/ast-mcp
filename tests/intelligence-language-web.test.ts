import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as ts from "typescript-strada";
import { LanguageCapabilitySchema } from "../src/intelligence/contracts/language.ts";
import type { WebLanguageId } from "../src/intelligence/languages/web/index.ts";
import {
  analyzeCompilerLanguage,
  analyzeTemplate,
  analyzeTypeScriptProject,
  compilerResolutions,
  webLanguageAdapter,
  webLanguageAdapters,
  webLanguageGroupManifest,
} from "../src/intelligence/languages/web/index.ts";

const fixtureRoot = join(
  import.meta.dir,
  "fixtures",
  "intelligence",
  "languages",
  "web",
);

async function fixture(name: string): Promise<string> {
  return readFile(join(fixtureRoot, name), "utf8");
}

describe("web intelligence language adapters", () => {
  test("publishes a deterministic, schema-valid group manifest", () => {
    expect(webLanguageGroupManifest.groupId).toBe("web");
    expect(webLanguageGroupManifest.schemaVersion).toBe(
      "ast-mcp.intelligence.v1",
    );
    expect(webLanguageGroupManifest.implementationFingerprint).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(webLanguageAdapters.map((adapter) => adapter.languageId)).toEqual([
      "javascript",
      "typescript",
      "jsx",
      "tsx",
      "vue",
      "svelte",
      "astro",
      "ejs",
      "blade",
      "razor",
    ]);
    for (const adapter of webLanguageAdapters) {
      expect(() =>
        LanguageCapabilitySchema.parse(adapter.capability),
      ).not.toThrow();
      expect(adapter.capability.languageId).toBe(adapter.languageId);
      expect(adapter.extensions.length).toBeGreaterThan(0);
    }
    expect(() => webLanguageAdapter("unknown" as WebLanguageId)).toThrow(
      "Unsupported web language",
    );
  });

  test("extracts JavaScript and resolves compiler targets from companion sources", async () => {
    const source = await fixture("javascript.js");
    const request = {
      companionSources: {
        "/base.js": "export class Base {}",
      },
      fileName: "/javascript.js",
      languageId: "javascript" as const,
      source,
    };
    const first = analyzeCompilerLanguage(request);
    const second = analyzeCompilerLanguage(request);

    expect(first.facts.symbols.map((symbol) => symbol.name)).toEqual([
      "CaféService",
      "run",
      "factory",
    ]);
    expect(first.facts.imports[0]?.source).toBe("./base.js");
    expect(first.facts.exports.map((entry) => entry.exportedName)).toContain(
      "CaféService",
    );
    expect(first.facts.inheritance[0]?.targetName).toBe("Parent");
    expect(first.facts.calls.map((call) => call.callee)).toContain("emit");
    expect(first.resolutions.some((entry) => entry.kind === "import")).toBe(
      true,
    );
    expect(first.resolutions.some((entry) => entry.kind === "call")).toBe(true);
    expect(first).toEqual(second);
  });

  test("extracts TypeScript types, calls, inheritance, and implementation", async () => {
    const source = await fixture("typescript.ts");
    const analysis = webLanguageAdapter("typescript").analyze({
      companionSources: {
        "/client.ts": "export function emit(value: string) { return value; }",
        "/types.ts": "export interface Runnable { run(value: string): string }",
      },
      fileName: "/typescript.ts",
      languageId: "typescript",
      source,
    });

    expect(analysis.facts.imports).toHaveLength(2);
    expect(analysis.facts.exports.length).toBeGreaterThanOrEqual(2);
    expect(analysis.facts.symbols.map((symbol) => symbol.name)).toEqual(
      expect.arrayContaining(["Named", "Service", "run"]),
    );
    expect(analysis.facts.inheritance.map((edge) => edge.targetName)).toEqual([
      "Base",
    ]);
    expect(
      analysis.facts.implementations.map((edge) => edge.targetName),
    ).toEqual(["Runnable", "Named"]);
    expect(analysis.resolutions.map((entry) => entry.kind)).toEqual(
      expect.arrayContaining([
        "import",
        "call",
        "inheritance",
        "implementation",
      ]),
    );
    expect(
      analysis.resolutions.find(
        (entry) => entry.kind === "import" && entry.name === "./client.ts",
      )?.resolvedFile,
    ).toBe("/client.ts");
  });

  test("covers TypeScript compiler module-resolution forms", () => {
    const source = [
      'import fallback from "./default.js";',
      'import * as namespace from "/namespace";',
      'import { missing } from "external-package";',
      'export { value as renamed } from "./values";',
      "fallback();",
      "namespace.run();",
      "missing();",
    ].join("\n");
    const resolutions = compilerResolutions({
      companionSources: {
        "/namespace/index.ts": "export const run = () => undefined;",
        "/relative/default.js": "export default function fallback() {}",
        "/relative/values.ts": "export const value = 1;",
      },
      fileName: "relative\\entry.ts",
      languageId: "typescript",
      source,
    });

    expect(
      resolutions.find(
        (entry) => entry.kind === "import" && entry.name === "./default.js",
      ),
    ).toEqual(
      expect.objectContaining({
        resolvedFile: "/relative/default.js",
        resolvedName: "fallback",
      }),
    );
    expect(
      resolutions.find(
        (entry) => entry.kind === "import" && entry.name === "/namespace",
      ),
    ).toEqual(
      expect.objectContaining({
        resolvedFile: "/namespace/index.ts",
        resolvedName: "*",
      }),
    );
    expect(
      resolutions.find(
        (entry) => entry.kind === "import" && entry.name === "external-package",
      )?.resolvedFile,
    ).toBeNull();
    expect(
      resolutions.find((entry) => entry.kind === "export")?.resolvedFile,
    ).toBe("/relative/values.ts");
    expect(resolutions.filter((entry) => entry.kind === "call")).toHaveLength(
      3,
    );
    expect(
      resolutions.find(
        (entry) => entry.kind === "call" && entry.name === "missing",
      )?.resolvedFile,
    ).toBeNull();
    for (const resolution of resolutions) {
      const start = resolution.range.startCoordinate.utf16Offset;
      const end = resolution.range.endCoordinate.utf16Offset;
      const evidence = source.slice(start, end);
      if (resolution.kind === "import" || resolution.kind === "export") {
        expect(evidence).toMatch(/^["'][^"']+["']$/);
      } else {
        expect(evidence).toBe(resolution.name);
      }
    }
    expect(
      compilerResolutions({ languageId: "typescript", source: "" }),
    ).toEqual([]);
  });

  test("uses in-process compiler options, paths, packages, and exact AST evidence", () => {
    const source = [
      'import { value } from "@lib/value";',
      'import { packageValue } from "pkg";',
      'export { value } from "@lib/value";',
      "interface Contract { run(): void }",
      "class Base {}",
      "export class Service extends Base implements Contract { run() {} }",
      "value();",
      "value();",
      "packageValue();",
      "new Service();",
      "missing();",
    ].join("\n");
    const files: Record<string, string> = {
      "/entry.ts": source,
      "/node_modules/pkg/index.d.ts":
        "export declare function packageValue(): void;",
      "/node_modules/pkg/package.json": JSON.stringify({
        name: "pkg",
        types: "index.d.ts",
      }),
      "/src/value.ts": "export function value() {}",
    };
    const options: ts.CompilerOptions = {
      baseUrl: "/",
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      paths: { "@lib/*": ["src/*"] },
      target: ts.ScriptTarget.ESNext,
    };
    const host = ts.createCompilerHost(options);
    host.directoryExists = (directory) =>
      Object.keys(files).some((fileName) =>
        fileName.startsWith(`${directory.replace(/\/$/u, "")}/`),
      );
    host.fileExists = (fileName) => files[fileName] !== undefined;
    host.getCurrentDirectory = () => "/";
    host.getDirectories = (directory) => [
      ...new Set(
        Object.keys(files)
          .filter((fileName) =>
            fileName.startsWith(`${directory.replace(/\/$/u, "")}/`),
          )
          .map((fileName) => fileName.slice(directory.length).split("/")[0])
          .filter((value): value is string => Boolean(value)),
      ),
    ];
    host.getSourceFile = (fileName, languageVersion) => {
      const text = files[fileName];
      return text === undefined
        ? undefined
        : ts.createSourceFile(fileName, text, languageVersion, true);
    };
    host.readFile = (fileName) => files[fileName];
    host.realpath = (fileName) => fileName;
    const program = ts.createProgram({
      host,
      options,
      rootNames: ["/entry.ts", "/src/value.ts"],
    });
    const analysis = webLanguageAdapter("typescript").analyze({
      compilerProgram: program,
      fileName: "/entry.ts",
      languageId: "typescript",
      source,
    });

    const pathImport = analysis.resolutions.find(
      (entry) => entry.kind === "import" && entry.name === '"@lib/value"',
    );
    const packageImport = analysis.resolutions.find(
      (entry) => entry.kind === "import" && entry.name === '"pkg"',
    );
    const missing = analysis.resolutions.find(
      (entry) => entry.kind === "call" && entry.name === "missing",
    );
    expect(pathImport?.resolvedFile).toBe("/src/value.ts");
    expect(packageImport?.resolvedFile).toBe("/node_modules/pkg/index.d.ts");
    expect(missing).toEqual(
      expect.objectContaining({ resolvedFile: null, resolvedName: null }),
    );
    const valueCalls = analysis.facts.calls.filter(
      (entry) => entry.callee === "value",
    );
    expect(valueCalls).toHaveLength(2);
    expect(valueCalls[0]?.range).not.toEqual(valueCalls[1]?.range);
    expect(analysis.resolutions.map((entry) => entry.kind)).toEqual(
      expect.arrayContaining([
        "export",
        "inheritance",
        "implementation",
        "call",
      ]),
    );
    for (const resolution of analysis.resolutions) {
      const start = resolution.range.startCoordinate.utf16Offset;
      const end = resolution.range.endCoordinate.utf16Offset;
      expect(source.slice(start, end)).toBe(resolution.name);
    }
    expect(
      analysis.facts.imports.map((entry) =>
        source.slice(
          entry.range.startCoordinate.utf16Offset,
          entry.range.endCoordinate.utf16Offset,
        ),
      ),
    ).toEqual(['"@lib/value"', '"pkg"']);
    expect(() =>
      analyzeTypeScriptProject({
        fileName: "/absent.ts",
        languageId: "typescript",
        program,
        source: "",
      }),
    ).toThrow("Compiler project does not contain /absent.ts");
  });

  test("supports JSX and TSX compiler script kinds", () => {
    for (const languageId of ["jsx", "tsx"] as const) {
      const source =
        languageId === "tsx"
          ? "export const View = (props: { label: string }) => <p>{props.label}</p>;"
          : "export const View = (props) => <p>{props.label}</p>;";
      const analysis = analyzeCompilerLanguage({ languageId, source });
      expect(
        analysis.facts.symbols.some((symbol) => symbol.name === "View"),
      ).toBe(true);
      expect(compilerResolutions({ languageId, source })).toEqual(
        analysis.resolutions,
      );
    }
  });

  const templateCases = [
    ["vue", "vue.vue", 1, "VueService", "render", true],
    ["svelte", "svelte.svelte", 1, "SvelteService", "tick", true],
    ["astro", "astro.astro", 2, "AstroService", "render", true],
    ["ejs", "ejs.ejs", 3, "EjsService", "render", false],
    ["blade", "blade.blade.php", 2, "BladeService", "render", false],
  ] as const;

  for (const [
    languageId,
    fileName,
    regionCount,
    symbolName,
    callName,
    hasInheritance,
  ] of templateCases) {
    test(`extracts and maps ${languageId} embedded syntax`, async () => {
      const source = await fixture(fileName);
      const analysis = webLanguageAdapter(languageId).analyze({
        languageId,
        source,
      });

      expect(analysis.embeddedRegions).toHaveLength(regionCount);
      expect(
        analysis.facts.symbols.some((symbol) => symbol.name === symbolName),
      ).toBe(true);
      expect(
        analysis.facts.calls.some((call) => call.callee === callName),
      ).toBe(true);
      expect(analysis.facts.imports.length).toBeGreaterThan(0);
      expect(analysis.facts.inheritance.length > 0).toBe(hasInheritance);
      expect(analysis.facts.partial).toBe(false);
      expect(analysis.facts.nodes).toHaveLength(1);
      expect(analysis.facts.nodes[0]?.kind).toBe("template_document");
      for (const item of [
        ...analysis.facts.symbols,
        ...analysis.facts.imports,
        ...analysis.facts.calls,
        ...analysis.facts.inheritance,
      ]) {
        const start = item.range.startCoordinate.utf16Offset;
        const end = item.range.endCoordinate.utf16Offset;
        expect(start).toBeGreaterThanOrEqual(0);
        expect(end).toBeLessThanOrEqual(source.length);
        expect(item.range.startByte).toBe(
          new TextEncoder().encode(source.slice(0, start)).byteLength,
        );
      }
      expect(analysis).toEqual(analyzeTemplate({ languageId, source }));
    });
  }

  test("marks Razor C# blocks unsupported without JavaScript parsing", async () => {
    const source = await fixture("razor.cshtml");
    const analysis = webLanguageAdapter("razor").analyze({
      languageId: "razor",
      source,
    });
    expect(analysis.embeddedRegions).toEqual([]);
    expect(analysis.facts.symbols).toEqual([]);
    expect(analysis.facts.calls).toEqual([]);
    expect(analysis.diagnostics).toEqual([
      expect.objectContaining({
        code: "unsupported-construct",
        message:
          "Razor C# blocks and expressions require the C# language adapter",
      }),
    ]);
    expect(webLanguageAdapter("razor").capability.symbolExtraction.status).toBe(
      "unsupported",
    );
  });

  test("matches complete facts and ranges from the pinned Graphify revision", async () => {
    const golden = JSON.parse(await fixture("graphify-golden.json")) as {
      cases: Record<
        string,
        { facts: unknown; languageId: WebLanguageId; regions: unknown[] }
      >;
      provenance: { revision: string; tool: string };
    };
    expect(golden.provenance).toEqual({
      revision: "3f82bf7f837a07fb0f7668fbdbd5662801906942",
      tool: "graphify",
    });
    const range = (value: {
      range: {
        startCoordinate: { utf16Offset: number };
        endCoordinate: { utf16Offset: number };
      };
    }) => ({
      end: value.range.endCoordinate.utf16Offset,
      start: value.range.startCoordinate.utf16Offset,
    });

    for (const [fileName, expected] of Object.entries(golden.cases)) {
      const source = await fixture(fileName);
      const analysis = webLanguageAdapter(expected.languageId).analyze({
        fileName: `/${fileName}`,
        languageId: expected.languageId,
        source,
      });
      expect(
        JSON.stringify(
          analysis.embeddedRegions.map((region) => ({
            end: region.endUtf16,
            languageId: region.languageId,
            start: region.startUtf16,
          })),
        ),
      ).toBe(JSON.stringify(expected.regions));
      expect({
        calls: analysis.facts.calls.map((entry) => ({
          callee: entry.callee,
          ...range(entry),
        })),
        diagnostics: analysis.facts.diagnostics.map((entry) => ({
          code: entry.code,
          severity: entry.severity,
          ...range(entry),
        })),
        exports: analysis.facts.exports.map((entry) => ({
          exportedName: entry.exportedName,
          localName: entry.localName,
          source: entry.source,
          ...range(entry),
        })),
        implementations: analysis.facts.implementations.map((entry) => ({
          targetName: entry.targetName,
          ...range(entry),
        })),
        imports: analysis.facts.imports.map((entry) => ({
          importedName: entry.importedName,
          localName: entry.localName,
          source: entry.source,
          ...range(entry),
        })),
        inheritance: analysis.facts.inheritance.map((entry) => ({
          targetName: entry.targetName,
          ...range(entry),
        })),
        references: analysis.facts.references.map((entry) => ({
          name: entry.name,
          role: entry.role,
          ...range(entry),
        })),
        symbols: analysis.facts.symbols.map((entry) => ({
          kind: entry.kind,
          name: entry.name,
          ...range(entry),
        })),
      }).toEqual(JSON.parse(JSON.stringify(expected.facts)));
    }
  });

  test("preserves exact Unicode, byte, character, and UTF-16 host ranges", async () => {
    const source = await fixture("vue.vue");
    const analysis = analyzeTemplate({ languageId: "vue", source });
    const call = analysis.facts.calls.find(
      (entry) => entry.callee === "render",
    );
    if (!call) throw new Error("Expected render call");
    const start = source.indexOf('render("🙂")');

    expect(call.range.startCoordinate.utf16Offset).toBe(start);
    expect(call.range.startByte).toBe(
      new TextEncoder().encode(source.slice(0, start)).byteLength,
    );
    expect(
      source.slice(
        call.range.startCoordinate.utf16Offset,
        call.range.endCoordinate.utf16Offset,
      ),
    ).toBe('render("🙂")');
  });

  test("uses parse5 script boundaries and preserves recognized closers", () => {
    const first = 'const repeated = "same";';
    const second = "const next = () => 1;";
    const source = [
      "<!-- <script>ignored()</script> -->",
      `<SCRIPT data-value="a > b" LANG="TS">${first}</SCRIPT\t\n>`,
      `<div>${first}</div>`,
      `<script type="text/javascript">${second}</script\n data-extra>`,
    ].join("\r\n");
    const analysis = analyzeTemplate({ languageId: "vue", source });
    const parseErrorOffset = source.lastIndexOf(">");

    expect(
      analysis.embeddedRegions.map(
        ({ languageId, source: embeddedSource, startUtf16, endUtf16 }) => ({
          endUtf16,
          languageId,
          source: embeddedSource,
          startUtf16,
        }),
      ),
    ).toEqual([
      {
        endUtf16: source.indexOf(first) + first.length,
        languageId: "typescript",
        source: first,
        startUtf16: source.indexOf(first),
      },
      {
        endUtf16: source.lastIndexOf(second) + second.length,
        languageId: "javascript",
        source: second,
        startUtf16: source.lastIndexOf(second),
      },
    ]);
    expect(analysis.diagnostics).toEqual([
      {
        code: "malformed-embedded-region",
        message: "HTML parse error: end-tag-with-attributes",
        range: expect.objectContaining({
          endCoordinate: expect.objectContaining({
            utf16Offset: parseErrorOffset,
          }),
          startCoordinate: expect.objectContaining({
            utf16Offset: parseErrorOffset,
          }),
        }),
        severity: "error",
      },
    ]);
    expect(analysis.facts.partial).toBe(true);

    const malformedSource = '<script lang="ts">const broken = 1;';
    const malformed = analyzeTemplate({
      languageId: "vue",
      source: malformedSource,
    });
    expect(malformed.embeddedRegions).toEqual([]);
    expect(malformed.diagnostics).toEqual([
      expect.objectContaining({
        code: "malformed-embedded-region",
        message: "Unclosed script element",
        range: expect.objectContaining({
          endCoordinate: expect.objectContaining({
            utf16Offset: malformedSource.length,
          }),
          startCoordinate: expect.objectContaining({ utf16Offset: 0 }),
        }),
        severity: "error",
      }),
    ]);
  });

  test("traverses scripts nested in HTML template contents", () => {
    const body = "const nested = () => 1;";
    const source = `<template><section><script lang="ts">${body}</script></section></template>`;
    const analysis = analyzeTemplate({ languageId: "vue", source });
    const start = source.indexOf(body);

    expect(analysis.embeddedRegions).toEqual([
      {
        endUtf16: start + body.length,
        hostLanguageId: "vue",
        languageId: "typescript",
        ordinal: 0,
        source: body,
        startUtf16: start,
      },
    ]);
    expect(analysis.diagnostics).toEqual([]);

    const malformedSource = `<template><script>${body}</template>`;
    const malformed = analyzeTemplate({
      languageId: "vue",
      source: malformedSource,
    });
    expect(malformed.embeddedRegions).toEqual([]);
    expect(malformed.diagnostics).toEqual([
      expect.objectContaining({
        code: "malformed-embedded-region",
        message: "Unclosed script element",
        range: expect.objectContaining({
          endCoordinate: expect.objectContaining({
            utf16Offset: malformedSource.length,
          }),
          startCoordinate: expect.objectContaining({
            utf16Offset: malformedSource.indexOf("<script>"),
          }),
        }),
        severity: "error",
      }),
    ]);
  });

  test("reports malformed and unsupported template constructs honestly", async () => {
    const malformed = analyzeTemplate({
      languageId: "vue",
      source: await fixture("malformed.vue"),
    });
    expect(malformed.embeddedRegions).toEqual([]);
    expect(malformed.diagnostics).toEqual([
      expect.objectContaining({
        code: "malformed-embedded-region",
        severity: "error",
      }),
    ]);
    expect(malformed.facts.diagnostics).toEqual([
      expect.objectContaining({ code: "parse-error", severity: "error" }),
    ]);
    expect(malformed.facts.partial).toBe(true);

    const javascriptOnly = analyzeTemplate({
      languageId: "vue",
      source: "<script>interface Hidden { value: string }</script>",
    });
    expect(javascriptOnly.embeddedRegions[0]?.languageId).toBe("javascript");
    expect(
      javascriptOnly.facts.symbols.some((symbol) => symbol.name === "Hidden"),
    ).toBe(false);
    expect(javascriptOnly.facts.diagnostics.length).toBeGreaterThan(0);
    expect(javascriptOnly.facts.partial).toBe(true);

    const unsupported = analyzeTemplate({
      languageId: "razor",
      source: await fixture("unsupported.razor"),
    });
    expect(unsupported.diagnostics).toEqual([
      expect.objectContaining({
        code: "unsupported-construct",
        severity: "warning",
      }),
    ]);

    const malformedEjs = analyzeTemplate({
      languageId: "ejs",
      source: "<% if (ready) {",
    });
    expect(malformedEjs.diagnostics[0]?.message).toBe("Unclosed EJS block");

    const malformedBlade = analyzeTemplate({
      languageId: "blade",
      source: "@php const value = 1;",
    });
    expect(malformedBlade.diagnostics[0]?.message).toBe(
      "Unclosed Blade PHP block",
    );
  });

  test("handles empty templates and excludes nested duplicate regions", () => {
    const empty = analyzeTemplate({
      languageId: "vue",
      source: "<template />",
    });
    expect(
      analyzeTemplate({ languageId: "javascript", source: "" }).embeddedRegions,
    ).toEqual([]);
    expect(empty.embeddedRegions).toEqual([]);
    expect(empty.facts.symbols).toEqual([]);

    const nested = analyzeTemplate({
      languageId: "blade",
      source: "@php const value = {{ compute() }}; @endphp",
    });
    expect(nested.embeddedRegions).toHaveLength(1);
    expect(nested.facts.symbols.some((symbol) => symbol.name === "value")).toBe(
      true,
    );
  });

  test("maps parser diagnostics and uses content-derived identities", () => {
    const source = "<script lang='ts'>function broken(</script>";
    const first = analyzeTemplate({ languageId: "vue", source });
    const second = analyzeTemplate({ languageId: "vue", source });
    const changed = analyzeTemplate({
      languageId: "vue",
      source: source.replace("broken", "changed"),
    });

    expect(first.facts.diagnostics.length).toBeGreaterThan(0);
    expect(first.facts.partial).toBe(true);
    expect(first.facts.syntaxFactsArtifactId).toBe(
      second.facts.syntaxFactsArtifactId,
    );
    expect(first.facts.syntaxFactsArtifactId).not.toBe(
      changed.facts.syntaxFactsArtifactId,
    );
  });

  test("contains no runtime subprocess surface", async () => {
    for (const fileName of [
      "compiler-project.ts",
      "compiler.ts",
      "templates.ts",
      "manifest.ts",
    ]) {
      const source = await readFile(
        join(
          import.meta.dir,
          "..",
          "src",
          "intelligence",
          "languages",
          "web",
          fileName,
        ),
        "utf8",
      );
      expect(source).not.toContain("Bun.spawn");
      expect(source).not.toContain("child_process");
    }
  });
});
