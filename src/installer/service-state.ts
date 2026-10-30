import {
  readSubprocessOutput,
  terminateProcessTree,
} from "../runtime/subprocess";

export type ServiceStateQuery = (command: string[]) => Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}>;
export type ServiceState =
  | { platform: "linux"; loaded: boolean; enabled: boolean; active: boolean }
  | {
      platform: "darwin";
      loaded: boolean;
      disabled: boolean;
      running: boolean;
    };

export async function queryServiceCommand(command: string[], timeoutMs = 5000) {
  const child = Bun.spawn(command, {
    detached: process.platform !== "win32",
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const controller = new AbortController();
  const deadline = setTimeout(
    () => controller.abort(new Error("Service state query timed out")),
    timeoutMs,
  );
  const interrupted = Promise.withResolvers<never>();
  const onAbort = () => interrupted.reject(controller.signal.reason);
  controller.signal.addEventListener("abort", onAbort, { once: true });
  try {
    const stop = () => terminateProcessTree(child, { force: true });
    const [exitCode, stdout, stderr] = await Promise.all([
      Promise.race([child.exited, interrupted.promise]),
      readSubprocessOutput(child.stdout, controller.signal, stop),
      readSubprocessOutput(child.stderr, controller.signal, stop),
    ]);
    if (child.signalCode) throw new Error("Service state query interrupted");
    return { exitCode, stdout, stderr };
  } catch (error) {
    await terminateProcessTree(child, { force: true });
    throw error;
  } finally {
    clearTimeout(deadline);
    controller.signal.removeEventListener("abort", onAbort);
  }
}

export function launchdTarget(id: string) {
  const domain = `gui/${typeof process.getuid === "function" ? process.getuid() : 501}`;
  return {
    domain,
    target: `${domain}/com.mwillbanks.${id}`,
    label: `com.mwillbanks.${id}`,
  };
}

export async function captureServiceState(
  platform: NodeJS.Platform,
  id: string,
  query: ServiceStateQuery,
): Promise<ServiceState> {
  const unknown = () =>
    new Error(
      "Cannot safely restore the observed service state; no service changes were made",
    );
  if (platform === "linux") {
    const result = await query([
      "systemctl",
      "--user",
      "show",
      "--all",
      "--property=LoadState,ActiveState,UnitFileState",
      id + ".service",
    ]);
    const lines = result.stdout.trim().split("\n");
    if (
      lines.length !== 3 ||
      lines.some(
        (line) => !/^(LoadState|ActiveState|UnitFileState)=[a-z-]*$/.test(line),
      )
    )
      throw unknown();
    const fields = Object.fromEntries(lines.map((line) => line.split("=", 2)));
    if (Object.keys(fields).length !== 3) throw unknown();
    if (
      [0, 4].includes(result.exitCode) &&
      fields.LoadState === "not-found" &&
      fields.ActiveState === "inactive" &&
      fields.UnitFileState === ""
    )
      return {
        platform: "linux",
        loaded: false,
        enabled: false,
        active: false,
      };
    if (
      result.exitCode !== 0 ||
      fields.LoadState !== "loaded" ||
      !["enabled", "disabled"].includes(fields.UnitFileState) ||
      !["active", "inactive"].includes(fields.ActiveState)
    )
      throw unknown();
    return {
      platform: "linux",
      loaded: true,
      enabled: fields.UnitFileState === "enabled",
      active: fields.ActiveState === "active",
    };
  }
  const { domain, target, label } = launchdTarget(id);
  const disabled = await query(["launchctl", "print-disabled", domain]);
  if (
    disabled.exitCode !== 0 ||
    !/^disabled services = \{[\s\S]*\}\s*$/.test(disabled.stdout.trim())
  )
    throw unknown();
  const overridePattern = /"([^"]+)"\s*=>\s*(true|false|enabled|disabled)/g;
  const body = disabled.stdout
    .trim()
    .replace(/^disabled services = \{/, "")
    .replace(/\}\s*$/, "");
  const overrides = [...body.matchAll(overridePattern)];
  if (body.replace(overridePattern, "").trim()) throw unknown();
  const entries = overrides.filter((match) => match[1] === label);
  if (entries.length > 1) throw unknown();
  const isDisabled = ["true", "disabled"].includes(entries[0]?.[2] ?? "false");
  const job = await query(["launchctl", "print", target]);
  if (job.exitCode !== 0) {
    if (
      job.exitCode !== 113 ||
      !/Could not find (?:specified )?service/i.test(job.stderr)
    )
      throw unknown();
    return {
      platform: "darwin",
      loaded: false,
      running: false,
      disabled: isDisabled,
    };
  }
  // bootstrap can launch RunAtLoad/KeepAlive jobs. A loaded stopped job cannot be safely reconstructed.
  if (!/^\s*state = running\s*$/m.test(job.stdout) || isDisabled)
    throw unknown();
  return { platform: "darwin", loaded: true, running: true, disabled: false };
}
