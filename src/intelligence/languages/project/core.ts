import { SourceCoordinateIndex, sha256 } from "../../parser/index.ts";
import type {
  ProjectAnalyzeRequest,
  ProjectDiagnostic,
  ProjectFacts,
  ProjectFormatId,
  ProjectNode,
  ProjectNodeKind,
  ProjectRelationship,
  ProjectRelationshipKind,
} from "./types.ts";

interface RawAttribute {
  name: string;
  range: [number, number];
  value: string;
}
interface RawElement {
  attributes: RawAttribute[];
  children: RawElement[];
  end: number;
  invalid: boolean;
  name: string;
  parent?: RawElement;
  start: number;
}
const xmlFormats = new Set<ProjectFormatId>([
  "dotnet-solution-xml",
  "dotnet-project",
  "dotnet-build",
  "nuget-manifest",
  "nuget-packages",
  "dotnet-resource",
  "xaml",
  "lazarus-project",
  "lazarus-package",
]);
const encoder = new TextEncoder();
function utf8Offset(source: string, characterOffset: number): number {
  return encoder.encode(source.slice(0, characterOffset)).byteLength;
}
function byteToUtf16(source: string, target: number): number {
  let bytes = 0,
    offset = 0;
  for (const ch of source) {
    if (bytes >= target) break;
    bytes += encoder.encode(ch).byteLength;
    offset += ch.length;
  }
  return offset;
}
function isName(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    ["_", "-", ":", "."].includes(character)
  );
}
function skipSpace(source: string, index: number): number {
  while (
    index < source.length &&
    [" ", "\t", "\r", "\n"].includes(source[index] ?? "")
  )
    index++;
  return index;
}
function xml(source: string): {
  diagnostics: [number, number, string][];
  roots: RawElement[];
} {
  const roots: RawElement[] = [];
  const stack: RawElement[] = [];
  const diagnostics: [number, number, string][] = [];
  let i = 0;
  while (i < source.length) {
    const open = source.indexOf("<", i);
    if (open < 0) break;
    if (source.startsWith("<!--", open)) {
      const end = source.indexOf("-->", open + 4);
      if (end < 0) {
        diagnostics.push([
          utf8Offset(source, open),
          encoder.encode(source).byteLength,
          "Unclosed XML comment",
        ]);
        break;
      }
      i = end + 3;
      continue;
    }
    if (source.startsWith("<?", open) || source.startsWith("<!", open)) {
      const end = source.indexOf(">", open + 2);
      if (end < 0) {
        diagnostics.push([
          utf8Offset(source, open),
          encoder.encode(source).byteLength,
          "Unclosed XML declaration",
        ]);
        break;
      }
      i = end + 1;
      continue;
    }
    if (source.startsWith("</", open)) {
      let p = skipSpace(source, open + 2);
      const start = p;
      while (p < source.length && isName(source[p] ?? "")) p++;
      const name = source.slice(start, p);
      const close = source.indexOf(">", p);
      if (close < 0) {
        diagnostics.push([
          utf8Offset(source, open),
          encoder.encode(source).byteLength,
          "Unclosed XML end tag",
        ]);
        break;
      }
      const current = stack.pop();
      if (!current || localName(current.name) !== localName(name)) {
        if (current) current.invalid = true;
        diagnostics.push([
          utf8Offset(source, open),
          utf8Offset(source, close + 1),
          `Mismatched XML end tag: ${name}`,
        ]);
      } else current.end = utf8Offset(source, close + 1);
      i = close + 1;
      continue;
    }
    if (skipSpace(source, open + 1) !== open + 1) {
      diagnostics.push([
        utf8Offset(source, open),
        utf8Offset(source, Math.min(open + 2, source.length)),
        "XML start tags cannot contain leading whitespace",
      ]);
      i = open + 1;
      continue;
    }
    let p = open + 1;
    const nameStart = p;
    while (p < source.length && isName(source[p] ?? "")) p++;
    const name = source.slice(nameStart, p);
    if (!name) {
      diagnostics.push([
        utf8Offset(source, open),
        utf8Offset(source, open + 1),
        "Invalid XML start tag",
      ]);
      i = open + 1;
      continue;
    }
    const attributes: RawAttribute[] = [];
    let selfClosing = false;
    let closed = false;
    while (p < source.length) {
      p = skipSpace(source, p);
      if (source.startsWith("/>", p)) {
        selfClosing = true;
        closed = true;
        p += 2;
        break;
      }
      if (source[p] === ">") {
        closed = true;
        p++;
        break;
      }
      const attrStart = p;
      while (p < source.length && isName(source[p] ?? "")) p++;
      const attrName = source.slice(attrStart, p);
      p = skipSpace(source, p);
      if (!attrName || source[p] !== "=") {
        diagnostics.push([
          utf8Offset(source, attrStart),
          utf8Offset(source, Math.min(p + 1, source.length)),
          "Invalid XML attribute",
        ]);
        const end = source.indexOf(">", p);
        p = end < 0 ? source.length : end + 1;
        closed = end >= 0;
        break;
      }
      p = skipSpace(source, p + 1);
      const quote = source[p];
      if (quote !== '"' && quote !== "'") {
        diagnostics.push([
          utf8Offset(source, p),
          utf8Offset(source, Math.min(p + 1, source.length)),
          "XML attribute value must be quoted",
        ]);
        continue;
      }
      const valueStart = ++p;
      while (p < source.length && source[p] !== quote) p++;
      if (p >= source.length) {
        diagnostics.push([
          utf8Offset(source, valueStart),
          encoder.encode(source).byteLength,
          "Unclosed XML attribute value",
        ]);
        break;
      }
      attributes.push({
        name: attrName,
        range: [utf8Offset(source, valueStart), utf8Offset(source, p)],
        value: source.slice(valueStart, p),
      });
      p++;
    }
    if (!closed) {
      diagnostics.push([
        utf8Offset(source, open),
        encoder.encode(source).byteLength,
        `Unclosed XML start tag: ${name}`,
      ]);
      break;
    }
    const element: RawElement = {
      attributes,
      children: [],
      end: utf8Offset(source, p),
      invalid: false,
      name,
      start: utf8Offset(source, open),
    };
    const parent = stack.at(-1);
    if (parent) {
      element.parent = parent;
      parent.children.push(element);
    } else roots.push(element);
    if (!selfClosing) stack.push(element);
    i = p;
  }
  for (const pending of stack) {
    pending.invalid = true;
    diagnostics.push([
      pending.start,
      pending.end,
      `Unclosed XML element: ${pending.name}`,
    ]);
  }
  return { diagnostics, roots };
}
function flatten(roots: RawElement[]): RawElement[] {
  const result: RawElement[] = [];
  const visit = (node: RawElement) => {
    result.push(node);
    for (const child of node.children) visit(child);
  };
  for (const root of roots) visit(root);
  return result;
}
function localName(name: string): string {
  return name.includes(":") ? (name.split(":").at(-1) ?? name) : name;
}
function attribute(
  element: RawElement,
  ...names: string[]
): RawAttribute | undefined {
  return element.attributes.find((item) =>
    names.includes(localName(item.name)),
  );
}
function elementKind(
  format: ProjectFormatId,
  element: RawElement,
): ProjectNodeKind {
  const name = localName(element.name);
  if (["Project", "Solution", "Package"].includes(name)) return "project";
  if (
    [
      "PackageReference",
      "FrameworkReference",
      "dependency",
      "package",
    ].includes(name)
  )
    return "package";
  if (format === "dotnet-resource" && name === "data") return "resource";
  if (format === "xaml" && name === "ResourceDictionary") return "resource";
  if (
    format === "xaml" &&
    (element.name.includes(":") || name === "Application")
  )
    return "component";
  if (format === "lazarus-project" && name === "ProjectOptions")
    return "project";
  return "element";
}
function xmlFacts(
  format: ProjectFormatId,
  source: string,
): {
  diagnostics: ProjectDiagnostic[];
  nodes: ProjectNode[];
  relationships: ProjectRelationship[];
} {
  const parsed = xml(source);
  const coordinates = new SourceCoordinateIndex(source);
  const sourceDigest = sha256(source);
  const raw = flatten(parsed.roots).filter((element) => {
    let current: RawElement | undefined = element;
    while (current) {
      if (current.invalid) return false;
      current = current.parent;
    }
    return true;
  });
  const rawIds = new Map<RawElement, string>();
  const range = (start: number, end: number) =>
    coordinates.range(byteToUtf16(source, start), byteToUtf16(source, end));
  for (const element of raw)
    rawIds.set(
      element,
      sha256(
        JSON.stringify([sourceDigest, "element", element.name, element.start]),
      ),
    );
  const nodes: ProjectNode[] = raw.map((element) => {
    const attrs = Object.fromEntries(
      element.attributes.map((item) => [item.name, item.value]),
    );
    const identity =
      attribute(element, "Include", "Path", "Name", "Value", "name")?.value ??
      localName(element.name);
    return {
      attributes: Object.freeze(attrs),
      childIds: Object.freeze(
        element.children.map((child) => rawIds.get(child) ?? ""),
      ),
      id: rawIds.get(element) ?? "",
      kind: elementKind(format, element),
      name: identity,
      parentId: element.parent ? (rawIds.get(element.parent) ?? null) : null,
      range: range(element.start, element.end),
    };
  });
  const relationships: ProjectRelationship[] = [];
  const add = (
    element: RawElement,
    target: RawAttribute,
    kind: ProjectRelationshipKind,
  ) =>
    relationships.push({
      id: sha256(
        JSON.stringify([sourceDigest, kind, target.value, target.range[0]]),
      ),
      kind,
      range: range(...target.range),
      sourceNodeId: rawIds.get(element) ?? null,
      target: target.value,
    });
  for (const element of raw) {
    const name = localName(element.name);
    const include = attribute(
      element,
      "Include",
      "Path",
      "Project",
      "Filename",
      "Value",
      "Source",
      "name",
      "id",
    );
    if (!include) continue;
    if (
      [
        "PackageReference",
        "FrameworkReference",
        "dependency",
        "package",
        "RequiredPackage",
        "PackageName",
      ].includes(name)
    )
      add(element, include, "dependency");
    else if (
      ["ProjectReference", "Project"].includes(name) &&
      include.value.toLowerCase().includes("proj")
    )
      add(element, include, "reference");
    else if (
      [
        "EmbeddedResource",
        "Resource",
        "Page",
        "Content",
        "data",
        "File",
        "Unit",
        "Filename",
        "UnitName",
        "ResourceDictionary",
      ].includes(name)
    )
      add(element, include, "resource");
    else if (["Reference", "Type"].includes(name))
      add(element, include, "type-reference");
  }
  return {
    diagnostics: parsed.diagnostics.map(([start, end, message]) => ({
      code: "malformed-project",
      message,
      range: range(start, end),
      severity: "error",
    })),
    nodes,
    relationships,
  };
}
function quoted(line: string): { end: number; start: number; value: string }[] {
  const values: { end: number; start: number; value: string }[] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] !== '"') {
      i++;
      continue;
    }
    const start = ++i;
    while (i < line.length && line[i] !== '"') i++;
    values.push({ end: i, start, value: line.slice(start, i) });
    i++;
  }
  return values;
}
function lineRanges(
  source: string,
): { end: number; start: number; text: string }[] {
  const result = [] as { end: number; start: number; text: string }[];
  let offset = 0;
  for (const text of source.split("\n")) {
    const bytes = encoder.encode(text).byteLength;
    result.push({ end: offset + bytes, start: offset, text });
    offset += bytes + 1;
  }
  return result;
}
function slnFacts(source: string): {
  diagnostics: ProjectDiagnostic[];
  nodes: ProjectNode[];
  relationships: ProjectRelationship[];
} {
  const coordinates = new SourceCoordinateIndex(source);
  const digest = sha256(source);
  const nodes: ProjectNode[] = [];
  const relationships: ProjectRelationship[] = [];
  const diagnostics: ProjectDiagnostic[] = [];
  const range = (start: number, end: number) =>
    coordinates.range(byteToUtf16(source, start), byteToUtf16(source, end));
  for (const line of lineRanges(source)) {
    const trimmed = line.text.trimStart();
    const leading = line.text.length - trimmed.length;
    if (!trimmed.startsWith("Project(")) continue;
    const values = quoted(trimmed);
    if (values.length < 4) {
      diagnostics.push({
        code: "malformed-project",
        message: "Malformed solution project record",
        range: range(line.start, line.end),
        severity: "error",
      });
      continue;
    }
    const name = values[1];
    const path = values[2];
    if (!name || !path) continue;
    const nameStart = line.start + utf8Offset(line.text, leading + name.start);
    const id = sha256(
      JSON.stringify([digest, "project", name.value, nameStart]),
    );
    nodes.push({
      attributes: Object.freeze({
        guid: values[3]?.value ?? "",
        path: path.value,
        typeGuid: values[0]?.value ?? "",
      }),
      childIds: Object.freeze([]),
      id,
      kind: "project",
      name: name.value,
      parentId: null,
      range: range(line.start, line.end),
    });
    const pathStart = line.start + utf8Offset(line.text, leading + path.start);
    relationships.push({
      id: sha256(JSON.stringify([digest, "reference", path.value, pathStart])),
      kind: "reference",
      range: range(
        pathStart,
        line.start + utf8Offset(line.text, leading + path.end),
      ),
      sourceNodeId: id,
      target: path.value,
    });
  }
  return { diagnostics, nodes, relationships };
}
function formFacts(
  _format: ProjectFormatId,
  source: string,
): {
  diagnostics: ProjectDiagnostic[];
  nodes: ProjectNode[];
  relationships: ProjectRelationship[];
} {
  const coordinates = new SourceCoordinateIndex(source);
  const digest = sha256(source);
  const nodes: ProjectNode[] = [];
  const relationships: ProjectRelationship[] = [];
  const diagnostics: ProjectDiagnostic[] = [];
  const stack: string[] = [];
  const range = (start: number, end: number) =>
    coordinates.range(byteToUtf16(source, start), byteToUtf16(source, end));
  for (const line of lineRanges(source)) {
    const text = line.text.trim();
    const lower = text.toLowerCase();
    if (
      lower.startsWith("object ") ||
      lower.startsWith("inherited ") ||
      lower.startsWith("inline ")
    ) {
      const space = text.indexOf(" ");
      const colon = text.indexOf(":", space + 1);
      if (colon < 0) {
        diagnostics.push({
          code: "malformed-project",
          message: "Resource component lacks a type separator",
          range: range(line.start, line.end),
          severity: "error",
        });
        continue;
      }
      const name = text.slice(space + 1, colon).trim();
      const target = text.slice(colon + 1).trim();
      const id = sha256(
        JSON.stringify([digest, "component", name, line.start]),
      );
      nodes.push({
        attributes: Object.freeze({ type: target }),
        childIds: [],
        id,
        kind: "component",
        name,
        parentId: stack.at(-1) ?? null,
        range: range(line.start, line.end),
      });
      relationships.push({
        id: sha256(
          JSON.stringify([
            digest,
            "type-reference",
            target,
            line.start + colon + 1,
          ]),
        ),
        kind: "type-reference",
        range: range(
          line.start + utf8Offset(line.text, line.text.indexOf(target)),
          line.start + encoder.encode(line.text).byteLength,
        ),
        sourceNodeId: id,
        target,
      });
      stack.push(id);
      continue;
    }
    if (lower === "end") {
      if (!stack.pop())
        diagnostics.push({
          code: "malformed-project",
          message: "Unexpected resource component end",
          range: range(line.start, line.end),
          severity: "error",
        });
      continue;
    }
    const equals = text.indexOf("=");
    if (equals > 0 && stack.length) {
      const name = text.slice(0, equals).trim();
      const value = text.slice(equals + 1).trim();
      const id = sha256(JSON.stringify([digest, "property", name, line.start]));
      nodes.push({
        attributes: Object.freeze({ value }),
        childIds: [],
        id,
        kind: "property",
        name,
        parentId: stack.at(-1) ?? null,
        range: range(line.start, line.end),
      });
      if (["Icon.Data", "Picture.Data", "Glyph.Data"].includes(name))
        relationships.push({
          id: sha256(JSON.stringify([digest, "resource", name, line.start])),
          kind: "resource",
          range: range(line.start, line.end),
          sourceNodeId: id,
          target: name,
        });
    }
  }
  if (stack.length)
    diagnostics.push({
      code: "malformed-project",
      message: "Unclosed resource component",
      range: range(0, encoder.encode(source).byteLength),
      severity: "error",
    });
  const childIds = new Map<string, string[]>();
  for (const node of nodes) {
    if (!node.parentId) continue;
    const children = childIds.get(node.parentId) ?? [];
    children.push(node.id);
    childIds.set(node.parentId, children);
  }
  return {
    diagnostics,
    nodes: nodes.map((node) => ({
      ...node,
      childIds: Object.freeze(childIds.get(node.id) ?? []),
    })),
    relationships,
  };
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>))
      deepFreeze(child);
  }
  return value;
}
export function analyzeProjectFormat(
  request: ProjectAnalyzeRequest,
): ProjectFacts {
  const { format, source } = request;
  if (
    format === "delphi-form" &&
    (source.startsWith("TPF0") || source.includes("\0"))
  ) {
    const sourceDigest = sha256(source);
    const sourceArtifactId = sha256(JSON.stringify(["source", sourceDigest]));
    const parserFingerprint = sha256(
      JSON.stringify(["ast-mcp-project-parser-v1", format]),
    );
    const coordinates = new SourceCoordinateIndex(source);
    const diagnostics: ProjectDiagnostic[] = [
      {
        code: "partial-format",
        message:
          "Binary Delphi DFM input is unsupported; convert it to text first",
        range: coordinates.range(0, source.length),
        severity: "error",
      },
    ];
    return deepFreeze({
      diagnostics,
      format,
      nodes: [],
      parserFingerprint,
      partial: true,
      relationships: [],
      rewriteSupported: false,
      schemaVersion: "ast-mcp.project-facts.v1",
      sourceArtifactId,
      sourceByteLength: encoder.encode(source).byteLength,
      sourceDigest,
      syntaxFactsArtifactId: sha256(
        JSON.stringify([
          sourceArtifactId,
          parserFingerprint,
          [],
          [],
          diagnostics.map(({ code, range }) => [
            code,
            range.startByte,
            range.endByte,
          ]),
        ]),
      ),
    });
  }
  let parsed: ReturnType<typeof xmlFacts>;
  if (xmlFormats.has(format)) parsed = xmlFacts(format, source);
  else if (format === "dotnet-solution") parsed = slnFacts(source);
  else parsed = formFacts(format, source);
  const sourceDigest = sha256(source);
  const sourceArtifactId = sha256(JSON.stringify(["source", sourceDigest]));
  const parserFingerprint = sha256(
    JSON.stringify(["ast-mcp-project-parser-v1", format]),
  );
  const partial = parsed.diagnostics.some(
    ({ severity }) => severity === "error",
  );
  return deepFreeze({
    diagnostics: parsed.diagnostics,
    format,
    nodes: parsed.nodes,
    parserFingerprint,
    partial,
    relationships: parsed.relationships,
    rewriteSupported: false,
    schemaVersion: "ast-mcp.project-facts.v1",
    sourceArtifactId,
    sourceByteLength: encoder.encode(source).byteLength,
    sourceDigest,
    syntaxFactsArtifactId: sha256(
      JSON.stringify([
        sourceArtifactId,
        parserFingerprint,
        parsed.nodes.map(({ id }) => id),
        parsed.relationships.map(({ id }) => id),
        parsed.diagnostics.map(({ code, range }) => [
          code,
          range.startByte,
          range.endByte,
        ]),
      ]),
    ),
  });
}
