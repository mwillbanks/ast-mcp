import { expect, spyOn, test } from "bun:test";

import { createLanguageLoader } from "../../../../src/intelligence/languages/shared/language-loader.ts";

test("the native-only experiment guard rejects before starting WASM", async () => {
  const envKey = "AST_MCP_EXPERIMENT_NATIVE_ONLY";
  const previous = process.env[envKey];
  const warnings: string[] = [];
  const stderr = spyOn(process.stderr, "write").mockImplementation(
    (message) => {
      warnings.push(String(message));
      return true;
    },
  );
  let initialized = 0;
  let loaded = 0;
  const load = createLanguageLoader(
    async () => {
      initialized += 1;
    },
    async (id) => {
      loaded += 1;
      return id;
    },
  );
  try {
    process.env[envKey] = "1";
    await expect(load("typescript")).rejects.toThrow(
      "WASM parser activation is disabled",
    );
    expect(warnings).toEqual([
      "WASM parser activation is disabled in native-only experiments\n",
    ]);
    expect({ initialized, loaded }).toEqual({ initialized: 0, loaded: 0 });

    delete process.env[envKey];
    expect(await load("typescript")).toBe("typescript");
    expect({ initialized, loaded }).toEqual({ initialized: 1, loaded: 1 });
  } finally {
    if (previous === undefined) delete process.env[envKey];
    else process.env[envKey] = previous;
    stderr.mockRestore();
  }
});

test("shares concurrent initialization and retries a failed grammar load", async () => {
  let initializeAttempts = 0;
  let loadAttempts = 0;
  const load = createLanguageLoader(
    async () => {
      initializeAttempts += 1;
      if (initializeAttempts === 1) throw new Error("initialize failed");
    },
    async (id) => {
      loadAttempts += 1;
      if (loadAttempts === 1) throw new Error("grammar failed");
      return id;
    },
  );
  const failures = await Promise.allSettled([load("zig"), load("zig")]);
  for (const failure of failures) {
    expect(failure).toMatchObject({
      status: "rejected",
      reason: { message: "initialize failed" },
    });
  }
  expect({ initializeAttempts, loadAttempts }).toEqual({
    initializeAttempts: 1,
    loadAttempts: 0,
  });

  await expect(load("zig")).rejects.toThrow("grammar failed");
  expect(await Promise.all([load("zig"), load("zig")])).toEqual(["zig", "zig"]);
  expect({ initializeAttempts, loadAttempts }).toEqual({
    initializeAttempts: 2,
    loadAttempts: 2,
  });
});
