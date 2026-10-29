import path from "node:path";

/** Resolve the same full-path, extensionless, and index aliases as delete preflight. */
export function createReferenceTargetIndex(
  targets: Iterable<string>,
): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const target of targets) {
    const extension = path.extname(target);
    const aliases = new Set([target]);
    if (extension && target.endsWith(extension))
      aliases.add(target.slice(0, -extension.length));
    for (const alias of aliases) {
      const matches = index.get(alias);
      if (matches) matches.push(target);
      else index.set(alias, [target]);
    }
  }
  return index;
}

/** Each importing file counts once per target, including repeated import spellings. */
export function referencedTargets(
  index: ReadonlyMap<string, readonly string[]>,
  bases: Iterable<string>,
): Set<string> {
  const matches = new Set<string>();
  for (const base of bases) {
    for (const target of index.get(base) ?? []) matches.add(target);
    // Joining the query preserves native normalization without normalizing literal aliases.
    for (const target of index.get(path.join(base, "index")) ?? [])
      matches.add(target);
  }
  return matches;
}
