import { astCapable } from "./capability";

export async function astRewritable(
  filePath: string,
  language?: string,
): Promise<boolean> {
  if (language === "markdown") return false;
  return astCapable(filePath, language);
}
