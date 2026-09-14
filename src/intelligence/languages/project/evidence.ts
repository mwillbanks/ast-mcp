import { deepFreeze } from "../immutable.ts";

export const projectFormatEvidence = deepFreeze({
  graphify: {
    inventoryPath: "graphify/detect.py",
    inventorySha256:
      "f6d71107e2c5092f73f5c1ba1d21898a44b6f06ada6ab7161aaae0cdaa7beece",
    repository: "https://github.com/Graphify-Labs/graphify",
    revision: "3f82bf7f837a07fb0f7668fbdbd5662801906942",
  },
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
      "Graphify identifies the baseline project formats. Native parsing adds adjacent .NET and Lazarus manifests and resource files needed to materialize project, package, resource, and dependency relationships.",
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
      "git clone https://github.com/Graphify-Labs/graphify && git -C graphify checkout 3f82bf7f837a07fb0f7668fbdbd5662801906942",
    mapping:
      "Read CODE_EXTENSIONS in graphify/detect.py, then normalize project, package, resource, dependency, and exact UTF-8 evidence ranges into graphify-golden.json.",
  },
  schemaVersion: "ast-mcp.project-provenance.v1",
});
