import { expect, spyOn, test } from "bun:test";
import { chmod, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { withConfig } from "../../src/config";
import { toolFailure, toolOutputSchema } from "../../src/helpers/mcp-schema";
import { withMutationLifecycle } from "../../src/intelligence/mutation/index";
import * as attributes from "../../src/runtime/attributes";
import { sha256 } from "../../src/runtime/hash";
import registerLifecycleTools from "../../src/tools/lifecycle";
import { hermeticConfig } from "../support/hermetic-config";

test("default abort and numeric codes satisfy the strict public output schema", () => {
  const controller = new AbortController();
  controller.abort();
  const result = toolFailure(controller.signal.reason);
  expect(toolOutputSchema.safeParse(result.structuredContent).success).toBe(
    true,
  );
  expect(toolOutputSchema.parse(result.structuredContent).error).toMatchObject({
    code: "aborted",
  });
  expect(
    toolOutputSchema.parse(
      toolFailure(Object.assign(new Error("ordinary"), { code: 20 }))
        .structuredContent,
    ).error?.code,
  ).toBe("execution_failed");
});

test("aggregate diagnostics expose bounded causes and paths without nested source or secrets", () => {
  const failures = Array.from({ length: 100 }, (_, index) =>
    Object.assign(new Error("SECRET source content"), {
      code: "EACCES",
      path: "/workspace/" + index,
    }),
  );
  const error = new AggregateError(failures, "rollback incomplete");
  failures[0]!.cause = error;
  const result = toolFailure(error);
  expect(toolOutputSchema.safeParse(result.structuredContent).success).toBe(
    true,
  );
  const details = toolOutputSchema.parse(result.structuredContent).error
    ?.details as {
    causes: Array<{ code: string }>;
    affectedPaths: string[];
    truncated: boolean;
  };
  expect(details.causes.length).toBeLessThanOrEqual(16);
  expect(details.affectedPaths.length).toBeLessThanOrEqual(20);
  expect(details.causes[0]!.code).toBe("EACCES");
  expect(details.truncated).toBe(true);
  expect(JSON.stringify(result)).not.toContain("SECRET");
});

test("aggregate machine diagnostics reject source-like and oversized codes", () => {
  for (const code of ["SECRET source content", "SECRET".repeat(10_000)]) {
    const failure = Object.assign(new Error("SECRET nested content"), {
      code,
      name: "SECRET arbitrary error name",
    });
    const result = toolFailure(
      new AggregateError([failure], "rollback incomplete"),
    );
    const details = toolOutputSchema.parse(result.structuredContent).error
      ?.details;
    expect(details).toMatchObject({
      causes: [{ code: "execution_failed", name: "Error" }],
    });
    expect(JSON.stringify(result)).not.toContain("SECRET");
  }
});

test("aggregate path omissions always mark diagnostics truncated", () => {
  for (const paths of [
    ["/" + "long".repeat(1024)],
    [...Array<string>(20).fill("/same-path"), "/omitted-path"],
  ]) {
    const error = Object.assign(new AggregateError([], "rollback incomplete"), {
      details: { affectedPaths: paths },
    });
    const result = toolOutputSchema.parse(toolFailure(error).structuredContent);
    expect(result.error?.details).toMatchObject({ truncated: true });
    expect(JSON.stringify(result)).not.toContain("/omitted-path");
  }
});

test("attribute tool rechecks identity after durable journal callbacks", async () => {
  const root = await mkdtemp(join(tmpdir(), "ast-chattr-journal-"));
  const path = join(root, "source.txt");
  await writeFile(path, "source");
  await chmod(path, 0o644);
  let handler: ((input: never) => Promise<unknown>) | undefined;
  registerLifecycleTools(
    {
      registerTool(
        name: string,
        _definition: unknown,
        callback: typeof handler,
      ) {
        if (name === "file_chattr") handler = callback;
      },
    } as never,
    async (_args, operation) =>
      withConfig(hermeticConfig(root), () => operation()),
  );
  try {
    const result = await withMutationLifecycle(
      {
        begin: async () => {
          await rename(path, join(root, "old.txt"));
          await writeFile(path, "source");
          await chmod(path, 0o644);
        },
        committed: async () => {},
        complete: async () => null,
        failed: async () => {},
        rolledBack: async () => {},
      },
      () =>
        handler!({
          files: {
            [path]: {
              expectedSha256: sha256("source"),
              chattr: { chmod: 0o600 },
            },
          },
        } as never),
    );
    expect(result).toMatchObject({ isError: true });
    expect(await Bun.file(path).text()).toBe("source");
    if (process.platform !== "win32")
      expect((await stat(path)).mode & 0o777).toBe(0o644);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("attribute cancellation after a syscall restores metadata and reports aborted", async () => {
  if (process.platform === "win32" || !process.getuid || !process.getgid)
    return;
  const root = await mkdtemp(join(tmpdir(), "ast-chattr-abort-"));
  const path = join(root, "source.txt");
  const controller = new AbortController();
  await writeFile(path, "source");
  await chmod(path, 0o640);
  let handler: ((input: never) => Promise<unknown>) | undefined;
  registerLifecycleTools(
    {
      registerTool(
        name: string,
        _definition: unknown,
        callback: typeof handler,
      ) {
        if (name === "file_chattr") handler = callback;
      },
    } as never,
    async (_args, operation) =>
      withConfig(hermeticConfig(root), () => operation(controller.signal)),
  );
  const original = attributes.applyFileChattr;
  let intercepted = false;
  const injected = spyOn(attributes, "applyFileChattr").mockImplementation(
    (filePath, chattr, beforeChange, guard) =>
      original(
        filePath,
        chattr,
        beforeChange,
        guard && {
          ...guard,
          beforeMutation: () => {
            guard.beforeMutation?.();
            if (!intercepted) {
              intercepted = true;
              controller.abort();
            }
          },
        },
      ),
  );
  try {
    const result = (await handler!({
      files: {
        [path]: {
          expectedSha256: sha256("source"),
          chattr: {
            chown: { uid: process.getuid(), gid: process.getgid() },
            chmod: 0o600,
          },
        },
      },
    } as never)) as { structuredContent: unknown };
    expect(intercepted).toBe(true);
    expect(
      toolOutputSchema.parse(result.structuredContent).error,
    ).toMatchObject({ code: "aborted" });
    expect((await stat(path)).mode & 0o777).toBe(0o640);
    expect(await Bun.file(path).text()).toBe("source");
  } finally {
    injected.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
