import assert from "node:assert/strict";
import {
  analyzeLegacyLanguage,
  closeLegacyLanguageWorker,
  type LegacyLanguageId,
} from "../../../../../src/intelligence/languages/legacy/index.ts";

const directory = new URL(".", import.meta.url);
const goldenUrl = new URL("graphify-golden.json", directory);
const golden = await Bun.file(goldenUrl).json();
const fixtures: Record<LegacyLanguageId, string> = {
  "common-lisp": "common-lisp.lisp",
  dreammaker: "dreammaker.dm",
  ocaml: "ocaml.ml",
  pascal: "pascal.pas",
  "robot-framework": "robot.robot",
};
const upstreamUrl = `${golden.provenance.repository}/raw/${golden.provenance.revision}/${golden.provenance.source.path}`;

try {
  const upstreamResponse = await fetch(upstreamUrl);
  assert.equal(upstreamResponse.ok, true, `Unable to fetch ${upstreamUrl}`);
  const upstream = await upstreamResponse.arrayBuffer();
  const upstreamChecksum = new Bun.CryptoHasher("sha256")
    .update(upstream)
    .digest("hex");
  assert.equal(upstreamChecksum, golden.provenance.source.sha256);

  const languages: Record<string, unknown> = {};
  for (const id of Object.keys(fixtures) as LegacyLanguageId[]) {
    const source = await Bun.file(new URL(fixtures[id], directory)).text();
    const checksum = new Bun.CryptoHasher("sha256")
      .update(source)
      .digest("hex");
    assert.equal(checksum, golden.provenance.fixtureChecksums[id]);
    languages[id] = await analyzeLegacyLanguage({ languageId: id, source });
  }

  const reproduced = {
    languages,
    provenance: golden.provenance,
    schemaVersion: golden.schemaVersion,
    unsupported: golden.unsupported,
  };
  if (process.argv.includes("--write")) {
    await Bun.write(goldenUrl, `${JSON.stringify(reproduced, null, 2)}\n`);
  } else {
    assert.deepEqual(reproduced, golden);
  }
} finally {
  await closeLegacyLanguageWorker();
}
