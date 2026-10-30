import { describe, expect, test } from "bun:test";

import * as runtimeRelease from "../../src/runtime/release";

const exportedReleasePath = "../../templates/skills/ast-mcp/scripts/release.ts";
const exportedRelease = (await import(
  exportedReleasePath
)) as typeof runtimeRelease;

function registry(
  version: unknown,
  observe?: (url: unknown, init: unknown) => void,
) {
  return (async (url: unknown, init: unknown) => {
    observe?.(url, init);
    return Response.json({ version });
  }) as unknown as typeof fetch;
}

for (const [name, implementation] of [
  ["runtime", runtimeRelease],
  ["exported skill", exportedRelease],
] as const) {
  describe(name, () => {
    const { checkLatestVersion, compareVersions } = implementation;
    test("release checks compare semantic versions and always fetch fresh public metadata", async () => {
      let calls = 0;
      const fetch = registry("0.6.6", (url, init) => {
        calls++;
        expect(url).toBe(
          "https://registry.npmjs.org/@mwillbanks%2Fast-mcp/latest",
        );
        expect(init).toMatchObject({
          credentials: "omit",
          redirect: "error",
          headers: { accept: "application/json" },
        });
        expect(JSON.stringify(init)).not.toContain("authorization");
      });
      for (const [running, status, comparison] of [
        ["0.6.5", "outdated", "older"],
        ["0.6.6", "current", "equal"],
        ["0.7.0", "newer", "newer"],
        ["0.7.0-dev.1", "prerelease", "newer"],
        ["0.6.6-rc.1", "prerelease", "older"],
        ["0.6.6+local", "current", "equal"],
      ]) {
        expect(await checkLatestVersion(running!, { fetch })).toMatchObject({
          runningVersion: running,
          latestVersion: "0.6.6",
          status,
          comparison,
        });
      }
      expect(calls).toBe(6);
      expect(compareVersions("1.0.0-rc.2", "1.0.0-rc.10")).toBe(-1);
      expect(compareVersions("1.0.0-1", "1.0.0-alpha")).toBe(-1);
      expect(compareVersions("1.0.0-alpha", "1.0.0-alpha.1")).toBe(-1);
      expect(compareVersions("01.0.0", "1.0.0")).toBeUndefined();
      expect(compareVersions("1.0.0-01", "1.0.0")).toBeUndefined();
    });

    test("release checks bound network stalls and redact errors", async () => {
      const start = performance.now();
      const result = await checkLatestVersion("0.6.6", {
        timeoutMs: 10,
        fetch: (() => new Promise(() => {})) as unknown as typeof fetch,
      });
      expect(performance.now() - start).toBeLessThan(1000);
      expect(result).toMatchObject({
        status: "unavailable",
        reason: "timeout",
      });
      const failed = await checkLatestVersion("0.6.6", {
        fetch: (async () => {
          throw new Error("/private/repository token=secret");
        }) as unknown as typeof fetch,
      });
      expect(failed.reason).toBe("registry_unavailable");
      expect(JSON.stringify(failed)).not.toContain("secret");
    });

    test("release checks bound bodies and reject malformed versions without claiming currency", async () => {
      for (const response of [
        new Response("not json"),
        Response.json({ version: "1.0" }),
        Response.json({ version: "1.0.0-rc.1" }),
        Response.json({ version: "1.0.0-01" }),
        new Response("x".repeat(16_385)),
        new Response("{}", { status: 503 }),
        new Response("{}", { headers: { "content-length": "999999999" } }),
      ]) {
        expect(
          await checkLatestVersion("0.6.6", {
            fetch: (async () => response) as unknown as typeof fetch,
          }),
        ).toMatchObject({ status: "unavailable", latestVersion: null });
      }
      expect(
        await checkLatestVersion("unknown", {
          fetch: registry("0.6.6"),
        }),
      ).toMatchObject({
        status: "unavailable",
        latestVersion: "0.6.6",
        reason: "invalid_running_version",
      });
    });

    test("release body streaming shares the same deadline", async () => {
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"version":'));
        },
        cancel() {
          cancelled = true;
        },
      });
      const result = await checkLatestVersion("0.6.6", {
        timeoutMs: 10,
        fetch: (async () => new Response(body)) as unknown as typeof fetch,
      });
      expect(result.reason).toBe("timeout");
      await Promise.resolve();
      expect(cancelled).toBeTrue();
      expect(body.locked).toBeFalse();
    });

    test("semantic prerelease ordering handles equal identifiers and both comparison directions", () => {
      for (const [first, second, expected] of [
        ["1.0.0-alpha", "1.0.0-beta", -1],
        ["1.0.0-beta", "1.0.0-alpha", 1],
        ["1.0.0-rc.10", "1.0.0-rc.2", 1],
        ["1.0.0-alpha.1", "1.0.0-alpha", 1],
        ["1.0.0-alpha", "1.0.0-1", 1],
        ["1.0.0-alpha.1", "1.0.0-alpha.1", 0],
        ["1.0.0", "1.0.0-rc.1", 1],
      ] as const)
        expect(compareVersions(first, second)).toBe(expected);
      expect(
        compareVersions("1.0.0-" + "a".repeat(129), "1.0.0"),
      ).toBeUndefined();
    });

    test("stream cancellation failures preserve timeout and invalid-body outcomes", async () => {
      for (const oversized of [false, true]) {
        let cancelled = 0;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(oversized ? 16_385 : 1));
          },
          cancel() {
            cancelled++;
            return Promise.reject(new Error("private cancellation detail"));
          },
        });
        const result = await checkLatestVersion("0.6.6", {
          timeoutMs: 10,
          fetch: (async () => new Response(body)) as unknown as typeof fetch,
        });
        expect(result.reason).toBe(
          oversized ? "invalid_registry_response" : "timeout",
        );
        await Promise.resolve();
        expect(cancelled).toBe(1);
        expect(body.locked).toBeFalse();
        expect(JSON.stringify(result)).not.toContain("private cancellation");
      }
    });

    test("late registry responses are cancelled after the public deadline", async () => {
      let resolveResponse!: (response: Response) => void;
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true;
        },
      });
      const result = await checkLatestVersion("0.6.6", {
        timeoutMs: 10,
        fetch: (() =>
          new Promise<Response>((resolve) => {
            resolveResponse = resolve;
          })) as unknown as typeof fetch,
      });
      expect(result.reason).toBe("timeout");
      resolveResponse(new Response(body));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(cancelled).toBeTrue();
      expect(body.locked).toBeFalse();
    });

    test("missing registry bodies and non-string version fields never verify currency", async () => {
      for (const response of [
        new Response(null),
        Response.json({ version: null }),
        Response.json({ version: 10606 }),
      ]) {
        const result = await checkLatestVersion("0.6.6", {
          fetch: (async () => response) as unknown as typeof fetch,
        });
        expect(result).toMatchObject({
          status: "unavailable",
          latestVersion: null,
          reason: "invalid_registry_response",
        });
      }
    });
  });
}
