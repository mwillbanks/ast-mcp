import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const resolveProvider = createRequire(import.meta.url);
const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const grammarDigests = new Map<string, string>();
// Bun.build injects provider metadata so extracted bundles need only copied assets.
declare const AST_MCP_WASM_PROVIDER_VERSIONS: Readonly<Record<string, string>>;
const packageVersions = new Map<string, string>(
  typeof AST_MCP_WASM_PROVIDER_VERSIONS === "undefined"
    ? []
    : Object.entries(AST_MCP_WASM_PROVIDER_VERSIONS),
);
export function wasmProviderVersions(): Record<string, string> {
  return Object.fromEntries(
    ["tree-sitter-wasm", "tree-sitter-systemverilog", "web-tree-sitter"].map(
      (name) => [name, packageVersion(name)],
    ),
  );
}
let parserDigest: string | undefined;
const hash = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

export const wasmGrammarAssets = [
  "bash",
  "c",
  "c_sharp",
  "commonlisp",
  "cpp",
  "dart",
  "elixir",
  "go",
  "groovy",
  "java",
  "julia",
  "kotlin",
  "lua",
  "objc",
  "ocaml",
  "php",
  "powershell",
  "python",
  "r",
  "ruby",
  "rust",
  "scala",
  "swift",
  "systemverilog",
  "zig",
] as const;
let providerDigest: string | undefined;
export function wasmProviderFingerprint(): string {
  return (providerDigest ??= hash(
    JSON.stringify([
      wasmParserFingerprint(),
      ...wasmGrammarAssets.map(wasmGrammarFingerprint),
    ]),
  ));
}

function packageRoot(name: string): string {
  return dirname(
    resolveProvider.resolve(
      name === "tree-sitter-systemverilog" ? `${name}/package.json` : name,
    ),
  );
}

function packageVersion(name: string): string {
  const cached = packageVersions.get(name);
  if (cached) return cached;
  const manifest: unknown = JSON.parse(
    readFileSync(join(packageRoot(name), "package.json"), "utf8"),
  );
  if (
    !manifest ||
    typeof manifest !== "object" ||
    !("version" in manifest) ||
    typeof manifest.version !== "string"
  ) {
    throw new Error(`Missing parser provider version: ${name}`);
  }
  packageVersions.set(name, manifest.version);
  return manifest.version;
}

function grammarId(identity: string): string {
  const id = identity.split(":", 1)[0]!;
  if (id === "verilog") return "systemverilog";
  if (id === "csharp") return "c_sharp";
  if (id === "apex") return "java";
  if (id === "luau") return "lua";
  return id;
}

export function resolveWasmGrammarAsset(identity: string): string {
  const grammar = grammarId(identity);
  const relative = join("out", grammar, `tree-sitter-${grammar}.wasm`);
  const bundled = [
    join(moduleDirectory, relative),
    join(moduleDirectory, "workers", relative),
  ].find(existsSync);
  if (bundled) return bundled;
  const provider =
    grammar === "systemverilog"
      ? "tree-sitter-systemverilog"
      : "tree-sitter-wasm";
  return grammar === "systemverilog"
    ? join(packageRoot(provider), "tree-sitter-systemverilog.wasm")
    : join(packageRoot(provider), relative);
}

export function wasmGrammarFingerprint(identity: string): string {
  const cached = grammarDigests.get(identity);
  if (cached) return cached;
  const digest = identity.startsWith("structured:")
    ? hash(JSON.stringify([identity]))
    : (() => {
        const provider =
          grammarId(identity) === "systemverilog"
            ? "tree-sitter-systemverilog"
            : "tree-sitter-wasm";
        return hash(
          JSON.stringify([
            provider,
            packageVersion(provider),
            identity,
            hash(readFileSync(resolveWasmGrammarAsset(identity))),
          ]),
        );
      })();
  grammarDigests.set(identity, digest);
  return digest;
}

export function wasmExtractorFingerprint(identity: string): string {
  return hash(
    JSON.stringify([wasmGrammarFingerprint(identity), "coordinates-v2"]),
  );
}

export function wasmParserFingerprint(): string {
  if (!parserDigest) {
    const bundled = join(moduleDirectory, "web-tree-sitter.wasm");
    const workerBundled = join(
      moduleDirectory,
      "workers",
      "web-tree-sitter.wasm",
    );
    const asset = existsSync(bundled)
      ? bundled
      : existsSync(workerBundled)
        ? workerBundled
        : resolveProvider.resolve("web-tree-sitter/web-tree-sitter.wasm");
    parserDigest = hash(
      JSON.stringify([
        "web-tree-sitter",
        packageVersion("web-tree-sitter"),
        hash(readFileSync(asset)),
      ]),
    );
  }
  return parserDigest;
}
