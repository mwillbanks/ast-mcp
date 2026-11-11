import { expect, mock, test } from "bun:test";
import path from "node:path";

import { pinnedGrammarRegistration } from "../../../src/intelligence/parser/language-catalog.ts";
import {
  initializeNativePackRegistry,
  LanguageRegistry,
} from "../../../src/intelligence/parser/registry.ts";
import { nativePackDescriptor } from "../../../src/language-packs/catalog.ts";

test("registers the configured native pack exactly once and versions its syntax facts", () => {
  const registrar = mock(() => {});
  const descriptor = nativePackDescriptor("go", "linux", "x64")!;
  const libraryPath = path.resolve("managed-packs", descriptor.filename);
  const pack = { ...descriptor, libraryPath };
  const bundled = new LanguageRegistry(registrar, ["go"]);
  const managed = new LanguageRegistry(registrar, ["go"], {
    assets: { go: pack },
    identity: "managed-go",
  });

  expect(managed.get("go").grammarVersion).toBe(
    "@ast-grep/lang-go@" + pack.version,
  );
  expect(managed.get("go").grammarFingerprint).not.toBe(
    bundled.get("go").grammarFingerprint,
  );
  expect(managed.get("python")).toEqual(bundled.get("python"));
  managed.registerDynamicGrammars();
  managed.registerDynamicGrammars();
  expect(registrar).toHaveBeenCalledTimes(1);
  expect(registrar).toHaveBeenCalledWith({
    go: {
      libraryPath,
      languageSymbol: descriptor.languageSymbol,
      expandoChar: descriptor.expandoChar,
      extensions: ["go"],
    },
  });
  expect(() => bundled.registerDynamicGrammars()).toThrow(
    "different grammar set is already registered",
  );
  expect(pinnedGrammarRegistration("go").libraryPath).not.toBe(libraryPath);
});

test("rejects registry replacement outside a native child and refuses unverified pack input", async () => {
  const previousSend = Object.getOwnPropertyDescriptor(process, "send");
  const descriptor = nativePackDescriptor("go", "linux", "x64")!;
  const packs = {
    assets: { go: { ...descriptor, libraryPath: "relative/go.so" } },
    identity: "invalid-pack",
  };
  try {
    Object.defineProperty(process, "send", {
      value: undefined,
      configurable: true,
    });
    await expect(initializeNativePackRegistry(packs)).rejects.toThrow(
      "requires an isolated process",
    );
    Object.defineProperty(process, "send", {
      value: () => true,
      configurable: true,
    });
    await expect(initializeNativePackRegistry(packs)).rejects.toThrow(
      "verification failed for go",
    );
  } finally {
    if (previousSend) Object.defineProperty(process, "send", previousSend);
    else Reflect.deleteProperty(process, "send");
  }
});
