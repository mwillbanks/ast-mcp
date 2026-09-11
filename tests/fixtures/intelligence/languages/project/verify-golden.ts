import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { analyzeProjectFormat } from "../../../../../src/intelligence/languages/project/index.ts";

const root = import.meta.dir;
const casesMap = {
  "delphi-form": "demo.dfm",
  "dotnet-build": "build.props",
  "dotnet-project": "app.csproj",
  "dotnet-resource": "strings.resx",
  "dotnet-solution": "demo.sln",
  "dotnet-solution-xml": "demo.slnx",
  "lazarus-form": "demo.lfm",
  "lazarus-package": "demo.lpk",
  "lazarus-project": "demo.lpi",
  "nuget-manifest": "package.nuspec",
  "nuget-packages": "packages.config",
  xaml: "main.xaml",
} as const;
const golden = JSON.parse(
  await readFile(`${root}/graphify-golden.json`, "utf8"),
);
const provenance = golden.provenance as {
  fixtures: Record<string, string>;
  source: {
    inventoryPath: string;
    inventorySha256: string;
    repository: string;
    revision: string;
  };
};
assert.equal(
  provenance.source.repository,
  "https://github.com/Graphify-Labs/graphify",
);
assert.equal(provenance.source.inventoryPath, "graphify/detect.py");
const upstreamUrl = `https://raw.githubusercontent.com/Graphify-Labs/graphify/${provenance.source.revision}/${provenance.source.inventoryPath}`;
const upstream = await fetch(upstreamUrl);
assert.equal(
  upstream.ok,
  true,
  `Unable to read pinned Graphify source: ${upstream.status}`,
);
assert.equal(
  new Bun.CryptoHasher("sha256")
    .update(new Uint8Array(await upstream.arrayBuffer()))
    .digest("hex"),
  provenance.source.inventorySha256,
);
assert.equal(Object.keys(provenance.fixtures).length, 15);
for (const [file, expected] of Object.entries(provenance.fixtures))
  assert.equal(
    new Bun.CryptoHasher("sha256")
      .update(await readFile(`${root}/${file}`))
      .digest("hex"),
    expected,
    `Fixture checksum mismatch: ${file}`,
  );

const cases: Record<string, unknown> = {};
for (const [format, file] of Object.entries(casesMap))
  cases[format] = analyzeProjectFormat({
    format: format as keyof typeof casesMap,
    source: await readFile(`${root}/${file}`, "utf8"),
    sourcePath: file,
  });
const variants: Record<string, unknown> = {};
for (const [file, format] of Object.entries({
  "app.fsproj": "dotnet-project",
  "app.vbproj": "dotnet-project",
  "build.targets": "dotnet-build",
} as const))
  variants[file] = analyzeProjectFormat({
    format,
    source: await readFile(`${root}/${file}`, "utf8"),
    sourcePath: file,
  });
assert.deepEqual(
  { cases, variants },
  { cases: golden.cases, variants: golden.variants },
);
