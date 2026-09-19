import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  ProjectFacts,
  ProjectFormatId,
} from "../src/intelligence/languages/project/index.ts";
import {
  analyzeProjectFormat,
  projectFormatCapabilities,
  projectFormatEvidence,
  projectLanguageGroupManifest,
} from "../src/intelligence/languages/project/index.ts";

const root = join(
  import.meta.dir,
  "fixtures",
  "intelligence",
  "languages",
  "project",
);
const cases = {
  "delphi-form": "demo.dfm",
  "dotnet-build": "build.props",
  "dotnet-project": "app.csproj",
  "dotnet-resource": "strings.resx",
  "dotnet-solution": "demo.sln",
  "dotnet-solution-xml": "demo.slnx",
  "lazarus-form": "demo.lfm",
  "lazarus-package": "demo.lpk",
  "lazarus-project": "demo.lpi",
  "nuget-manifest": "package.nuspec",
  "nuget-packages": "packages.config",
  xaml: "main.xaml",
} as const;
const source = (name: string) => readFile(join(root, name), "utf8");
function normalize(facts: ProjectFacts) {
  return facts;
}
function assertIntegrity(facts: ProjectFacts): void {
  const nodes = new Set(facts.nodes.map(({ id }) => id));
  const byId = new Map(facts.nodes.map((node) => [node.id, node]));
  expect(nodes.size).toBe(facts.nodes.length);
  expect(new Set(facts.relationships.map(({ id }) => id)).size).toBe(
    facts.relationships.length,
  );
  for (const node of facts.nodes) {
    expect(node.range.startByte).toBeGreaterThanOrEqual(0);
    expect(node.range.endByte).toBeLessThanOrEqual(facts.sourceByteLength);
    expect(node.range.startByte).toBeLessThanOrEqual(node.range.endByte);
    if (node.parentId) {
      expect(nodes.has(node.parentId)).toBe(true);
      expect(byId.get(node.parentId)?.childIds).toContain(node.id);
    }
    for (const child of node.childIds) {
      expect(nodes.has(child)).toBe(true);
      expect(byId.get(child)?.parentId).toBe(node.id);
    }
  }
  for (const edge of facts.relationships) {
    expect(edge.range.endByte).toBeLessThanOrEqual(facts.sourceByteLength);
    if (edge.sourceNodeId) expect(nodes.has(edge.sourceNodeId)).toBe(true);
  }
}

