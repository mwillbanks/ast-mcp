import type { ServiceStateQuery } from "../../src/installer/service-state";

/** Simulate an available manager with no registered service; never execute host commands. */
export const absentServiceStateQuery: ServiceStateQuery = async (command) => {
  if (command[0] === "systemctl" && command[2] === "show")
    return {
      exitCode: 4,
      stdout: "LoadState=not-found\nActiveState=inactive\nUnitFileState=\n",
      stderr: "",
    };
  if (command[0] === "launchctl" && command[1] === "print-disabled")
    return { exitCode: 0, stdout: "disabled services = {}", stderr: "" };
  if (command[0] === "launchctl" && command[1] === "print")
    return { exitCode: 113, stdout: "", stderr: "Could not find service" };
  throw new Error("Unexpected read-only service state query in fixture");
};
