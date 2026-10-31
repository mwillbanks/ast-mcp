import { expect, test } from "bun:test";

import {
  launchReceipt,
  launchSettings,
  managedToolSelection,
  parseLaunchReceipt,
  removeManagedEntry,
} from "../../src/installer/ownership";

test("launch receipts restore imports while retaining later user settings", () => {
  const imported = {
    command: "old",
    args: ["old"],
    env: { KEEP: "yes" },
    tools: ["read"],
  };
  const installed = {
    command: "managed",
    args: ["mcp"],
    type: "local",
    tools: ["read"],
  };
  const receipt = launchReceipt(
    imported,
    {
      ...installed,
      env: { SECRET: "private-env" },
      headers: { Authorization: "private-header" },
    },
    undefined,
    true,
  );
  expect(JSON.stringify(receipt)).not.toContain("private-env");
  expect(JSON.stringify(receipt)).not.toContain("private-header");
  const current = { ...installed, env: { KEEP: "changed" } };
  expect(removeManagedEntry(current, receipt)).toEqual({
    command: "old",
    args: ["old"],
    tools: ["read"],
    env: { KEEP: "changed" },
  });
  expect(launchReceipt(current, installed, receipt, true).before).toEqual(
    receipt.before,
  );
  const edited = { ...current, command: "user-edited" };
  expect(removeManagedEntry(edited, receipt)).toEqual(edited);
  expect(launchReceipt(edited, installed, receipt, true).before).toMatchObject({
    command: "user-edited",
  });
});

test("new entries are removed only without user customization and historical entries stay valid", () => {
  const installed = { command: "managed", tools: ["*"] };
  const receipt = launchReceipt({}, installed, undefined, true);
  expect(removeManagedEntry(installed, receipt)).toBeUndefined();
  const customized = { ...installed, timeout: 40 };
  expect(removeManagedEntry(customized, receipt)).toEqual(customized);
  expect(removeManagedEntry(customized)).toEqual(customized);
  expect(launchSettings({ url: "http://host/mcp", env: {} })).toEqual({
    url: "http://host/mcp",
  });
  expect(
    launchReceipt(
      { url: "https://old.example/mcp" },
      { url: "https://new.example/mcp" },
    ).before,
  ).toEqual({
    url: "https://old.example/mcp",
  });
});

test("malformed launch receipts never establish ownership", () => {
  for (const value of [
    null,
    false,
    [],
    {},
    { before: [], installed: {} },
    { before: null, installed: null },
    { before: { command: 42 }, installed: { command: "managed" } },
    { before: {}, installed: { command: "managed" } },
    { before: null, installed: { command: "managed", env: {} } },
    { before: null, installed: { command: "" } },
    { before: null, installed: { command: "managed", args: [42] } },
    { before: null, installed: { command: "managed", tools: [42] } },
    { before: null, installed: { command: "managed", cwd: false } },
    { before: null, installed: { url: "url", type: 42 } },
    { before: null, installed: { command: "managed" }, extra: true },
    {
      before: null,
      installed: { command: "managed", url: "https://host/mcp" },
    },
    { before: null, installed: { command: "managed", type: "http" } },
    { before: null, installed: { url: "https://host/mcp", type: "local" } },
    { before: null, installed: { url: "https://host/mcp", args: [] } },
    { before: null, installed: { url: "https://host/mcp", cwd: "/project" } },
    { before: null, installed: { url: "file:///private" } },
    { before: null, installed: { url: "not a URL" } },
  ])
    expect(parseLaunchReceipt(value)).toBeUndefined();
  const receipt = { before: null, installed: { command: "managed" } };
  expect(parseLaunchReceipt(receipt)).toEqual(receipt);
  expect(
    parseLaunchReceipt({ before: { command: "old" }, installed: {} }),
  ).toBeUndefined();
});

test("tools edits acquire user ownership independently of unchanged launch fields", () => {
  const installed = { command: "managed", tools: ["*"] };
  const initial = launchReceipt({}, installed, undefined, true);
  const edited = { ...installed, tools: ["file_read"] };
  const updated = launchReceipt(edited, edited, initial, true);
  expect(removeManagedEntry(edited, updated)).toEqual(edited);
  const imported = launchReceipt(
    { command: "old", tools: ["old"] },
    installed,
    undefined,
    true,
  );
  const reconfigured = launchReceipt(edited, edited, imported, true);
  expect(removeManagedEntry(edited, reconfigured)).toEqual({
    command: "old",
    tools: ["file_read"],
  });
  const noTools = { command: "managed" };
  const deletedTools = launchReceipt(noTools, installed, imported, true);
  expect(removeManagedEntry(installed, deletedTools)).toEqual({
    command: "old",
  });
  const extrasOnly = launchReceipt({ timeout: 10 }, { command: "managed" });
  expect(
    removeManagedEntry({ command: "managed", timeout: 10 }, extrasOnly),
  ).toEqual({ command: "managed", timeout: 10 });
  expect(
    parseLaunchReceipt({
      before: { url: "https://old.example/mcp" },
      installed: { url: "https://new.example/mcp", type: "http" },
    }),
  ).toBeDefined();
});

test("unowned Codex tool maps do not affect launch ownership or restore deleted selections", () => {
  const custom = { file_read: { approval_mode: "approve" } };
  const installed = { command: "managed", args: ["mcp"] };
  const existing = { command: "original", tools: custom };
  const receipt = launchReceipt(existing, installed);
  expect(receipt.before).toEqual({ command: "original" });
  const current = { ...installed, tools: custom };
  expect(launchReceipt(current, installed, receipt)).toEqual(receipt);
  expect(removeManagedEntry(current, receipt)).toEqual(existing);
  expect(removeManagedEntry(installed, receipt)).toEqual({
    command: "original",
  });
});
test("direct deletion of owned user tools remains deleted during uninstall", () => {
  const installed = { command: "managed", tools: ["read"] };
  const receipt = launchReceipt(
    { command: "original", tools: ["read"] },
    installed,
    undefined,
    true,
  );
  expect(removeManagedEntry({ command: "managed" }, receipt)).toEqual({
    command: "original",
  });
});

test("tool defaults distinguish first install, existing selections, and recorded deletion", () => {
  expect(managedToolSelection({})).toEqual({ tools: ["*"] });
  expect(managedToolSelection({ tools: [] })).toEqual({ tools: [] });
  expect(managedToolSelection({ command: "original" })).toEqual({});
  expect(
    managedToolSelection({}, launchReceipt({}, { command: "managed" })),
  ).toEqual({});
});
