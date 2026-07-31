const HOST_SMOKE_PREFIX = "AST_MCP_HOST_SMOKE_";
const HOST_SMOKE_TIMEOUT = `${HOST_SMOKE_PREFIX}TIMEOUT_MS`;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 600_000;

export interface HostSmokeCheck {
  command: string[];
  expect: string[];
  name: string;
  timeoutMs: number;
}

export interface HostSmokeCommandResult {
  exitCode: number;
  output: string;
  timedOut?: boolean;
}

export type HostSmokeRunner = (
  check: HostSmokeCheck,
) => Promise<HostSmokeCommandResult>;

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function timeout(value: unknown, source: string) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_TIMEOUT_MS)
    throw new Error(
      `${source} must be an integer between 1 and ${MAX_TIMEOUT_MS}`,
    );
  return parsed;
}

function expectedMarkers(value: unknown, source: string) {
  if (value === undefined) return [];
  const values = typeof value === "string" ? [value] : value;
  if (
    !Array.isArray(values) ||
    values.length === 0 ||
    values.some((item) => typeof item !== "string" || item.length === 0)
  )
    throw new Error(
      `${source}.expect must be a non-empty string or string array`,
    );
  return values as string[];
}

function parseCheck(
  environmentName: string,
  raw: string,
  defaultTimeoutMs: number,
): HostSmokeCheck {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`${environmentName} must contain valid JSON`);
  }
  if (!record(value))
    throw new Error(`${environmentName} must contain a JSON object`);
  const unknown = Object.keys(value).filter(
    (key) => !["command", "expect", "timeoutMs"].includes(key),
  );
  if (unknown.length > 0)
    throw new Error(
      `${environmentName} contains unsupported keys: ${unknown.join(", ")}`,
    );
  if (
    !Array.isArray(value.command) ||
    value.command.length === 0 ||
    value.command.some((item) => typeof item !== "string" || item.length === 0)
  )
    throw new Error(
      `${environmentName}.command must be a non-empty string array`,
    );
  const suffix = environmentName.slice(HOST_SMOKE_PREFIX.length);
  return {
    command: value.command as string[],
    expect: expectedMarkers(value.expect, environmentName),
    name: suffix.toLowerCase().replaceAll("_", "-"),
    timeoutMs:
      value.timeoutMs === undefined
        ? defaultTimeoutMs
        : timeout(value.timeoutMs, `${environmentName}.timeoutMs`),
  };
}

export function configuredHostSmokeChecks(
  env: NodeJS.ProcessEnv = process.env,
): HostSmokeCheck[] {
  const definitions = Object.entries(env).filter(
    ([name, value]) =>
      name !== HOST_SMOKE_TIMEOUT &&
      name.startsWith(HOST_SMOKE_PREFIX) &&
      /^[A-Z0-9][A-Z0-9_]*$/.test(name.slice(HOST_SMOKE_PREFIX.length)) &&
      value !== undefined,
  );
  if (definitions.length === 0) return [];
  const defaultTimeoutMs =
    env[HOST_SMOKE_TIMEOUT] === undefined
      ? DEFAULT_TIMEOUT_MS
      : timeout(env[HOST_SMOKE_TIMEOUT], HOST_SMOKE_TIMEOUT);
  return definitions
    .map(([name, value]) => parseCheck(name, value as string, defaultTimeoutMs))
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function spawnHostSmoke(
  check: HostSmokeCheck,
): Promise<HostSmokeCommandResult> {
  const child = Bun.spawn(check.command, {
    cwd: process.cwd(),
    env: process.env,
    stderr: "pipe",
    stdin: "ignore",
    stdout: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, check.timeoutMs);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exitCode, output: `${stdout}\n${stderr}`, timedOut };
  } finally {
    clearTimeout(timer);
  }
}

export async function runHostSmokeChecks(
  checks: HostSmokeCheck[],
  runner: HostSmokeRunner = spawnHostSmoke,
): Promise<string[]> {
  await Promise.all(
    checks.map(async (check) => {
      let result: HostSmokeCommandResult;
      try {
        result = await runner(check);
      } catch (error) {
        throw new Error(
          `Host smoke "${check.name}" could not start: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (result.timedOut)
        throw new Error(
          `Host smoke "${check.name}" exceeded ${check.timeoutMs}ms`,
        );
      if (result.exitCode !== 0)
        throw new Error(
          `Host smoke "${check.name}" failed with exit code ${result.exitCode}; external output is suppressed`,
        );
      const missing = check.expect.filter(
        (marker) => !result.output.includes(marker),
      );
      if (missing.length > 0)
        throw new Error(
          `Host smoke "${check.name}" did not emit required markers: ${missing.join(", ")}`,
        );
    }),
  );
  return checks.map((check) => check.name);
}

export async function main(env: NodeJS.ProcessEnv = process.env) {
  const checks = configuredHostSmokeChecks(env);
  if (checks.length === 0) {
    console.log(
      `Host smoke checks skipped; set ${HOST_SMOKE_PREFIX}<NAME> to opt in`,
    );
    return [];
  }
  const completed = await runHostSmokeChecks(checks);
  console.log(`Host smoke checks passed: ${completed.join(", ")}`);
  return completed;
}
