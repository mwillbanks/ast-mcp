const LATEST_URL = "https://registry.npmjs.org/@mwillbanks%2Fast-mcp/latest";
const VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function parsedVersion(value: string) {
  if (value.length > 128) return undefined;
  const matched = VERSION_PATTERN.exec(value);
  if (!matched) return undefined;
  const pre = matched[4]?.split(".");
  if (
    pre?.some(
      (part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith("0"),
    )
  )
    return undefined;
  return { core: matched.slice(1, 4).map(BigInt), pre };
}

export function compareVersions(
  first: string,
  second: string,
): number | undefined {
  const a = parsedVersion(first);
  const b = parsedVersion(second);
  if (!a || !b) return undefined;
  for (let index = 0; index < 3; index++) {
    if (a.core[index]! < b.core[index]!) return -1;
    if (a.core[index]! > b.core[index]!) return 1;
  }
  if (!a.pre && !b.pre) return 0;
  if (!a.pre) return 1;
  if (!b.pre) return -1;
  for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index++) {
    const left = a.pre[index];
    const right = b.pre[index];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    if (left === right) continue;
    const leftNumber = /^\d+$/.test(left);
    const rightNumber = /^\d+$/.test(right);
    if (leftNumber && rightNumber) return BigInt(left) < BigInt(right) ? -1 : 1;
    if (leftNumber !== rightNumber) return leftNumber ? -1 : 1;
    return left < right ? -1 : 1;
  }
  return 0;
}

export interface LatestVersionCheck {
  checkedAt: string;
  latestVersion: string | null;
  runningVersion: string;
  status: "current" | "outdated" | "newer" | "prerelease" | "unavailable";
  comparison?: "older" | "equal" | "newer";
  reason?:
    | "timeout"
    | "registry_unavailable"
    | "invalid_registry_response"
    | "invalid_running_version";
}

async function boundedRegistryVersion(
  response: Response,
  signal: AbortSignal,
): Promise<string> {
  if (!response.ok) throw new Error("registry_unavailable");
  if (Number(response.headers.get("content-length")) > 16_384 || !response.body)
    throw new Error("invalid_registry_response");
  const reader = response.body.getReader();
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 16_384) throw new Error("invalid_registry_response");
      chunks.push(chunk.value);
    }
  } finally {
    signal.removeEventListener("abort", abort);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("invalid_registry_response");
  }
  const version = (value as { version?: unknown } | null)?.version;
  if (
    typeof version !== "string" ||
    !parsedVersion(version) ||
    parsedVersion(version)!.pre
  )
    throw new Error("invalid_registry_response");
  return version;
}

/** Always performs a fresh unauthenticated public-registry check. */
export async function checkLatestVersion(
  runningVersion: string,
  options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<LatestVersionCheck> {
  const result: LatestVersionCheck = {
    checkedAt: new Date().toISOString(),
    latestVersion: null,
    runningVersion,
    status: "unavailable",
  };
  const controller = new AbortController();
  const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? 5000, 5000));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    const latest = await Promise.race([
      Promise.resolve().then(async () =>
        boundedRegistryVersion(
          await (options.fetch ?? globalThis.fetch)(LATEST_URL, {
            credentials: "omit",
            headers: { accept: "application/json" },
            redirect: "error",
            signal: controller.signal,
          }),
          controller.signal,
        ),
      ),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
          reject(new Error("timeout"));
        }, timeoutMs);
      }),
    ]);
    result.latestVersion = latest;
    const comparison = compareVersions(runningVersion, latest);
    if (comparison === undefined) {
      result.reason = "invalid_running_version";
      return result;
    }
    result.comparison =
      comparison < 0 ? "older" : comparison > 0 ? "newer" : "equal";
    result.status = parsedVersion(runningVersion)?.pre
      ? "prerelease"
      : comparison < 0
        ? "outdated"
        : comparison > 0
          ? "newer"
          : "current";
    return result;
  } catch (error) {
    result.reason = timedOut
      ? "timeout"
      : error instanceof Error && error.message === "invalid_registry_response"
        ? "invalid_registry_response"
        : "registry_unavailable";
    return result;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
