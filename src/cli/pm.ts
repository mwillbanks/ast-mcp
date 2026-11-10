import { resolveConfig } from "../config";
import { isPackLanguage } from "../language-packs/catalog.ts";
import {
  installNativeLanguagePack,
  listNativeLanguagePacks,
} from "../language-packs/index.ts";
import {
  parseOutputArguments,
  selectOutputFormat,
  writeCliOutput,
  type CliOutputContext,
} from "./output";

class LanguagePackUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LanguagePackUsageError";
  }
}

export async function runLanguagePackCli(
  args: string[],
  context: CliOutputContext = {},
): Promise<number | undefined> {
  const parsed = parseOutputArguments(args);
  const allowProject = parsed.args.includes("--allow-project-language-packs");
  const offline = parsed.args.includes("--offline");
  const [operation, name, ...extra] = parsed.args.filter(
    (arg) => arg !== "--allow-project-language-packs" && arg !== "--offline",
  );
  if (operation !== "list" && operation !== "install" && operation !== "doctor")
    throw new LanguagePackUsageError("Use ast-mcp pm <list|install|doctor>");
  if (
    operation === "install" &&
    (!name || !isPackLanguage(name) || extra.length)
  )
    throw new LanguagePackUsageError("Use ast-mcp pm install <python|go|sql>");
  if (operation !== "install" && (name || offline))
    throw new LanguagePackUsageError(`Unexpected argument for pm ${operation}`);
  const config = await resolveConfig({ languagePackHost: { allowProject } });
  const settings = config.languagePacks!;
  const output = {
    scope: settings.scope,
    directory: settings.directory,
    ...(settings.projectStorageDenied && { projectStorageDenied: true }),
  };
  const format = selectOutputFormat(config, parsed.output, context.isTTY);
  if (operation === "install" && name && isPackLanguage(name)) {
    const asset = await installNativeLanguagePack(config, name, { offline });
    writeCliOutput(
      { ...output, pack: { language: name, status: "installed", ...asset } },
      format,
      "Language pack installed",
      context.write,
    );
    return;
  }
  const packs = listNativeLanguagePacks(config);
  writeCliOutput(
    { ...output, packs },
    format,
    operation === "doctor" ? "Language pack diagnostics" : "Language packs",
    context.write,
  );
  if (
    operation === "doctor" &&
    (settings.projectStorageDenied ||
      packs.some((pack) => pack.status === "corrupt"))
  )
    return 1;
}
