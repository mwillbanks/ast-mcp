import { currentConfig } from "../config";

export async function requireExpectedHash(
  expectedSha256: string | undefined,
  operation: string,
): Promise<void> {
  if (!expectedSha256 && (await currentConfig()).safety.requireHash)
    throw new Error(
      `${operation} requires expectedSha256 while safety.require_hash is enabled`,
    );
}

export function verifyExpectedHash(
  expectedSha256: string | undefined,
  actualSha256: string,
): void {
  if (expectedSha256 && expectedSha256 !== actualSha256)
    throw new Error(
      `Stale file context: expected ${expectedSha256}, found ${actualSha256}`,
    );
}