describe("project and resource format intelligence", () => {
  test("publishes an immutable evidence-backed format matrix", () => {
    expect(projectLanguageGroupManifest.groupId).toBe("project");
    expect(
      projectFormatCapabilities.map(({ format }) => format).sort(),
    ).toEqual((Object.keys(cases) as ProjectFormatId[]).sort());
    expect(
      projectFormatCapabilities.flatMap(({ extensions }) => extensions),
    ).toEqual(
      expect.arrayContaining([
        ".sln",
        ".slnx",
        ".csproj",
        ".fsproj",
        ".vbproj",
        ".xaml",
        ".lpk",
        ".lfm",
        ".dfm",
        ".props",
        ".targets",
        ".nuspec",
        "packages.config",
        ".resx",
        ".lpi",
      ]),
    );
    for (const item of projectFormatCapabilities) {
      expect(item).toMatchObject({
        parse: item.format === "delphi-form" ? "partial" : "supported",
        provider: "structured",
        rewrite: "unsupported",
      });
    }
    expect(Object.isFrozen(projectLanguageGroupManifest)).toBe(true);
    expect(Object.isFrozen(projectFormatCapabilities)).toBe(true);
    expect(Object.isFrozen(projectFormatCapabilities[0]?.limitations)).toBe(
      true,
    );
    expect(Object.isFrozen(projectFormatEvidence)).toBe(true);
    expect(Object.isFrozen(projectFormatEvidence.matrix.baseline)).toBe(true);
  });

  test("matches the pinned Graphify format and range golden", async () => {
    const golden = JSON.parse(await source("graphify-golden.json"));
    expect(golden.project).toEqual({
      name: "graphify",
      revision: "3f82bf7f837a07fb0f7668fbdbd5662801906942",
    });
    const actual: Record<string, ReturnType<typeof normalize>> = {};
    for (const [format, file] of Object.entries(cases) as [
      ProjectFormatId,
      string,
    ][]) {
      const facts = analyzeProjectFormat({
        format,
        source: await source(file),
        sourcePath: file,
      });
      actual[format] = normalize(facts);
      assertIntegrity(facts);
      expect(facts).toMatchObject({
        rewriteSupported: false,
        schemaVersion: "ast-mcp.project-facts.v1",
      });
      expect(Object.isFrozen(facts)).toBe(true);
      expect(Object.isFrozen(facts.nodes)).toBe(true);
    }
    expect(actual).toEqual(golden.cases);
    const variants = {
      "app.fsproj": "dotnet-project",
      "app.vbproj": "dotnet-project",
      "build.targets": "dotnet-build",
    } as const;
    const variantFacts: Record<string, ProjectFacts> = {};
    for (const [file, format] of Object.entries(variants)) {
      variantFacts[file] = analyzeProjectFormat({
        format,
        source: await source(file),
        sourcePath: file,
      });
      assertIntegrity(variantFacts[file]);
    }
    expect(variantFacts).toEqual(golden.variants);
  });

  test("extracts .NET projects, packages, references, and resources", async () => {
    const sln = analyzeProjectFormat({
      format: "dotnet-solution",
      source: await source("demo.sln"),
    });
    expect(sln.nodes[0]?.name).toBe("Café.App");
    expect(sln.relationships[0]).toMatchObject({
      kind: "reference",
      target: "src\\Café.App\\Café.App.csproj",
    });
    const project = analyzeProjectFormat({
      format: "dotnet-project",
      source: await source("app.csproj"),
    });
    expect(
      project.relationships.map(({ kind, target }) => [kind, target]),
    ).toEqual([
      ["dependency", "Newtonsoft.Json"],
      ["reference", "../Core/Core.csproj"],
      ["resource", "Resources/Strings.resx"],
    ]);
    for (const [format, file, target] of [
      ["dotnet-build", "build.props", "Analyzer.Package"],
      ["nuget-manifest", "package.nuspec", "Serilog"],
      ["nuget-packages", "packages.config", "NUnit"],
    ] as [ProjectFormatId, string, string][]) {
      expect(
        analyzeProjectFormat({ format, source: await source(file) })
          .relationships,
      ).toContainEqual(expect.objectContaining({ kind: "dependency", target }));
    }
    expect(
      analyzeProjectFormat({
        format: "dotnet-resource",
        source: await source("strings.resx"),
      }).nodes,
    ).toContainEqual(
      expect.objectContaining({ kind: "resource", name: "GreetingΩ" }),
    );
    expect(
      analyzeProjectFormat({
        format: "xaml",
        source: await source("main.xaml"),
      }).relationships,
    ).toContainEqual(
      expect.objectContaining({
        kind: "resource",
        target: "Themes/Colors.xaml",
      }),
    );
  });

  test("extracts Lazarus projects, packages, forms, and Delphi resources", async () => {
    const lpi = analyzeProjectFormat({
      format: "lazarus-project",
      source: await source("demo.lpi"),
    });
    expect(lpi.nodes).toContainEqual(
      expect.objectContaining({ kind: "project", name: "ProjectOptions" }),
    );
    expect(lpi.relationships).toContainEqual(
      expect.objectContaining({ kind: "resource", target: "src/main.pas" }),
    );
    const lpk = analyzeProjectFormat({
      format: "lazarus-package",
      source: await source("demo.lpk"),
    });
    expect(lpk.relationships.map(({ kind, target }) => [kind, target])).toEqual(
      [
        ["dependency", "LCL"],
        ["resource", "src/widget.pas"],
      ],
    );
    const lfm = analyzeProjectFormat({
      format: "lazarus-form",
      source: await source("demo.lfm"),
    });
    expect(
      lfm.nodes
        .filter(({ kind }) => kind === "component")
        .map(({ name }) => name),
    ).toEqual(["MainForm", "Button1"]);
    expect(lfm.relationships.map(({ target }) => target)).toEqual([
      "TMainForm",
      "TButton",
    ]);
    expect(
      analyzeProjectFormat({
        format: "delphi-form",
        source: await source("demo.dfm"),
      }).relationships,
    ).toContainEqual(
      expect.objectContaining({ kind: "resource", target: "Icon.Data" }),
    );
  });

  test("preserves UTF-8 provenance and deterministic identities", async () => {
    const text = await source("demo.sln");
    const first = analyzeProjectFormat({
      format: "dotnet-solution",
      source: text,
    });
    const repeat = analyzeProjectFormat({
      format: "dotnet-solution",
      source: text,
    });
    const changed = analyzeProjectFormat({
      format: "dotnet-solution",
      source: `${text}\n`,
    });
    expect(first.syntaxFactsArtifactId).toBe(repeat.syntaxFactsArtifactId);
    expect(first.syntaxFactsArtifactId).not.toBe(changed.syntaxFactsArtifactId);
    expect(first.nodes[0]?.range.endByte).toBeGreaterThan(
      first.nodes[0]?.range.endCoordinate.utf16Offset ?? 0,
    );
    expect(first.sourceByteLength).toBe(
      new TextEncoder().encode(text).byteLength,
    );
    expect(first.sourceArtifactId).toHaveLength(64);
    expect(first.parserFingerprint).toHaveLength(64);
  });

  test("reports malformed XML, solution, and form structures", async () => {
    const xml = analyzeProjectFormat({
      format: "dotnet-project",
      source: await source("malformed.csproj"),
    });
    expect(xml.partial).toBe(true);
    expect(
      xml.diagnostics.every(
        ({ code, severity }) =>
          code === "malformed-project" && severity === "error",
      ),
    ).toBe(true);
    const sln = analyzeProjectFormat({
      format: "dotnet-solution",
      source: 'Project("broken") = "Only"',
    });
    expect(sln.diagnostics[0]?.message).toContain("Malformed solution");
    const form = analyzeProjectFormat({
      format: "lazarus-form",
      source: await source("malformed.lfm"),
    });
    expect(form.diagnostics.map(({ message }) => message)).toEqual(
      expect.arrayContaining(["Resource component lacks a type separator"]),
    );
    expect(
      analyzeProjectFormat({ format: "delphi-form", source: "end\n" })
        .diagnostics[0]?.message,
    ).toBe("Unexpected resource component end");
  });

  test("handles XML delimiters and rejects malformed variants", () => {
    const valid = analyzeProjectFormat({
      format: "dotnet-project",
      source:
        '<?xml version="1.0"?><!--safe--><Project><PackageReference Include="Pkg"/></Project>',
    });
    expect(valid.partial).toBe(false);
    expect(valid.relationships[0]?.target).toBe("Pkg");
    const malformed = [
      "<Project><!-- open",
      "<?xml",
      "<Project",
      "<Project Broken></Project>",
      "<Project Value=noquote></Project>",
      '<Project Value="open></Project>',
      "< Project></Project>",
      "<Project></Other>",
    ];
    for (const text of malformed)
      expect(
        analyzeProjectFormat({ format: "dotnet-project", source: text })
          .partial,
      ).toBe(true);
  });

  test("handles namespaces, malformed XML subtrees, reciprocal form links, and binary DFM", () => {
    const namespaced = analyzeProjectFormat({
      format: "dotnet-project",
      source:
        '<msb:Project xmlns:msb="urn:test"><msb:PackageReference msb:Include="Namespaced.Package"/></msb:Project>',
    });
    expect(namespaced.relationships).toContainEqual(
      expect.objectContaining({
        kind: "dependency",
        target: "Namespaced.Package",
      }),
    );
    const malformed = analyzeProjectFormat({
      format: "dotnet-project",
      source:
        '<Project><ItemGroup><PackageReference Include="Ghost"></Wrong></ItemGroup><ItemGroup><PackageReference Include="Kept"/></ItemGroup></Project>',
    });
    expect(malformed.partial).toBe(true);
    expect(malformed.relationships.map(({ target }) => target)).toEqual([
      "Kept",
    ]);
    const form = analyzeProjectFormat({
      format: "lazarus-form",
      source: "object Parent: TForm\n  object Child: TButton\n  end\nend\n",
    });
    assertIntegrity(form);
    expect(form.nodes[0]?.childIds).toEqual([form.nodes[1]?.id]);
    for (const binary of ["TPF0binary", "object X: TForm\u0000payload"]) {
      const facts = analyzeProjectFormat({
        format: "delphi-form",
        source: binary,
      });
      expect(facts.partial).toBe(true);
      expect(facts.nodes).toEqual([]);
      expect(facts.relationships).toEqual([]);
      expect(facts.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "partial-format",
          message: expect.stringContaining("unsupported"),
          severity: "error",
        }),
      );
    }
  });

  test("records pinned Graphify provenance and golden integrity", async () => {
    expect(projectFormatEvidence.graphify).toEqual({
      inventoryPath: "graphify/detect.py",
      inventorySha256:
        "f6d71107e2c5092f73f5c1ba1d21898a44b6f06ada6ab7161aaae0cdaa7beece",
      repository: "https://github.com/Graphify-Labs/graphify",
      revision: "3f82bf7f837a07fb0f7668fbdbd5662801906942",
    });
    expect(projectFormatEvidence.matrix.baseline).toEqual(
      expect.arrayContaining([
        ".sln",
        ".slnx",
        ".csproj",
        ".lpk",
        ".lfm",
        ".dfm",
      ]),
    );
    expect(
      createHash("sha256")
        .update(await source("graphify-golden.json"))
        .digest("hex"),
    ).toBe("619818867b83dbf61470395ddeb52a5fc798f31a50d4bde27a7cf4e118b800ab");
  });
});
