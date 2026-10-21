import { deepFreeze } from "../immutable.ts";

export const projectFormatEvidence = deepFreeze({
  matrix: {
    baseline: [
      ".sln",
      ".slnx",
      ".csproj",
      ".fsproj",
      ".vbproj",
      ".xaml",
      ".lpk",
      ".lfm",
      ".dfm",
    ],
    rationale:
      "Native project fixtures cover .NET and Lazarus manifests and resource files needed to materialize project, package, resource, and dependency relationships.",
    supporting: [
      ".props",
      ".targets",
      ".nuspec",
      "packages.config",
      ".resx",
      ".lpi",
    ],
  },
  reproduction: {
    command:
      "bun run tests/fixtures/intelligence/languages/project/verify-golden.ts",
    mapping:
      "Verify complete native facts and exact UTF-8 evidence ranges against native-golden.json.",
  },
  schemaVersion: "ast-mcp.project-provenance.v1",
});
