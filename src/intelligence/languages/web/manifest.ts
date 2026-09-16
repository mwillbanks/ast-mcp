import { INTELLIGENCE_SCHEMA_VERSION } from "../../contracts/common.ts";
import type {
  CapabilityClaim,
  LanguageCapability,
} from "../../contracts/language.ts";
import { LanguageCapabilitySchema } from "../../contracts/language.ts";
import { sha256 } from "../../parser/index.ts";
import { analyzeCompilerLanguage, compilerFingerprint } from "./compiler.ts";
import { analyzeTypeScriptProject } from "./compiler-project.ts";
import { analyzeTemplate } from "./templates.ts";
import type {
  WebLanguageAdapter,
  WebLanguageGroupManifest,
  WebLanguageId,
} from "./types.ts";

const templateFingerprint = sha256("ast-mcp.web.templates.v2");

function claim(
  status: "supported" | "partial",
  provider: CapabilityClaim["provider"],
  implementationFingerprint: string,
  limitations: string[] = [],
): CapabilityClaim {
  return { implementationFingerprint, limitations, provider, status };
}

function unsupported(message: string): CapabilityClaim {
  return {
    implementationFingerprint: null,
    limitations: [message],
    provider: "none",
    status: "unsupported",
  };
}

function compilerCapability(
  languageId: WebLanguageId,
  extensions: string[],
): LanguageCapability {
  return LanguageCapabilitySchema.parse({
    callResolution: claim("partial", "custom", compilerFingerprint, [
      "Dynamic dispatch and runtime module loading remain unresolved",
    ]),
    embeddedLanguageIds: [],
    embeddedLanguages: unsupported(
      "This source format has no embedded language boundary",
    ),
    exportResolution: claim("supported", "custom", compilerFingerprint),
    extensions,
    importResolution: claim("partial", "custom", compilerFingerprint, [
      "Package and paths resolution require a caller-supplied reusable compilerProgram",
    ]),
    inheritanceResolution: claim("partial", "custom", compilerFingerprint, [
      "Runtime prototype mutation remains unresolved",
    ]),
    languageId,
    match: claim("supported", "ast-grep", compilerFingerprint),
    parse: claim("supported", "custom", compilerFingerprint),
    rewrite: claim("supported", "ast-grep", compilerFingerprint),
    schemaVersion: INTELLIGENCE_SCHEMA_VERSION,
    structuralRead: claim("supported", "custom", compilerFingerprint),
    structuredParser: { mode: "none" },
    symbolExtraction: claim("supported", "custom", compilerFingerprint),
  });
}

const templateLimitations: Record<string, string> = {
  astro:
    "Extracts frontmatter and script elements; template expressions require framework binding",
  blade:
    "Extracts PHP blocks and echo expressions as JavaScript-like syntax; PHP-only constructs can be partial",
  ejs: "Extracts EJS code blocks; generated template control flow is not reconstructed",
  razor:
    "Reports C# blocks and expressions for later C# adapter handling without extracting JavaScript facts",
  svelte:
    "Extracts script elements; template directives and reactive labels require Svelte binding",
  vue: "Extracts script elements; template directives and macro semantics require Vue binding",
};

function templateCapability(
  languageId: WebLanguageId,
  extensions: string[],
): LanguageCapability {
  const limitation =
    templateLimitations[languageId] ?? "Template semantics are partial";
  const razor = languageId === "razor";
  return LanguageCapabilitySchema.parse({
    callResolution: unsupported(
      "Embedded call targets require framework-aware host binding",
    ),
    embeddedLanguageIds: razor ? [] : ["javascript", "typescript"],
    embeddedLanguages: razor
      ? unsupported("Razor C# regions require the C# language adapter")
      : claim("partial", "custom", templateFingerprint, [limitation]),
    exportResolution: unsupported(
      "Embedded exports are extracted but not resolved across template modules",
    ),
    extensions,
    importResolution: unsupported(
      "Embedded imports are extracted but not resolved across template modules",
    ),
    inheritanceResolution: unsupported(
      "Embedded heritage is extracted but not resolved across template modules",
    ),
    languageId,
    match: unsupported(
      "Host-template structural matching requires a native grammar",
    ),
    parse: claim("partial", "custom", templateFingerprint, [limitation]),
    rewrite: unsupported("Template rewrites require a native host grammar"),
    schemaVersion: INTELLIGENCE_SCHEMA_VERSION,
    structuralRead: claim("partial", "custom", templateFingerprint, [
      limitation,
    ]),
    structuredParser: { mode: "none" },
    symbolExtraction: razor
      ? unsupported("Razor symbols require the C# language adapter")
      : claim("partial", "custom", templateFingerprint, [limitation]),
  });
}

function compilerAdapter(
  languageId: WebLanguageId,
  extensions: string[],
): WebLanguageAdapter {
  return {
    analyze: (request) =>
      request.compilerProgram
        ? analyzeTypeScriptProject({
            ...request,
            program: request.compilerProgram,
          })
        : analyzeCompilerLanguage(request),
    capability: compilerCapability(languageId, extensions),
    extensions,
    languageId,
  };
}

function templateAdapter(
  languageId: WebLanguageId,
  extensions: string[],
): WebLanguageAdapter {
  return {
    analyze: analyzeTemplate,
    capability: templateCapability(languageId, extensions),
    extensions,
    languageId,
  };
}

export const webLanguageAdapters = [
  compilerAdapter("javascript", [".js", ".mjs", ".cjs"]),
  compilerAdapter("typescript", [".ts", ".mts", ".cts"]),
  compilerAdapter("jsx", [".jsx"]),
  compilerAdapter("tsx", [".tsx"]),
  templateAdapter("vue", [".vue"]),
  templateAdapter("svelte", [".svelte"]),
  templateAdapter("astro", [".astro"]),
  templateAdapter("ejs", [".ejs"]),
  templateAdapter("blade", [".blade.php"]),
  templateAdapter("razor", [".cshtml", ".razor"]),
] as const satisfies readonly WebLanguageAdapter[];

export const webLanguageGroupManifest: WebLanguageGroupManifest = {
  adapters: webLanguageAdapters,
  groupId: "web",
  implementationFingerprint: sha256(
    JSON.stringify(
      webLanguageAdapters.map((adapter) => [
        adapter.languageId,
        adapter.extensions,
        adapter.capability,
      ]),
    ),
  ),
  schemaVersion: INTELLIGENCE_SCHEMA_VERSION,
};

export function webLanguageAdapter(
  languageId: WebLanguageId,
): WebLanguageAdapter {
  const adapter = webLanguageAdapters.find(
    (candidate) => candidate.languageId === languageId,
  );
  if (!adapter) throw new TypeError(`Unsupported web language: ${languageId}`);
  return adapter;
}
