import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  analyzeDocument,
  DOCUMENT_GOLDEN_PROVENANCE,
  type DocumentFacts,
  type DocumentFormat,
  documentCapabilities,
  documentCapabilityFingerprint,
  rewriteDocumentInMemory,
} from "../src/intelligence/documents/index.ts";
import {
  SourceCoordinateIndex,
  sha256,
} from "../src/intelligence/parser/index.ts";

const root = join(import.meta.dir, "fixtures", "intelligence", "documents");
const fixture = (name: string) => Bun.file(join(root, name)).text();

describe("document intelligence", () => {
  test("extracts Markdown structure, references, tables, and mapped code", async () => {
    const source = await fixture("document.md");
    const first = await analyzeDocument({ format: "markdown", source });
    const second = await analyzeDocument({ format: "markdown", source });
    expect(first.sourceDigest).toBe(sha256(source));
    expect(first.sourceByteLength).toBe(
      new TextEncoder().encode(source).byteLength,
    );
    expect(first.encoding).toBe("utf-8");
    expect(first.syntaxFactsArtifactId).toBe(second.syntaxFactsArtifactId);
    expect(first.nodes.map(({ kind }) => kind)).toEqual(
      expect.arrayContaining([
        "frontmatter",
        "frontmatter-entry",
        "section",
        "table",
        "fenced-code",
      ]),
    );
    expect(
      first.nodes.find(
        ({ kind, name }) => kind === "section" && name === "Overview",
      )?.range.endCoordinate.utf16Offset,
    ).toBe(source.length);
    expect(first.references.map(({ kind }) => kind)).toEqual(
      expect.arrayContaining([
        "link",
        "wikilink",
        "adr",
        "rfc",
        "package",
        "code",
      ]),
    );
    const code = first.embeddedCode[0];
    expect(code?.languageId).toBe("ts");
    expect(code?.facts?.symbols.map(({ name }) => name)).toContain("Widget");
    expect(code?.facts?.inheritance[0]?.targetName).toBe("Base");
    expect(code?.facts?.implementations[0]?.targetName).toBe("Runnable");
    const widget = first.references.find(
      ({ kind, target }) => kind === "code" && target === "Widget",
    );
    expect(widget?.resolvedSymbolId).toBe(
      code?.facts?.symbols.find(({ name }) => name === "Widget")?.id,
    );
    const call = code?.facts?.calls.find(({ callee }) => callee === "build");
    if (!call) throw new Error("Expected mapped embedded call");
    expect(
      source.slice(
        call.range.startCoordinate.utf16Offset,
        call.range.endCoordinate.utf16Offset,
      ),
    ).toBe('build("🙂")');
    expect(call.range.startByte).toBe(
      new TextEncoder().encode(
        source.slice(0, call.range.startCoordinate.utf16Offset),
      ).byteLength,
    );
  });

  test("handles MDX, unsupported fences, CRLF, and malformed fences", async () => {
    const source = "# View\r\n\r\n```unknown\r\n<Thing />\r\n```\r\n";
    const facts = await analyzeDocument({ format: "mdx", source });
    expect(facts.embeddedCode[0]).toMatchObject({
      facts: null,
      languageId: "unknown",
    });
    expect(facts.diagnostics[0]?.code).toBe("unsupported-embedded-language");
    expect(facts.embeddedCode[0]?.hostRange.startCoordinate.line).toBe(3);
    const malformed = await analyzeDocument({
      format: "markdown",
      source: "# X\n```ts\nconst x = 1;",
    });
    expect(malformed.diagnostics[0]).toMatchObject({
      code: "malformed-document",
      severity: "error",
    });
    const frontmatter = await analyzeDocument({
      format: "markdown",
      source: "---\ntitle: broken\n# Heading",
    });
    expect(frontmatter.diagnostics[0]?.message).toBe("Unclosed frontmatter");
    const brokenCode = await analyzeDocument({
      format: "markdown",
      source: "```ts\nfunction broken(\n```",
    });
    expect(
      brokenCode.embeddedCode[0]?.facts?.diagnostics.length,
    ).toBeGreaterThan(0);
    const custom = await analyzeDocument({
      format: "markdown",
      parseEmbedded: async (_language, embedded) => {
        const parsed = await analyzeDocument({
          format: "txt",
          source: embedded,
        });
        expect(parsed.nodes).toHaveLength(1);
        return null;
      },
      source: "```custom\nvalue\n```",
    });
    expect(custom.diagnostics[0]?.code).toBe("unsupported-embedded-language");
  });

  test("parses JSON and JSONC with exact nested ranges and malformed recovery", async () => {
    const jsonc = await fixture("document.jsonc");
    const facts = await analyzeDocument({
      encoding: "utf-8",
      format: "jsonc",
      source: jsonc,
    });
    expect(facts.nodes.map(({ name }) => name)).toEqual(
      expect.arrayContaining(["name", "nested", "enabled", "count"]),
    );
    const name = facts.nodes.find((node) => node.name === "name");
    expect(
      jsonc.slice(
        name?.range.startCoordinate.utf16Offset,
        name?.range.endCoordinate.utf16Offset,
      ),
    ).toBe('"café"');
    const json = await analyzeDocument({
      format: "json",
      source: '{"items":[1,true,null,"x"]}',
    });
    expect(json.nodes.filter(({ kind }) => kind === "value")).toHaveLength(4);
    const malformed = await analyzeDocument({
      format: "json",
      source: '{"x":[1,2}',
    });
    expect(malformed.diagnostics[0]?.message).toContain("Unclosed JSON");
    const invalidLiteral = await analyzeDocument({
      format: "json",
      source: '{"value": nope}',
    });
    expect(invalidLiteral.diagnostics[0]?.message).toBe("Invalid JSON literal");
    const trailing = await analyzeDocument({
      format: "json",
      source: "{} trailing",
    });
    expect(trailing.diagnostics.at(-1)?.message).toBe(
      "Unexpected JSON content",
    );
  });

  test("enforces built-in JSON and JSONC semantics", async () => {
    const decoded = await analyzeDocument({
      format: "json",
      source: '{"caf\\u00e9":"line\\n\\ud83d\\ude42"}',
    });
    const value = decoded.nodes.find(({ name }) => name === "café");
    expect(value?.value).toBe("line\n🙂");
    expect(decoded.diagnostics).toEqual([]);

    const jsonc = await analyzeDocument({
      format: "jsonc",
      source: '{// comment\n"value":"ok",}',
    });
    expect(jsonc.diagnostics).toEqual([]);
    expect(jsonc.nodes.find(({ name }) => name === "value")?.value).toBe("ok");

    for (const source of [
      "",
      '{"value":"\\q"}',
      '{"value":"line\nfeed"}',
      '{"value":1,}',
      '{// comment\n"value":1}',
    ]) {
      const invalid = await analyzeDocument({ format: "json", source });
      expect(invalid.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "malformed-document",
          severity: "error",
        }),
      );
    }
  });

  test("rejects strict JSON rewrites that only JSONC permits", async () => {
    const source = '{"value":"ok"}';
    const facts = await analyzeDocument({ format: "json", source });
    const node = facts.nodes.find(({ name }) => name === "value");
    if (!node) throw new Error("Expected JSON value node");

    await expect(
      rewriteDocumentInMemory({
        expectedText: '"ok"',
        facts,
        nodeId: node.id,
        range: node.range,
        replacement: '"ok",',
        source,
      }),
    ).rejects.toThrow("malformed");
  });

  test("parses TOML and YAML without treating comments as properties", async () => {
    const toml = await analyzeDocument({
      format: "toml",
      source: await fixture("document.toml"),
    });
    expect(toml.nodes.map(({ kind }) => kind)).toEqual([
      "property",
      "section",
      "property",
    ]);
    const yaml = await analyzeDocument({
      format: "yaml",
      source: await fixture("document.yaml"),
    });
    expect(yaml.nodes.map(({ name }) => name)).toEqual([
      "title",
      "package",
      "name",
      "items",
      "name",
    ]);
    const comments = await analyzeDocument({
      format: "yaml",
      source: "# name: fake\nname: real\n",
    });
    expect(comments.nodes).toHaveLength(1);
  });

  test("tokenizes XML and HTML with hierarchy, comments, void tags, and errors", async () => {
    const xml = await analyzeDocument({
      format: "xml",
      source: await fixture("document.xml"),
    });
    const rootNode = xml.nodes.find(({ name }) => name === "root");
    const item = xml.nodes.find(({ name }) => name === "item");
    expect(item?.parentId).toBe(rootNode?.id);
    expect(xml.nodes.some(({ kind }) => kind === "comment")).toBeTrue();
    const htmlSource = await fixture("document.html");
    const html = await analyzeDocument({
      format: "html",
      source: htmlSource,
    });
    expect(html.nodes.map(({ name }) => name)).toEqual(
      expect.arrayContaining(["html", "body", "a", "br"]),
    );
    const link = html.references.find(
      ({ kind, target }) =>
        kind === "link" && target === "https://example.test",
    );
    expect(link).toBeDefined();
    expect(
      htmlSource.slice(
        link?.range.startCoordinate.utf16Offset,
        link?.range.endCoordinate.utf16Offset,
      ),
    ).toBe("https://example.test");
    const selfClosing = await analyzeDocument({
      format: "xml",
      source: '<root><item href="/safe"/></root>',
    });
    expect(selfClosing.diagnostics).toEqual([]);
    expect(selfClosing.references.map(({ target }) => target)).toEqual([
      "/safe",
    ]);
    const malformed = await analyzeDocument({
      format: "xml",
      source: "<root><item></root>",
    });
    expect(malformed.diagnostics.map(({ message }) => message)).toEqual([
      "Mismatched closing element </root>",
      "Unclosed element <root>",
      "Unclosed element <item>",
    ]);
  });

  test("extracts TXT paragraphs and explicit references without AST claims", async () => {
    const source = await fixture("document.txt");
    const facts = await analyzeDocument({ format: "txt", source });
    expect(facts.nodes.map(({ kind }) => kind)).toEqual([
      "paragraph",
      "paragraph",
    ]);
    expect(facts.references.map(({ kind }) => kind)).toEqual(
      expect.arrayContaining(["adr", "wikilink", "package", "rfc"]),
    );
    expect(
      documentCapabilities.find(({ format }) => format === "txt"),
    ).toMatchObject({
      parse: "partial",
      provider: "tokenizer",
      structuralRead: "partial",
    });
  });

  test("maps RTF text and references back to raw control-group ranges", async () => {
    const source = await fixture("document.rtf");
    const facts = await analyzeDocument({ format: "rtf", source });
    expect(facts.rtfText).toContain("Café ADR-42");
    expect(facts.rtfTextSegments.length).toBeGreaterThan(0);
    expect(
      facts.nodes.every(({ kind }) => kind === "control-group"),
    ).toBeTrue();
    const adr = facts.references.find(({ kind }) => kind === "adr");
    if (!adr) throw new Error("Expected mapped RTF ADR reference");
    expect(
      source.slice(
        adr.range.startCoordinate.utf16Offset,
        adr.range.endCoordinate.utf16Offset,
      ),
    ).toBe("ADR-42");
    expect(facts.rewriteSupported).toBeFalse();
    const malformed = await analyzeDocument({
      format: "rtf",
      source: "{\\rtf1 unclosed",
    });
    expect(malformed.diagnostics[0]?.message).toBe(
      "Unclosed RTF control group",
    );
    const hex = await analyzeDocument({
      format: "rtf",
      source: "{\\rtf1 caf\\'e9 \\u9786? \\{ok\\}}",
    });
    expect(hex.rtfText).toContain("café ☺ {ok}");
  });

  test("excludes hidden Markdown headings and tables from structural facts", async () => {
    const source = [
      "---",
      "title: Hidden",
      "# Frontmatter heading",
      "---",
      "<!--",
      "# Comment heading",
      "| hidden |",
      "| --- |",
      "-->",
      "```txt",
      "# Fence heading",
      "| hidden |",
      "| --- |",
      "```",
      "<script>",
      "# Raw heading",
      "| hidden |",
      "| --- |",
      "</script>",
      "# Real",
      "| visible |",
      "| --- |",
      "| value |",
      "",
    ].join("\n");
    const facts = await analyzeDocument({ format: "markdown", source });
    expect(
      facts.nodes
        .filter(({ kind }) => kind === "section")
        .map(({ name }) => name),
    ).toEqual(["Real"]);
    expect(facts.nodes.filter(({ kind }) => kind === "table")).toHaveLength(1);
    const table = facts.nodes.find(({ kind }) => kind === "table");
    expect(
      source.slice(
        table?.range.startCoordinate.utf16Offset,
        table?.range.endCoordinate.utf16Offset,
      ),
    ).toBe("| visible |\n| --- |\n| value |");
  });

  test("ignores fence markers in hidden Markdown regions", async () => {
    const source = [
      "---",
      "```frontmatter",
      "---",
      "<!--",
      "```comment",
      "-->",
      "{",
      "```mdx",
      "```",
      "}",
      "<script>",
      "```raw",
      "</script>",
      "# Real",
      "```ts",
      "const value = {",
      "```",
      "",
    ].join("\n");
    const facts = await analyzeDocument({ format: "mdx", source });
    expect(facts.diagnostics).toEqual([]);
    expect(facts.embeddedCode).toHaveLength(1);
    expect(facts.embeddedCode[0]).toMatchObject({
      languageId: "ts",
      source: "const value = {\n",
    });
    expect(
      facts.nodes
        .filter(({ kind }) => kind === "fenced-code")
        .map(({ name }) => name),
    ).toEqual(["ts"]);
    expect(
      facts.nodes.some(({ kind }) => kind === "malformed-fence"),
    ).toBeFalse();
  });

  test("parses MDX expressions without closing on lexical braces", async () => {
    const source = [
      "# View",
      "{",
      '  const quoted = "}";',
      "  const template = `} hidden`;",
      "  /* } hidden */",
      "  // } hidden",
      "  const object = { value: 1 };",
      "  # Hidden heading",
      "}",
      "ADR-13",
      "",
    ].join("\n");
    const facts = await analyzeDocument({ format: "mdx", source });
    expect(
      facts.nodes
        .filter(({ kind }) => kind === "section")
        .map(({ name }) => name),
    ).toEqual(["View"]);
    expect(facts.references.map(({ target }) => target)).toEqual(["13"]);
  });

  test("honors quoted greater-than characters in markup tags", async () => {
    const source =
      '<root><item data-label="x > y" href="/safe">ADR-1</item></root>';
    const facts = await analyzeDocument({ format: "xml", source });
    expect(facts.diagnostics).toEqual([]);
    expect(facts.references.map(({ target }) => target)).toEqual([
      "/safe",
      "1",
    ]);
    const item = facts.nodes.find(({ name }) => name === "item");
    expect(
      source.slice(
        item?.range.startCoordinate.utf16Offset,
        item?.range.endCoordinate.utf16Offset,
      ),
    ).toBe('<item data-label="x > y" href="/safe">ADR-1</item>');
  });

  test("excludes references from syntax-hidden regions", async () => {
    const markdown = await analyzeDocument({
      format: "markdown",
      source:
        "---\nnote: ADR-1\n---\n<!-- RFC-2 -->\n<script>RFC-10</script>\n# Visible\nADR-3 and `Live`\n\n```txt\nADR-4 and `Hidden`\n```",
    });
    expect(markdown.references.map(({ target }) => target)).toEqual([
      "3",
      "Live",
    ]);

    const mdx = await analyzeDocument({
      format: "mdx",
      source: '# View\n{"ADR-11 and RFC-12"}\nADR-13\n',
    });
    expect(mdx.references.map(({ target }) => target)).toEqual(["13"]);

    const json = await analyzeDocument({
      format: "jsonc",
      source: '{/* ADR-5 */ "note": "RFC-6 and @scope/hidden"}',
    });
    expect(json.references).toEqual([]);

    const html = await analyzeDocument({
      format: "html",
      source:
        '<!-- ADR-7 --><script>"RFC-8"</script><p>ADR-9</p><a href="/live">x</a>',
    });
    expect(html.references.map(({ target }) => target)).toEqual(["9", "/live"]);
  });

  test("decodes UTF-8 bytes and rejects dishonest encoding metadata", async () => {
    const source = "# Café\n";
    const textFacts = await analyzeDocument({ format: "markdown", source });
    const byteFacts = await analyzeDocument({
      format: "markdown",
      source: new TextEncoder().encode(source),
    });
    expect(byteFacts.sourceDigest).toBe(textFacts.sourceDigest);
    expect(byteFacts.sourceByteLength).toBe(8);
    await expect(
      analyzeDocument({
        encoding: "latin1",
        format: "txt",
        source,
      }),
    ).rejects.toThrow("only UTF-8");
    await expect(
      analyzeDocument({
        format: "txt",
        source: new Uint8Array([0xff]),
      }),
    ).rejects.toThrow();
  });

  test("resolves duplicate embedded symbols using section evidence", async () => {
    const source =
      "# First\n`Widget`\n```ts\nclass Widget {}\n```\n# Second\n`Widget`\n```ts\nclass Widget {}\n```\n";
    const facts = await analyzeDocument({ format: "markdown", source });
    const references = facts.references.filter(({ kind }) => kind === "code");
    expect(references).toHaveLength(2);
    expect(references.map(({ resolvedSymbolId }) => resolvedSymbolId)).toEqual(
      facts.embeddedCode.map(
        ({ facts: embedded }) =>
          embedded?.symbols.find(({ name }) => name === "Widget")?.id ?? null,
      ),
    );
  });

  test("matches complete revision-provenanced document goldens", async () => {
    const golden = await Bun.file(join(root, "document-goldens.json")).json();
    expect(golden.provenance).toEqual(DOCUMENT_GOLDEN_PROVENANCE);
    expect(golden.capabilities).toEqual(documentCapabilities);
    for (const record of golden.records as Array<{
      facts: DocumentFacts;
      fixture: string;
      fixtureSha256: string;
      format: DocumentFormat;
    }>) {
      const source = await fixture(record.fixture);
      expect(sha256(source)).toBe(record.fixtureSha256);
      expect(await analyzeDocument({ format: record.format, source })).toEqual(
        record.facts,
      );
    }
    const unsupportedSource = await fixture(golden.unsupported.fixture);
    expect(sha256(unsupportedSource)).toBe(golden.unsupported.fixtureSha256);
    expect(
      await analyzeDocument({
        format: golden.unsupported.format as DocumentFormat,
        source: unsupportedSource,
      }),
    ).toEqual(golden.unsupported.facts);
  });

  test("publishes honest deterministic capabilities", () => {
    expect(documentCapabilities.map(({ format }) => format)).toEqual([
      "markdown",
      "mdx",
      "json",
      "jsonc",
      "toml",
      "yaml",
      "xml",
      "html",
      "txt",
      "rtf",
    ] satisfies DocumentFormat[]);
    expect(documentCapabilityFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(DOCUMENT_GOLDEN_PROVENANCE).toEqual({
      graphifyRevision: "3f82bf7f837a07fb0f7668fbdbd5662801906942",
      schemaVersion: "ast-mcp.document-goldens.v1",
    });
    expect(
      documentCapabilities
        .filter(({ format }) => format === "json" || format === "jsonc")
        .every(({ rewrite }) => rewrite === "supported"),
    ).toBeTrue();
    expect(
      documentCapabilities
        .filter(({ format }) => format !== "json" && format !== "jsonc")
        .every(({ rewrite }) => rewrite === "unsupported"),
    ).toBeTrue();
  });

  test("performs guarded round-trip-preserving in-memory rewrites", async () => {
    const source = await fixture("document.jsonc");
    const facts = await analyzeDocument({ format: "jsonc", source });
    const node = facts.nodes.find(({ name }) => name === "name");
    if (!node) throw new Error("Expected JSON name node");
    const changed = await rewriteDocumentInMemory({
      expectedText: '"café"',
      facts,
      nodeId: node.id,
      range: node.range,
      replacement: '"résumé"',
      source,
    });
    expect(changed.source).toContain('"name": "résumé"');
    expect(changed.facts.diagnostics).toEqual([]);
    expect(changed.source.replace('"résumé"', '"café"')).toBe(source);
    await expect(
      rewriteDocumentInMemory({
        expectedText: '"café"',
        facts,
        nodeId: "not-a-node",
        range: node.range,
        replacement: '"x"',
        source,
      }),
    ).rejects.toThrow("one analyzed structural node");
    await expect(
      rewriteDocumentInMemory({
        expectedText: "wrong",
        facts,
        nodeId: node.id,
        range: node.range,
        replacement: '"x"',
        source,
      }),
    ).rejects.toThrow("evidence does not match");
    await expect(
      rewriteDocumentInMemory({
        expectedText: '"café"',
        facts,
        nodeId: node.id,
        range: node.range,
        replacement: "[",
        source,
      }),
    ).rejects.toThrow("malformed");
    const other = await analyzeDocument({ format: "jsonc", source: "{}" });
    await expect(
      rewriteDocumentInMemory({
        expectedText: '"café"',
        facts: other,
        nodeId: node.id,
        range: node.range,
        replacement: '"x"',
        source,
      }),
    ).rejects.toThrow("does not match analyzed facts");
    const markdownSource = "# Heading\ntext\n";
    const markdownFacts = await analyzeDocument({
      format: "markdown",
      source: markdownSource,
    });
    await expect(
      rewriteDocumentInMemory({
        expectedText: markdownSource,
        facts: markdownFacts,
        nodeId: markdownFacts.nodes[0]?.id ?? "",
        range: markdownFacts.nodes[0]?.range ?? node.range,
        replacement: "# Changed\n",
        source: markdownSource,
      }),
    ).rejects.toThrow("unavailable");

    const rtfSource = await fixture("document.rtf");
    const rtfFacts = await analyzeDocument({
      format: "rtf",
      source: rtfSource,
    });
    await expect(
      rewriteDocumentInMemory({
        expectedText: "Café",
        facts: rtfFacts,
        nodeId: rtfFacts.nodes[0]?.id ?? "",
        range: new SourceCoordinateIndex(rtfSource).range(12, 16),
        replacement: "Cafe",
        source: rtfSource,
      }),
    ).rejects.toThrow("unavailable");
  });
});
