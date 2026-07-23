import { expect, test } from "bun:test";
import registerLifecycleTools from "../src/tools/lifecycle";

test("registers file_rename with a keyed batch schema", () => {
  const definitions = new Map<string, unknown>();
  registerLifecycleTools({
    registerTool(name: string, definition: unknown) {
      definitions.set(name, definition);
    },
  } as never);

  const schema = (
    definitions.get("file_rename") as {
      inputSchema: { safeParse: (value: unknown) => { success: boolean } };
    }
  ).inputSchema;

  expect(
    schema.safeParse({
      "source.txt": {
        destination: "renamed.txt",
        expectedSha256: "a".repeat(64),
      },
    }).success,
  ).toBeTrue();
  expect(schema.safeParse({}).success).toBeFalse();
  expect(definitions.has("file_delete")).toBeTrue();
});
