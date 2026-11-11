import {
  renderReleaseNotes,
  validateReleaseVersion,
} from "./render-release-notes.ts";

export const releaseManifest = ".release-please-manifest.json";
export const releaseChangelog = "CHANGELOG.md";
export const releaseDraft = "website/content/release-drafts/NEXT_RELEASE.mdx";
const releasePages = "website/content/docs/releases/";
const nextRelease = "NEXT_RELEASE";
const releaseToken = /\bNEXT_RELEASE\b/g;

export type ReleaseFileChanges = {
  additions: ReadonlyMap<string, string>;
  deletions: readonly string[];
};

export function releasePage(version: string): string {
  return releasePages + validateReleaseVersion(version) + ".mdx";
}

export function isReleaseInput(path: string): boolean {
  return (
    path === releaseManifest ||
    path === releaseChangelog ||
    path === releaseDraft ||
    (/^(?:docs\/|website\/content\/docs\/)/.test(path) &&
      /\.(?:mdx?|json|ya?ml|toml)$/i.test(path))
  );
}

function required(files: ReadonlyMap<string, string>, path: string): string {
  const content = files.get(path);
  if (!content) throw new Error("Missing release input: " + path);
  return content;
}

function firstChangelogVersion(content: string): string | undefined {
  const heading = /^## (.+)$/m.exec(content)?.[1];
  return heading === undefined
    ? undefined
    : /^(?:\[)?([A-Za-z0-9_.]+)(?=[\]\s]|$)/.exec(heading)?.[1];
}

function stamp(content: string, version: string, path: string): string {
  const stamped = content.replaceAll(releaseToken, version);
  if (stamped.includes(nextRelease))
    throw new Error("Unresolved release placeholder in " + path);
  return stamped;
}

export async function prepareReleaseContent(
  files: ReadonlyMap<string, string>,
  formatChangelog: (content: string) => Promise<string>,
): Promise<ReleaseFileChanges> {
  const manifest: unknown = JSON.parse(required(files, releaseManifest));
  if (!manifest || typeof manifest !== "object" || !("." in manifest))
    throw new Error("Invalid release manifest");
  const version = validateReleaseVersion(manifest["."]);
  const page = releasePage(version);
  const changelog = required(files, releaseChangelog);
  const currentHeading = changelog.indexOf("\n## ");
  const historicalStart = changelog.indexOf("\n## ", currentHeading + 1);
  const history =
    historicalStart === -1 ? "" : changelog.slice(historicalStart);
  const draft = files.get(releaseDraft);
  const existing = files.get(page);
  if (draft !== undefined && existing !== undefined)
    throw new Error("Release page already exists: " + page);

  const additions = new Map<string, string>();
  if (draft === undefined) {
    if (!existing || firstChangelogVersion(changelog) !== version)
      throw new Error(
        "Missing authored release draft or changelog for " + version,
      );
    renderReleaseNotes(existing, version);
  } else {
    if (firstChangelogVersion(changelog) !== nextRelease)
      throw new Error("The first changelog section must be NEXT_RELEASE");
    if (history.includes(nextRelease))
      throw new Error("Release placeholder in historical changelog section");
    const notes = stamp(draft, version, releaseDraft);
    renderReleaseNotes(notes, version);
    additions.set(page, notes);
  }

  for (const [path, content] of files) {
    if (
      path === releaseChangelog ||
      path === releaseDraft ||
      !content.includes(nextRelease)
    )
      continue;
    if (
      draft === undefined ||
      path.startsWith(releasePages) ||
      path === releaseManifest
    )
      throw new Error("Unresolved release placeholder in " + path);
    additions.set(path, stamp(content, version, path));
  }

  const stamped = stamp(changelog, version, releaseChangelog);
  const formatted = await formatChangelog(stamped);
  if (
    !formatted ||
    formatted.includes(nextRelease) ||
    (await formatChangelog(formatted)) !== formatted
  )
    throw new Error("Formatted release changelog failed its formatting check");
  if (
    !formatted.endsWith(history) ||
    firstChangelogVersion(formatted) !== version
  )
    throw new Error(
      "Release formatting would change historical changelog entries",
    );
  if (formatted !== changelog) additions.set(releaseChangelog, formatted);
  return { additions, deletions: draft === undefined ? [] : [releaseDraft] };
}
