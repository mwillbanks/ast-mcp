import path from "node:path";

import { z } from "zod";

import { packVersions, type PackVersions } from "../language-packs/catalog.ts";

export interface LanguagePackHostPolicy {
  allowDownload?: boolean;
  allowProject?: boolean;
}

let startupPolicy: Readonly<LanguagePackHostPolicy> = {};

export function languagePackHostPolicy(): Readonly<LanguagePackHostPolicy> {
  return startupPolicy;
}

/** Accept only host startup arguments before accepting MCP requests. */
export function configureLanguagePackHost(args: string[]): string[] {
  startupPolicy = Object.freeze({
    allowDownload: args.includes("--allow-language-pack-downloads"),
    allowProject: args.includes("--allow-project-language-packs"),
  });
  return args.filter(
    (arg) =>
      arg !== "--allow-language-pack-downloads" &&
      arg !== "--allow-project-language-packs",
  );
}

export const languagePacksSchema = z.strictObject({
  scope: z.enum(["user", "project"]).optional(),
  versions: z
    .strictObject({
      python: z.literal(packVersions.python).optional(),
      go: z.literal(packVersions.go).optional(),
      sql: z.literal(packVersions.sql).optional(),
    })
    .optional(),
});

export type LanguagePackConfig = z.infer<typeof languagePacksSchema>;

export interface ResolvedLanguagePacks {
  allowFirstUse: boolean;
  directory: string;
  projectStorageDenied: boolean;
  scope: "user" | "project";
  userDirectory: string;
  versions: PackVersions;
}

export function resolveLanguagePacks(
  global: LanguagePackConfig | undefined,
  project: LanguagePackConfig | undefined,
  globalPath: string,
  projectRoot: string,
  host: Readonly<LanguagePackHostPolicy> | undefined,
): ResolvedLanguagePacks {
  const requested = project?.scope ?? global?.scope ?? "user";
  const scope =
    requested === "project" && host?.allowProject ? "project" : "user";
  const userDirectory = path.join(path.dirname(globalPath), "language-packs");
  return {
    allowFirstUse: host?.allowDownload === true,
    directory:
      scope === "project"
        ? projectLanguagePackDirectory(projectRoot)
        : userDirectory,
    projectStorageDenied: requested === "project" && scope !== "project",
    scope,
    userDirectory,
    versions: { ...packVersions, ...global?.versions, ...project?.versions },
  };
}

export function projectLanguagePackDirectory(checkoutRoot: string) {
  return path.join(checkoutRoot, ".ast-mcp", "language-packs");
}
