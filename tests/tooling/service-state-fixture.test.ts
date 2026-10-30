import { expect, test } from "bun:test";

import { captureServiceState } from "../../src/installer/service-state";
import { absentServiceStateQuery } from "../support/service-state";

test("absent-manager fixture provides Linux and Darwin snapshots on every OS", async () => {
  expect(
    await captureServiceState(
      "linux",
      "ast-mcp-fixture",
      absentServiceStateQuery,
    ),
  ).toEqual({
    platform: "linux",
    loaded: false,
    enabled: false,
    active: false,
  });
  expect(
    await captureServiceState(
      "darwin",
      "ast-mcp-fixture",
      absentServiceStateQuery,
    ),
  ).toEqual({
    platform: "darwin",
    loaded: false,
    disabled: false,
    running: false,
  });
});

test("absent-manager fixture rejects mutation commands and unknown queries", async () => {
  for (const command of [
    ["systemctl", "--user", "start", "ast-mcp.service"],
    ["launchctl", "bootstrap", "gui/501", "ast-mcp.plist"],
    ["unknown-manager", "show"],
  ]) {
    await expect(absentServiceStateQuery(command)).rejects.toThrow(
      "Unexpected read-only service state query in fixture",
    );
  }
});
