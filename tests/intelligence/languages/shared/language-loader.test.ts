import { expect, test } from "bun:test";

import { createLanguageLoader } from "../../../../src/intelligence/languages/shared/language-loader.ts";

test("shares initialization and same-language loads across concurrent requests", async () => {
  let initializes = 0;
  let loads = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const load = createLanguageLoader(
    async () => {
      initializes++;
      await gate;
    },
    async (id) => {
      loads++;
      return { id };
    },
  );
  const one = load("typescript");
  const two = load("typescript");
  const other = load("javascript");
  release();
  const values = await Promise.all([one, two, other]);
  expect(values[0]).toBe(values[1]);
  expect(values[2]).toEqual({ id: "javascript" });
  expect(initializes).toBe(1);
  expect(loads).toBe(2);
  expect(await load("typescript")).toBe(values[0]!);
  expect(loads).toBe(2);
});

test("retries failed initialization and grammar loads without poisoning the cache", async () => {
  let initializes = 0;
  let loads = 0;
  const load = createLanguageLoader(
    async () => {
      if (++initializes === 1) throw new Error("initialization unavailable");
    },
    async (id) => {
      if (++loads === 1) throw new Error("grammar unavailable");
      return id;
    },
  );
  const initial = await Promise.allSettled([
    load("typescript"),
    load("typescript"),
  ]);
  expect(initial.every((value) => value.status === "rejected")).toBe(true);
  await expect(load("typescript")).rejects.toThrow("grammar unavailable");
  expect(await load("typescript")).toBe("typescript");
  expect(initializes).toBe(2);
  expect(loads).toBe(2);
});
