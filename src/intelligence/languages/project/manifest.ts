import { INTELLIGENCE_SCHEMA_VERSION } from "../../contracts/common.ts";
import { sha256 } from "../../parser/index.ts";
import { deepFreeze } from "../immutable.ts";
import type {
  ProjectFormatCapability,
  ProjectLanguageGroupManifest,
} from "./types.ts";

export const projectFormatCapabilities: readonly ProjectFormatCapability[] =
  deepFreeze([
    {
      extensions: [".sln"],
      format: "dotnet-solution",
      limitations: [
        "Configuration sections are preserved as nodes only when they describe projects",
      ],
      parse: "supported",
      provider: "structured",
      rewrite: "unsupported",
      structuralRead: "supported",
    },
    {
      extensions: [".slnx"],
      format: "dotnet-solution-xml",
      limitations: [],
      parse: "supported",
      provider: "structured",
      rewrite: "unsupported",
      structuralRead: "supported",
    },
    {
      extensions: [".csproj", ".fsproj", ".vbproj"],
      format: "dotnet-project",
      limitations: [
        "MSBuild conditions and property expansion are not evaluated",
      ],
      parse: "supported",
      provider: "structured",
      rewrite: "unsupported",
      structuralRead: "supported",
    },
    {
      extensions: [".props", ".targets"],
      format: "dotnet-build",
      limitations: ["MSBuild imports and conditions are not evaluated"],
      parse: "supported",
      provider: "structured",
      rewrite: "unsupported",
      structuralRead: "supported",
    },
    {
      extensions: [".nuspec"],
      format: "nuget-manifest",
      limitations: ["NuGet version ranges are preserved without resolution"],
      parse: "supported",
      provider: "structured",
      rewrite: "unsupported",
      structuralRead: "supported",
    },
    {
      extensions: ["packages.config"],
      format: "nuget-packages",
      limitations: [
        "Package versions are preserved without restore resolution",
      ],
      parse: "supported",
      provider: "structured",
      rewrite: "unsupported",
      structuralRead: "supported",
    },
    {
      extensions: [".resx"],
      format: "dotnet-resource",
      limitations: ["Binary resource payloads remain opaque"],
      parse: "supported",
      provider: "structured",
      rewrite: "unsupported",
      structuralRead: "supported",
    },
    {
      extensions: [".xaml"],
      format: "xaml",
      limitations: [
        "Markup extensions and runtime resource lookup are not evaluated",
      ],
      parse: "supported",
      provider: "structured",
      rewrite: "unsupported",
      structuralRead: "supported",
    },
    {
      extensions: [".lpi"],
      format: "lazarus-project",
      limitations: ["IDE macros and conditional targets are not evaluated"],
      parse: "supported",
      provider: "structured",
      rewrite: "unsupported",
      structuralRead: "supported",
    },
    {
      extensions: [".lpk"],
      format: "lazarus-package",
      limitations: [
        "Package search paths and compiler conditions are not resolved",
      ],
      parse: "supported",
      provider: "structured",
      rewrite: "unsupported",
      structuralRead: "supported",
    },
    {
      extensions: [".lfm"],
      format: "lazarus-form",
      limitations: ["Encoded binary property blocks remain opaque"],
      parse: "supported",
      provider: "structured",
      rewrite: "unsupported",
      structuralRead: "supported",
    },
    {
      extensions: [".dfm"],
      format: "delphi-form",
      limitations: ["Binary DFM files require prior text conversion"],
      parse: "partial",
      provider: "structured",
      rewrite: "unsupported",
      structuralRead: "partial",
    },
  ]);
export const projectLanguageGroupManifest: ProjectLanguageGroupManifest =
  deepFreeze({
    capabilities: projectFormatCapabilities,
    groupId: "project",
    implementationFingerprint: sha256(
      JSON.stringify(projectFormatCapabilities),
    ),
    schemaVersion: INTELLIGENCE_SCHEMA_VERSION,
  });
