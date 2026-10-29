import { expect, test } from "bun:test";
import path from "node:path";

import {
  createReferenceTargetIndex,
  referencedTargets,
} from "../../src/runtime/reference-target-index.ts";

function original(targets: string[], bases: string[]): string[] {
  return targets
    .filter((target) =>
      bases.some(
        (base) =>
          base === target ||
          `${base}${path.extname(target)}` === target ||
          path.join(base, `index${path.extname(target)}`) === target,
      ),
    )
    .sort();
}

test("reference aliases preserve collisions, index files, extensionless files, and duplicate imports", () => {
  const targets = [
    "/app/file.ts",
    "/app/file.js",
    "/app/folder/index.ts",
    "/app/folder/index",
    "/app/.hidden",
    "/app/plain",
  ];
  const index = createReferenceTargetIndex(targets);
  for (const bases of [
    ["/app/file", "/app/file", "/app/file.ts"],
    ["/app/folder"],
    ["/app/folder/index"],
    ["/app/.hidden", "/app/plain"],
    ["/app/unrelated", "/app/file.tsx"],
  ])
    expect([...referencedTargets(index, bases)].sort()).toEqual(
      original(targets, bases),
    );
});

test("reference alias index matches the original predicate across generated path combinations", () => {
  const names = ["file", "index", "other.index", ".hidden", "multi.part"];
  const extensions = ["", ".ts", ".tsx", ".js", ".json"];
  const targets = ["/app", "/app/nested", "/other"].flatMap((root) =>
    names.flatMap((name) =>
      extensions.map((ext) => path.join(root, name + ext)),
    ),
  );
  const index = createReferenceTargetIndex(targets);
  const candidates = [
    ...targets,
    ...targets.map((target) =>
      target.slice(0, target.length - path.extname(target).length),
    ),
    "/app/nested",
    "/app",
    "/missing",
  ];
  for (let seed = 0; seed < candidates.length; seed++) {
    const bases = [
      candidates[seed]!,
      candidates[(seed * 17 + 3) % candidates.length]!,
      candidates[seed]!,
    ];
    expect([...referencedTargets(index, bases)].sort()).toEqual(
      original(targets, bases),
    );
  }
});
