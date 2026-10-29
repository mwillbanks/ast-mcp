import { expect, spyOn, test } from "bun:test";
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

const pathImplementations = [
  ["posix", { extname: path.posix.extname, join: path.posix.join }],
  ["win32", { extname: path.win32.extname, join: path.win32.join }],
] as const;

for (const [name, implementation] of pathImplementations)
  test(`reference aliases preserve literal and normalized path behavior on ${name}`, () => {
    const join = spyOn(path, "join").mockImplementation(implementation.join);
    const extname = spyOn(path, "extname").mockImplementation(
      implementation.extname,
    );
    try {
      const roots = [
        "",
        ".",
        "..",
        "/",
        "/app/",
        "/app//",
        "/app/./",
        "/app/nested/../",
        "C:",
        "C:.",
        "C:/",
        "C:\\",
        "\\\\server\\share\\",
        "//server/share/",
      ];
      const names = ["file", "index", "index.", ".hidden", "multi.part"];
      const targets = [
        ...new Set([
          ...roots.flatMap((root) =>
            names.flatMap((file) =>
              ["", ".ts", ".tsx", ".js"].map(
                (extension) => root + file + extension,
              ),
            ),
          ),
          ...roots.flatMap((root) =>
            ["index", "index.ts"].map((file) => path.join(root, file)),
          ),
          "/app/index.ts/",
          "/app//index.ts",
          "/app/./index.ts",
          "C:\\app\\index.ts",
          "C:app\\index.ts",
        ]),
      ];
      const candidates = [
        ...roots,
        ...targets,
        ...targets.map((target) =>
          target.slice(0, target.length - path.extname(target).length),
        ),
        ...targets.map((target) => target + "/"),
      ];
      const index = createReferenceTargetIndex(targets);
      for (const base of candidates)
        expect([...referencedTargets(index, [base, base])].sort()).toEqual(
          original(targets, [base]),
        );
    } finally {
      join.mockRestore();
      extname.mockRestore();
    }
  });

test("reference matching uses bounded lookups without rescanning target extensions", () => {
  const targets = Array.from({ length: 50 }, (_, index) =>
    path.join("/app", String(index), "index.ts"),
  );
  const bases = Array.from({ length: 250 }, (_, index) =>
    path.join("/app", String(index % targets.length)),
  );
  const extname = spyOn(path, "extname");
  const join = spyOn(path, "join");
  try {
    const index = createReferenceTargetIndex(targets);
    const get = spyOn(index, "get");
    try {
      expect([...referencedTargets(index, bases)].sort()).toEqual(
        [...targets].sort(),
      );
      expect(extname).toHaveBeenCalledTimes(targets.length);
      expect(join).toHaveBeenCalledTimes(bases.length);
      expect(get).toHaveBeenCalledTimes(2 * bases.length);
    } finally {
      get.mockRestore();
    }
  } finally {
    extname.mockRestore();
    join.mockRestore();
  }
});

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
