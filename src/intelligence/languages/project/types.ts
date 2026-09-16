import type { ExactSourceRange } from "../../parser/index.ts";

export type ProjectFormatId =
  | "dotnet-solution"
  | "dotnet-solution-xml"
  | "dotnet-project"
  | "dotnet-build"
  | "nuget-manifest"
  | "nuget-packages"
  | "dotnet-resource"
  | "xaml"
  | "lazarus-project"
  | "lazarus-package"
  | "lazarus-form"
  | "delphi-form";

export type ProjectNodeKind =
  | "project"
  | "package"
  | "resource"
  | "component"
  | "property"
  | "element";
export type ProjectRelationshipKind =
  | "dependency"
  | "reference"
  | "resource"
  | "type-reference";

export interface ProjectNode {
  attributes: Readonly<Record<string, string>>;
  childIds: readonly string[];
  id: string;
  kind: ProjectNodeKind;
  name: string;
  parentId: string | null;
  range: ExactSourceRange;
}
export interface ProjectRelationship {
  id: string;
  kind: ProjectRelationshipKind;
  range: ExactSourceRange;
  sourceNodeId: string | null;
  target: string;
}
export interface ProjectDiagnostic {
  code: "malformed-project" | "partial-format";
  message: string;
  range: ExactSourceRange;
  severity: "error" | "warning";
}
export interface ProjectFacts {
  diagnostics: readonly ProjectDiagnostic[];
  format: ProjectFormatId;
  nodes: readonly ProjectNode[];
  parserFingerprint: string;
  partial: boolean;
  relationships: readonly ProjectRelationship[];
  rewriteSupported: false;
  schemaVersion: "ast-mcp.project-facts.v1";
  sourceArtifactId: string;
  sourceByteLength: number;
  sourceDigest: string;
  syntaxFactsArtifactId: string;
}
export interface ProjectAnalyzeRequest {
  format: ProjectFormatId;
  source: string;
  sourcePath?: string;
}
export interface ProjectFormatCapability {
  extensions: readonly string[];
  format: ProjectFormatId;
  limitations: readonly string[];
  parse: "supported" | "partial";
  provider: "structured";
  rewrite: "unsupported";
  structuralRead: "supported" | "partial";
}
export interface ProjectLanguageGroupManifest {
  capabilities: readonly ProjectFormatCapability[];
  groupId: "project";
  implementationFingerprint: string;
  schemaVersion: "ast-mcp.intelligence.v1";
}
