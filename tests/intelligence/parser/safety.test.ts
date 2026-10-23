import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  EmbeddedSourceMap,
  LanguageRegistry,
  SourceCoordinateIndex,
  snapshotDynamicGrammarManifest,
  sha256,
  validateGrammarAsset,
  type DynamicGrammarManifest,
} from "../../../src/intelligence/parser/index.ts";

describe("lossless embedded ranges", () => {
  test("rejects invalid, overlapping, inconsistent, and out-of-bounds segments", () => {
    const segment = {
      embeddedStart: 0,
      embeddedEnd: 2,
      hostStart: 0,
      hostEnd: 2,
    };
    for (const invalid of [
      { ...segment, embeddedStart: -1 },
      { ...segment, hostEnd: 1.5 },
      { ...segment, embeddedEnd: -1 },
      { ...segment, hostEnd: 1 },
    ])
      expect(() => new EmbeddedSourceMap("abcd", "abcd", [invalid])).toThrow();
    expect(
      () => new EmbeddedSourceMap("abcd", "abcd", [segment, segment]),
    ).toThrow("ordered and non-overlapping");
    expect(() => new EmbeddedSourceMap("a", "a", [segment])).toThrow(
      "exceeds source length",
    );
    expect(() => new EmbeddedSourceMap("ab", "cd", [segment])).toThrow(
      "identical text",
    );
  });

  test("maps both directions and rejects ranges crossing an unmapped host gap", () => {
    const host = new SourceCoordinateIndex("ab--cd");
    const embedded = new SourceCoordinateIndex("abcd");
    const mapping = new EmbeddedSourceMap("ab--cd", "abcd", [
      { embeddedStart: 0, embeddedEnd: 2, hostStart: 0, hostEnd: 2 },
      { embeddedStart: 2, embeddedEnd: 4, hostStart: 4, hostEnd: 6 },
    ]);
    expect(mapping.hostToEmbedded(host.range(4, 6))).toEqual(
      embedded.range(2, 4),
    );
    expect(mapping.embeddedToHost(embedded.range(2, 4))).toEqual(
      host.range(4, 6),
    );
    expect(mapping.hostToEmbedded(host.range(1, 5))).toBeNull();
    expect(mapping.embeddedToHost(embedded.range(1, 3))).toBeNull();
  });
});

describe("dynamic grammar trust boundary", () => {
  test("rejects malformed manifests before they reach worker initialization", () => {
    const valid = new LanguageRegistry().dynamicManifest();
    for (const [manifest, message] of [
      [{ ...valid, extra: () => 1 }, "cloneable"],
      [{ ...valid, entries: {} }, "entries must be an array"],
      [{ ...valid, fingerprint: "invalid" }, "fingerprint is invalid"],
      [{ ...valid, schemaVersion: "v0" }, "Unsupported"],
    ] as const) {
      expect(() =>
        snapshotDynamicGrammarManifest(
          manifest as unknown as DynamicGrammarManifest,
        ),
      ).toThrow(message);
    }
    const entries = [{ descriptor: { dynamicAsset: null } }];
    expect(() =>
      snapshotDynamicGrammarManifest({
        entries,
        fingerprint: sha256(JSON.stringify(entries)),
        schemaVersion: "ast-mcp.dynamic-grammars.v1",
      } as unknown as DynamicGrammarManifest),
    ).toThrow("requires an asset");
    const registry = new LanguageRegistry();
    const claim = registry.capabilities("typescript");
    expect(() => registry.assertHonest("missing", claim)).toThrow(
      "Missing language implementation",
    );
    expect(() =>
      registry.assertHonest("typescript", {
        ...claim,
        symbolExtraction: {
          status: "unsupported",
          provider: "none",
          limitations: ["Disabled in fixture"],
          implementationFingerprint: null,
        },
      }),
    ).toThrow("hides a registered implementation");
  });

  test("checks native headers and rejects directory or disguised text assets", async () => {
    const root = await mkdtemp(join(tmpdir(), "ast-grammar-validation-"));
    try {
      await expect(
        validateGrammarAsset({ libraryPath: "relative.node", sha256: "" }),
      ).rejects.toThrow("must be absolute");
      const directory = join(root, "directory.node");
      await mkdir(directory);
      await expect(
        validateGrammarAsset({ libraryPath: directory, sha256: "" }),
      ).rejects.toThrow("not a file");
      const libraryPath = join(root, "fixture.node");
      await writeFile(libraryPath, "plain text");
      await expect(
        validateGrammarAsset({ libraryPath, sha256: "" }),
      ).rejects.toThrow("not a recognized native library");
      for (const header of [
        0x7f454c46, 0x4d5a0000, 0xcafebabe, 0xbebafeca, 0xcffaedfe, 0xcefaedfe,
        0xfeedfacf, 0xfeedface,
      ]) {
        const bytes = Buffer.alloc(4);
        bytes.writeUInt32BE(header);
        await writeFile(libraryPath, bytes);
        await expect(
          validateGrammarAsset({
            libraryPath,
            sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
          }),
        ).resolves.toBeUndefined();
      }
      const bytes = await Bun.file(libraryPath).bytes();
      const asset = {
        libraryPath,
        sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
      };
      const registrar = () => undefined;
      const implementation = {
        parse: true,
        match: true,
        rewrite: true,
        structuralRead: true,
        symbolExtraction: false,
        callResolution: false,
        embeddedLanguages: false,
        exportResolution: false,
        importResolution: false,
        inheritanceResolution: false,
      };
      const descriptor = {
        languageId: "fixture",
        astGrepLanguage: "Fixture",
        dynamicAsset: asset,
        extensions: [".fixture"],
        grammarVersion: "1",
      };
      const first = new LanguageRegistry(registrar);
      await first.addDynamic(descriptor, implementation);
      const identical = new LanguageRegistry(registrar);
      await identical.addDynamic(descriptor, implementation);
      const conflicting = new LanguageRegistry(registrar);
      await conflicting.addDynamic(
        { ...descriptor, dynamicAsset: { ...asset, metaVarChar: "%" } },
        implementation,
      );
      first.registerDynamicGrammars();
      expect(() => identical.registerDynamicGrammars()).not.toThrow();
      expect(() => conflicting.registerDynamicGrammars()).toThrow(
        "different grammar set",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
